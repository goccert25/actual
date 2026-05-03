import { q } from '#shared/query';
import type { Query } from '#shared/query';
import type { TransactionEntity } from '#types/models';
import type { AutomationsRunRequest } from '#types/automations';
import {
  AutomationPlanBuilder,
  type Automation,
  type AutomationContext,
  type AutomationOperation,
  type AutomationOperationPreview,
  type AutomationPreviewField,
  type AutomationPreviewTableRow,
  type AutomationRunOptions,
  type AutomationRunResult,
  type AutomationTransactionFilter,
  type AutomationTransactionPreview,
} from '#types/automations';

import { createApp } from './app';
import { aqlQuery } from './aql';
import * as db from './db';
import { categoryModel, payeeModel } from './models';
import { mutator } from './mutators';
import { batchUpdateTransactions } from './transactions';
import { withUndo } from './undo';

export type AutomationsHandlers = {
  'automations-get': typeof getAutomations;
  'automations-run': typeof runNamedAutomationHandler;
};

type TableTransaction = Pick<
  AutomationTransactionPreview,
  'id' | 'account' | 'amount' | 'category' | 'date' | 'notes' | 'payee' | 'transfer_id'
>;
const PEOPLE = ['George', 'Helen'] as const;
const MATCH_WINDOW_DAYS = 10;
const WEALTHFRONT_ACCOUNT_KEYWORD = 'Wealthfront';
const VENMO_ACCOUNT_KEYWORD = 'Venmo';
const WEALTHFRONT_PAYEE_PREFIXES = [
  'Transfer to Venmo',
  'Venmo-Payment',
] as const;

export const wealthfrontVenmoCleanupAutomation = defineAutomation({
  name: 'Wealthfront Venmo cleanup',
  description:
    'Deduplicate matching Wealthfront and Venmo transactions for George and Helen and carry Venmo notes onto the Wealthfront side.',
  version: '1',
  async plan(ctx) {
    const plan = ctx.createPlan('Wealthfront Venmo cleanup');
    const payeesById = new Map(ctx.payees.map(payee => [payee.id, payee]));

    for (const person of PEOPLE) {
      const wealthfrontAccounts = findAccountsContaining(ctx.accounts, [
        person,
        WEALTHFRONT_ACCOUNT_KEYWORD,
      ]);
      const venmoAccounts = findAccountsContaining(ctx.accounts, [
        person,
        VENMO_ACCOUNT_KEYWORD,
      ]);

      if (wealthfrontAccounts.length === 0 || venmoAccounts.length === 0) {
        plan.skip(
          `Could not find both Wealthfront and Venmo accounts for ${person}`,
          undefined,
          {
            person,
            wealthfrontAccounts: wealthfrontAccounts.length,
            venmoAccounts: venmoAccounts.length,
          },
        );
        continue;
      }

      const [wealthfrontTransactions, venmoTransactions] = await Promise.all([
        ctx.queryTransactions({
          accountIds: wealthfrontAccounts.map(account => account.id),
          splits: 'none',
        }),
        ctx.queryTransactions({
          accountIds: venmoAccounts.map(account => account.id),
          splits: 'none',
        }),
      ]);

      const availableVenmoTransactions = venmoTransactions.filter(
        transaction => !transaction.reconciled,
      );
      const matchedVenmoTransactionIds = new Set<TransactionEntity['id']>();

      for (const wealthfrontTransaction of wealthfrontTransactions) {
        if (
          !isWealthfrontVenmoTransaction(wealthfrontTransaction, payeesById)
        ) {
          continue;
        }

        if (wealthfrontTransaction.reconciled) {
          plan.skip(
            'Wealthfront transaction is reconciled',
            wealthfrontTransaction.id,
            { person },
          );
          continue;
        }

        const matches = availableVenmoTransactions.filter(venmoTransaction => {
          return (
            !matchedVenmoTransactionIds.has(venmoTransaction.id) &&
            venmoTransaction.amount === wealthfrontTransaction.amount &&
            ctx.isWithinDays(
              venmoTransaction.date,
              wealthfrontTransaction.date,
              MATCH_WINDOW_DAYS,
            )
          );
        });

        if (matches.length !== 1) {
          plan.skip(
            `Expected exactly one matching Venmo transaction, found ${matches.length}`,
            wealthfrontTransaction.id,
            {
              person,
              amount: wealthfrontTransaction.amount,
              matchWindowDays: MATCH_WINDOW_DAYS,
            },
          );
          continue;
        }

        const [venmoTransaction] = matches;
        matchedVenmoTransactionIds.add(venmoTransaction.id);

        const mergedNotes = mergeNotes(
          wealthfrontTransaction.notes,
          venmoTransaction.notes,
        );

        if (mergedNotes !== normalizeNotes(wealthfrontTransaction.notes)) {
          plan.updateTransaction(
            wealthfrontTransaction.id,
            { notes: mergedNotes },
            'Copy notes from matching Venmo transaction',
            {
              person,
              venmoTransactionId: venmoTransaction.id,
            },
          );
        }

        plan.deleteTransaction(
          venmoTransaction.id,
          'Remove Venmo duplicate after copying notes',
          {
            person,
            wealthfrontTransactionId: wealthfrontTransaction.id,
          },
        );
      }
    }

    return plan;
  },
});

export const availableAutomations = [
  wealthfrontVenmoCleanupAutomation,
] satisfies Automation[];

export const app = createApp<AutomationsHandlers>();

app.method('automations-get', getAutomations);
app.method('automations-run', mutator(runNamedAutomationHandler));

export function defineAutomation(automation: Automation): Automation {
  return automation;
}

export async function getAutomations() {
  return {
    automations: availableAutomations.map(automation => ({
      name: automation.name,
      description: automation.description ?? undefined,
      version: automation.version ?? undefined,
    })),
  };
}

export async function runNamedAutomationHandler({
  dryRun = true,
  name,
}: AutomationsRunRequest) {
  const automation = findAutomation(name);

  if (!automation) {
    throw new Error(`Unknown automation "${name}"`);
  }

  if (dryRun) {
    return runAutomation(automation, { dryRun: true });
  }

  return withUndo(
    () => runAutomation(automation, { dryRun: false }),
    { type: 'automation', name: automation.name },
  );
}

export async function createAutomationContext(): Promise<AutomationContext> {
  const [accounts, categories, payees] = await Promise.all([
    db.getAccounts().then(dbAccounts =>
      dbAccounts.map(account => ({
        id: account.id,
        name: account.name,
        offbudget: account.offbudget === 1,
        closed: account.closed === 1,
        balance_current: account.balance_current ?? null,
      })),
    ),
    db.getCategories().then(dbCategories =>
      dbCategories.map(category => {
        const categoryEntity = categoryModel.fromDb(category);
        return {
          id: categoryEntity.id,
          name: categoryEntity.name,
          is_income: categoryEntity.is_income,
          hidden: categoryEntity.hidden,
          group_id: categoryEntity.group,
        };
      }),
    ),
    db.getPayees().then(dbPayees =>
      dbPayees.map(payee => {
        const payeeEntity = payeeModel.fromDb(payee);
        return {
          id: payeeEntity.id,
          name: payeeEntity.name,
          transfer_acct: payeeEntity.transfer_acct,
        };
      }),
    ),
  ]);

  function accountByName(name: string) {
    return accounts.find(account => account.name === name);
  }

  function accountsByNamePrefix(prefix: string) {
    return accounts.filter(account => account.name.startsWith(prefix));
  }

  function categoryByName(name: string) {
    return categories.find(category => category.name === name);
  }

  function payeeByName(name: string) {
    return payees.find(payee => payee.name === name);
  }

  function transferPayeeForAccount(accountId: string) {
    return payees.find(payee => payee.transfer_acct === accountId);
  }

  async function query<T>(queryToRun: Query) {
    const result = (await aqlQuery(queryToRun)) as { data: T[] };
    return result.data;
  }

  async function queryTransactions(
    filter: AutomationTransactionFilter = {},
  ): Promise<TransactionEntity[]> {
    let queryToRun = q('transactions')
      .select('*')
      .options({ splits: filter.splits ?? 'grouped' });

    if (filter.includeDeleted) {
      queryToRun = queryToRun.withDead();
    }

    const accountIds = [
      ...(filter.accountIds ?? []),
      ...(filter.accountNames ?? [])
        .map(name => accountByName(name)?.id)
        .filter((id): id is string => Boolean(id)),
      ...(filter.accountNameStartsWith
        ? accountsByNamePrefix(filter.accountNameStartsWith).map(
            account => account.id,
          )
        : []),
    ];
    const uniqueAccountIds = [...new Set(accountIds)];

    const payeeIds = [
      ...(filter.payeeIds ?? []),
      ...(filter.payeeNames ?? [])
        .map(name => payeeByName(name)?.id)
        .filter((id): id is string => Boolean(id)),
    ];
    const uniquePayeeIds = [...new Set(payeeIds)];

    const expressions: Array<Record<string, string | number | object>> = [];

    if (uniqueAccountIds.length === 1) {
      expressions.push({ account: uniqueAccountIds[0] });
    } else if (uniqueAccountIds.length > 1) {
      expressions.push({ account: { $oneof: uniqueAccountIds } });
    }

    if (uniquePayeeIds.length === 1) {
      expressions.push({ payee: uniquePayeeIds[0] });
    } else if (uniquePayeeIds.length > 1) {
      expressions.push({ payee: { $oneof: uniquePayeeIds } });
    }

    if (filter.startDate) {
      expressions.push({ date: { $gte: filter.startDate } });
    }

    if (filter.endDate) {
      expressions.push({ date: { $lte: filter.endDate } });
    }

    if (typeof filter.amount === 'number') {
      expressions.push({ amount: filter.amount });
    }

    if (typeof filter.minAmount === 'number') {
      expressions.push({ amount: { $gte: filter.minAmount } });
    }

    if (typeof filter.maxAmount === 'number') {
      expressions.push({ amount: { $lte: filter.maxAmount } });
    }

    if (expressions.length > 0) {
      queryToRun = queryToRun.filter({ $and: expressions });
    }

    let transactions = await query<TransactionEntity>(queryToRun);

    if (filter.notesContains) {
      const search = filter.notesContains.toLowerCase();
      transactions = transactions.filter(transaction =>
        (transaction.notes ?? '').toLowerCase().includes(search),
      );
    }

    if (filter.importedPayeeContains) {
      const search = filter.importedPayeeContains.toLowerCase();
      transactions = transactions.filter(transaction =>
        (transaction.imported_payee ?? '').toLowerCase().includes(search),
      );
    }

    return transactions;
  }

  return {
    accounts,
    categories,
    payees,
    accountByName,
    accountsByNamePrefix,
    categoryByName,
    payeeByName,
    transferPayeeForAccount,
    query,
    queryTransactions,
    createPlan: name => new AutomationPlanBuilder(name),
    daysBetween,
    isWithinDays: (leftDate, rightDate, days) =>
      daysBetween(leftDate, rightDate) <= days,
  };
}

export async function runAutomation(
  automation: Automation,
  options: AutomationRunOptions = {},
): Promise<AutomationRunResult> {
  const dryRun = options.dryRun ?? true;
  const context = await createAutomationContext();
  const planned = await automation.plan(context);
  const plan =
    planned instanceof AutomationPlanBuilder ? planned.toPlan() : planned;
  const normalizedPlan = {
    ...plan,
    name: plan.name ?? automation.name,
  };
  const previews = await previewOperations(normalizedPlan.operations, context, {
    allowDeletingLinkedTransfers:
      options.allowDeletingLinkedTransfers ?? false,
    allowReconciledTransactions: options.allowReconciledTransactions ?? false,
  });
  const hasErrors = previews.some(preview => preview.status === 'error');
  const applied = !dryRun && !hasErrors;

  if (applied) {
    await applyOperations(normalizedPlan.operations, context, {
      runTransfers: options.runTransfers ?? false,
    });
  }

  return {
    automationName: automation.name,
    dryRun,
    applied,
    plan: normalizedPlan,
    previews,
    tableRows: buildPreviewTableRows(previews, context),
    summary: summarize(normalizedPlan.operations, previews),
  };
}

function findAutomation(name: string) {
  const normalizedName = normalizeAutomationName(name);
  return availableAutomations.find(automation => {
    return normalizeAutomationName(automation.name) === normalizedName;
  });
}

function normalizeAutomationName(name: string) {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

async function previewOperations(
  operations: AutomationOperation[],
  context: AutomationContext,
  options: Required<
    Pick<
      AutomationRunOptions,
      'allowDeletingLinkedTransfers' | 'allowReconciledTransactions'
    >
  >,
): Promise<AutomationOperationPreview[]> {
  const transactionsById = await getTransactionsById(
    collectTransactionIds(operations),
    context,
  );
  const touchedIds = new Set<TransactionEntity['id']>();

  return operations.map(operation => {
    if (operation.type === 'skip') {
      const before =
        operation.id && transactionsById.has(operation.id)
          ? [getKnownTransaction(transactionsById, operation.id)]
          : undefined;
      return { operation, status: 'skipped', before };
    }

    const ids = getOperationTransactionIds(operation);
    const before = ids
      .map(id => transactionsById.get(id))
      .filter((transaction): transaction is TransactionEntity =>
        Boolean(transaction),
      );

    const duplicateId = ids.find(id => touchedIds.has(id));
    if (duplicateId) {
      return {
        operation,
        status: 'error',
        error: `Transaction ${duplicateId} is changed by more than one operation`,
        before,
      };
    }
    ids.forEach(id => touchedIds.add(id));

    const missingId = ids.find(id => !transactionsById.has(id));
    if (missingId) {
      return {
        operation,
        status: 'error',
        error: `Transaction ${missingId} does not exist`,
        before,
      };
    }

    const reconciledId = ids.find(
      id => transactionsById.get(id)?.reconciled === true,
    );
    if (reconciledId && !options.allowReconciledTransactions) {
      return {
        operation,
        status: 'error',
        error: `Transaction ${reconciledId} is reconciled`,
        before,
      };
    }

    if (operation.type === 'delete-transaction') {
      const transaction = getKnownTransaction(transactionsById, operation.id);
      if (transaction.transfer_id && !options.allowDeletingLinkedTransfers) {
        return {
          operation,
          status: 'error',
          error: `Transaction ${operation.id} is linked to a transfer`,
          before: [transaction],
        };
      }

      return { operation, status: 'ready', before: [transaction] };
    }

    if (operation.type === 'update-transaction') {
      const transaction = getKnownTransaction(transactionsById, operation.id);
      return {
        operation,
        status: 'ready',
        before: [transaction],
        after: [{ ...transaction, ...operation.fields }],
      };
    }

    const fromTransaction = getKnownTransaction(
      transactionsById,
      operation.fromId,
    );
    const toTransaction = getKnownTransaction(transactionsById, operation.toId);
    const fromTransferPayee = context.transferPayeeForAccount(
      fromTransaction.account,
    );
    const toTransferPayee = context.transferPayeeForAccount(
      toTransaction.account,
    );

    if (!fromTransferPayee || !toTransferPayee) {
      return {
        operation,
        status: 'error',
        error: 'A transfer payee is missing for one of the linked accounts',
        before: [fromTransaction, toTransaction],
      };
    }

    if (
      (fromTransaction.transfer_id &&
        fromTransaction.transfer_id !== toTransaction.id) ||
      (toTransaction.transfer_id &&
        toTransaction.transfer_id !== fromTransaction.id)
    ) {
      return {
        operation,
        status: 'error',
        error: 'One of the transactions is already linked to another transfer',
        before: [fromTransaction, toTransaction],
      };
    }

    return {
      operation,
      status: 'ready',
      before: [fromTransaction, toTransaction],
      after: [
        applyTransferFields(fromTransaction, toTransaction, toTransferPayee.id),
        applyTransferFields(
          toTransaction,
          fromTransaction,
          fromTransferPayee.id,
        ),
      ],
    };
  });
}

async function applyOperations(
  operations: AutomationOperation[],
  context: AutomationContext,
  options: Required<Pick<AutomationRunOptions, 'runTransfers'>>,
) {
  const transactionsById = await getTransactionsById(
    collectTransactionIds(operations),
    context,
  );
  const updated: Partial<TransactionEntity>[] = [];
  const deleted: Array<Pick<TransactionEntity, 'id'>> = [];

  for (const operation of operations) {
    switch (operation.type) {
      case 'update-transaction':
        updated.push({
          id: operation.id,
          ...operation.fields,
        } as Partial<TransactionEntity>);
        break;
      case 'delete-transaction':
        deleted.push({ id: operation.id });
        break;
      case 'link-transfer': {
        const fromTransaction = getKnownTransaction(
          transactionsById,
          operation.fromId,
        );
        const toTransaction = getKnownTransaction(
          transactionsById,
          operation.toId,
        );
        const fromTransferPayee = getTransferPayeeForAccount(
          context,
          fromTransaction.account,
        );
        const toTransferPayee = getTransferPayeeForAccount(
          context,
          toTransaction.account,
        );

        updated.push({
          id: fromTransaction.id,
          category: null,
          payee: toTransferPayee.id,
          transfer_id: toTransaction.id,
        } as unknown as Partial<TransactionEntity>);
        updated.push({
          id: toTransaction.id,
          category: null,
          payee: fromTransferPayee.id,
          transfer_id: fromTransaction.id,
        } as unknown as Partial<TransactionEntity>);
        break;
      }
      case 'skip':
        break;
      default:
        assertNever(operation);
    }
  }

  await batchUpdateTransactions({
    updated,
    deleted,
    runTransfers: options.runTransfers,
  });
}

function summarize(
  operations: AutomationOperation[],
  previews: AutomationOperationPreview[],
): AutomationRunResult['summary'] {
  return {
    updates: operations.filter(
      operation => operation.type === 'update-transaction',
    ).length,
    deletes: operations.filter(
      operation => operation.type === 'delete-transaction',
    ).length,
    transferLinks: operations.filter(
      operation => operation.type === 'link-transfer',
    ).length,
    skips: operations.filter(operation => operation.type === 'skip').length,
    errors: previews.filter(preview => preview.status === 'error').length,
  };
}

async function getTransactionsById(
  ids: TransactionEntity['id'][],
  context: AutomationContext,
) {
  if (ids.length === 0) {
    return new Map<TransactionEntity['id'], TransactionEntity>();
  }

  const transactions = await context.query<TransactionEntity>(
    q('transactions')
      .filter({ id: { $oneof: ids } })
      .select('*')
      .options({ splits: 'none' }),
  );

  return new Map(
    transactions.map(transaction => [transaction.id, transaction]),
  );
}

function getKnownTransaction(
  transactionsById: Map<TransactionEntity['id'], TransactionEntity>,
  id: TransactionEntity['id'],
) {
  const transaction = transactionsById.get(id);
  if (!transaction) {
    throw new Error(`Transaction ${id} does not exist`);
  }
  return transaction;
}

function getTransferPayeeForAccount(
  context: AutomationContext,
  accountId: string,
) {
  const payee = context.transferPayeeForAccount(accountId);
  if (!payee) {
    throw new Error(`Transfer payee for account ${accountId} does not exist`);
  }
  return payee;
}

function collectTransactionIds(operations: AutomationOperation[]) {
  return [
    ...new Set(
      operations.flatMap(operation => getOperationTransactionIds(operation)),
    ),
  ];
}

function getOperationTransactionIds(operation: AutomationOperation) {
  switch (operation.type) {
    case 'update-transaction':
    case 'delete-transaction':
      return [operation.id];
    case 'link-transfer':
      return [operation.fromId, operation.toId];
    case 'skip':
      return operation.id ? [operation.id] : [];
    default:
      assertNever(operation);
  }
}

function applyTransferFields(
  transaction: TransactionEntity,
  linkedTransaction: TransactionEntity,
  transferPayeeId: string,
): AutomationTransactionPreview {
  return {
    ...transaction,
    category: null,
    payee: transferPayeeId,
    transfer_id: linkedTransaction.id,
  };
}

function buildPreviewTableRows(
  previews: AutomationOperationPreview[],
  context: AutomationContext,
) {
  const rows = previews.flatMap((preview, index) =>
    buildRowsForPreview(preview, index, context),
  );

  rows.sort((left, right) => {
    const leftDate = left.date ?? '';
    const rightDate = right.date ?? '';

    if (leftDate !== rightDate) {
      return rightDate.localeCompare(leftDate);
    }

    if (left.groupId !== right.groupId) {
      return left.groupId.localeCompare(right.groupId);
    }

    return compareRowRole(left.rowRole) - compareRowRole(right.rowRole);
  });

  return rows;
}

function buildRowsForPreview(
  preview: AutomationOperationPreview,
  index: number,
  context: AutomationContext,
): AutomationPreviewTableRow[] {
  const groupId = `operation-${String(index).padStart(4, '0')}`;
  const reason = preview.error ?? preview.operation.reason;

  if (preview.status === 'skipped') {
    return buildRowsFromTransactions({
      changedFields: [],
      context,
      error: preview.error,
      groupId,
      operationType: preview.operation.type,
      reason,
      rowRole: 'current',
      status: preview.status,
      transactions: preview.before ?? [],
    });
  }

  if (preview.status === 'error') {
    return buildRowsFromTransactions({
      changedFields: [],
      context,
      error: preview.error,
      groupId,
      operationType: preview.operation.type,
      reason,
      rowRole: 'current',
      status: preview.status,
      transactions: preview.before ?? [],
    });
  }

  switch (preview.operation.type) {
    case 'update-transaction': {
      const before = preview.before?.[0];
      const after = preview.after?.[0];
      const changedFields =
        before && after ? getChangedFields(before, after, context) : [];

      return [
        ...buildRowsFromTransactions({
          changedFields,
          context,
          groupId,
          operationType: preview.operation.type,
          reason,
          rowRole: 'before',
          status: preview.status,
          transactions: before ? [before] : [],
        }),
        ...buildRowsFromTransactions({
          changedFields,
          context,
          groupId,
          operationType: preview.operation.type,
          reason,
          rowRole: 'after',
          status: preview.status,
          transactions: after ? [after] : [],
        }),
      ];
    }
    case 'delete-transaction':
      return buildRowsFromTransactions({
        changedFields: [],
        context,
        groupId,
        operationType: preview.operation.type,
        reason,
        rowRole: 'current',
        status: preview.status,
        transactions: preview.before ?? [],
      });
    case 'link-transfer': {
      const before = preview.before ?? [];
      const after = preview.after ?? [];

      return [
        ...buildRowsFromTransactions({
          changedFields:
            before[0] && after[0]
              ? getChangedFields(before[0], after[0], context)
              : [],
          context,
          groupId,
          operationType: preview.operation.type,
          reason,
          rowRole: 'before',
          status: preview.status,
          transactions: before[0] ? [before[0]] : [],
          transferSide: 'from',
        }),
        ...buildRowsFromTransactions({
          changedFields:
            before[0] && after[0]
              ? getChangedFields(before[0], after[0], context)
              : [],
          context,
          groupId,
          operationType: preview.operation.type,
          reason,
          rowRole: 'after',
          status: preview.status,
          transactions: after[0] ? [after[0]] : [],
          transferSide: 'from',
        }),
        ...buildRowsFromTransactions({
          changedFields:
            before[1] && after[1]
              ? getChangedFields(before[1], after[1], context)
              : [],
          context,
          groupId,
          operationType: preview.operation.type,
          reason,
          rowRole: 'before',
          status: preview.status,
          transactions: before[1] ? [before[1]] : [],
          transferSide: 'to',
        }),
        ...buildRowsFromTransactions({
          changedFields:
            before[1] && after[1]
              ? getChangedFields(before[1], after[1], context)
              : [],
          context,
          groupId,
          operationType: preview.operation.type,
          reason,
          rowRole: 'after',
          status: preview.status,
          transactions: after[1] ? [after[1]] : [],
          transferSide: 'to',
        }),
      ];
    }
    case 'skip':
      return [];
    default:
      assertNever(preview.operation);
  }
}

function buildRowsFromTransactions({
  changedFields,
  context,
  error,
  groupId,
  operationType,
  reason,
  rowRole,
  status,
  transactions,
  transferSide,
}: {
  changedFields: AutomationPreviewField[];
  context: AutomationContext;
  error?: string;
  groupId: string;
  operationType: AutomationOperation['type'];
  reason: string;
  rowRole: AutomationPreviewTableRow['rowRole'];
  status: AutomationOperationPreview['status'];
  transactions: TableTransaction[];
  transferSide?: AutomationPreviewTableRow['transferSide'];
}) {
  if (transactions.length === 0) {
    return [
      {
        id: `${groupId}-${rowRole}-${operationType}`,
        groupId,
        operationType,
        rowRole,
        status,
        transferSide,
        reason,
        error,
        changedFields,
      },
    ];
  }

  return transactions.map(transaction => {
    const display = toDisplayTransaction(transaction, context);

    return {
      id: `${groupId}-${rowRole}-${transaction.id}`,
      groupId,
      operationType,
      rowRole,
      status,
      transferSide,
      transactionId: transaction.id,
      date: display.date,
      accountName: display.accountName,
      payeeName: display.payeeName,
      categoryName: display.categoryName,
      notes: display.notes,
      paymentAmount: display.paymentAmount,
      depositAmount: display.depositAmount,
      reason,
      error,
      changedFields,
    } satisfies AutomationPreviewTableRow;
  });
}

function toDisplayTransaction(
  transaction: TableTransaction,
  context: AutomationContext,
) {
  const accountName =
    context.accounts.find(account => account.id === transaction.account)?.name ??
    null;
  const categoryName =
    context.categories.find(category => category.id === transaction.category)
      ?.name ?? null;
  const payeeName =
    context.payees.find(payee => payee.id === transaction.payee)?.name ?? null;

  return {
    date: transaction.date,
    accountName,
    payeeName,
    categoryName,
    notes: transaction.notes ?? null,
    paymentAmount: transaction.amount < 0 ? Math.abs(transaction.amount) : null,
    depositAmount: transaction.amount > 0 ? transaction.amount : null,
  };
}

function getChangedFields(
  before: TableTransaction,
  after: TableTransaction,
  context: AutomationContext,
) {
  const beforeDisplay = toDisplayTransaction(before, context);
  const afterDisplay = toDisplayTransaction(after, context);
  const changedFields: AutomationPreviewField[] = [];

  if (beforeDisplay.date !== afterDisplay.date) {
    changedFields.push('date');
  }
  if (beforeDisplay.accountName !== afterDisplay.accountName) {
    changedFields.push('accountName');
  }
  if (beforeDisplay.payeeName !== afterDisplay.payeeName) {
    changedFields.push('payeeName');
  }
  if (beforeDisplay.categoryName !== afterDisplay.categoryName) {
    changedFields.push('categoryName');
  }
  if (beforeDisplay.notes !== afterDisplay.notes) {
    changedFields.push('notes');
  }
  if (beforeDisplay.paymentAmount !== afterDisplay.paymentAmount) {
    changedFields.push('paymentAmount');
  }
  if (beforeDisplay.depositAmount !== afterDisplay.depositAmount) {
    changedFields.push('depositAmount');
  }

  return changedFields;
}

function compareRowRole(rowRole: AutomationPreviewTableRow['rowRole']) {
  switch (rowRole) {
    case 'before':
      return 0;
    case 'after':
      return 1;
    case 'current':
      return 2;
    default:
      return 3;
  }
}

function findAccountsContaining(
  accounts: AutomationContext['accounts'],
  keywords: string[],
) {
  return accounts.filter(account => {
    const accountName = account.name.toLowerCase();
    return keywords.every(keyword =>
      accountName.includes(keyword.toLowerCase()),
    );
  });
}

function isWealthfrontVenmoTransaction(
  transaction: TransactionEntity,
  payeesById: Map<string, AutomationContext['payees'][number]>,
) {
  if (!transaction.payee) {
    return false;
  }

  const payee = payeesById.get(transaction.payee);
  if (!payee) {
    return false;
  }

  return WEALTHFRONT_PAYEE_PREFIXES.some(prefix =>
    payee.name.toLowerCase().startsWith(prefix.toLowerCase()),
  );
}

function mergeNotes(
  wealthfrontNotes: TransactionEntity['notes'] | null,
  venmoNotes: TransactionEntity['notes'] | null,
) {
  const existingNotes = normalizeNotes(wealthfrontNotes);
  const notesToAdd = normalizeNotes(venmoNotes);

  if (!notesToAdd) {
    return existingNotes;
  }

  if (!existingNotes) {
    return notesToAdd;
  }

  if (existingNotes.includes(notesToAdd)) {
    return existingNotes;
  }

  return `${existingNotes}\n${notesToAdd}`;
}

function normalizeNotes(notes: TransactionEntity['notes'] | null) {
  return (notes ?? '').trim();
}

function daysBetween(leftDate: string, rightDate: string) {
  const dayMilliseconds = 24 * 60 * 60 * 1000;
  return Math.abs(dateToUtc(leftDate) - dateToUtc(rightDate)) / dayMilliseconds;
}

function dateToUtc(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected operation: ${JSON.stringify(value)}`);
}
