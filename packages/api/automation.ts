import { q } from '@actual-app/core/shared/query';
import type { Query } from '@actual-app/core/shared/query';
import type { TransactionEntity } from '@actual-app/core/types/models';

import {
  aqlQuery,
  batchUpdateTransactions,
  getAccounts,
  getPayees,
} from './methods';
import type { APIAccountEntity, APIPayeeEntity } from './models';

type MetadataValue = string | number | boolean | null;

type QueryResult<T> = {
  data: T[];
};

export type AutomationTransactionUpdateFields = {
  category?: TransactionEntity['category'] | null;
  payee?: TransactionEntity['payee'] | null;
  notes?: TransactionEntity['notes'];
  cleared?: TransactionEntity['cleared'];
  reconciled?: TransactionEntity['reconciled'];
  schedule?: TransactionEntity['schedule'] | null;
  transfer_id?: TransactionEntity['transfer_id'] | null;
};

export type AutomationTransactionFilter = {
  accountIds?: Array<APIAccountEntity['id']>;
  accountNames?: Array<APIAccountEntity['name']>;
  accountNameStartsWith?: string;
  payeeIds?: Array<APIPayeeEntity['id']>;
  payeeNames?: Array<APIPayeeEntity['name']>;
  startDate?: string;
  endDate?: string;
  amount?: TransactionEntity['amount'];
  minAmount?: TransactionEntity['amount'];
  maxAmount?: TransactionEntity['amount'];
  notesContains?: string;
  importedPayeeContains?: string;
  includeDeleted?: boolean;
  splits?: 'grouped' | 'none';
};

export type AutomationOperation =
  | {
      type: 'update-transaction';
      id: TransactionEntity['id'];
      fields: AutomationTransactionUpdateFields;
      reason: string;
      metadata?: Record<string, MetadataValue>;
    }
  | {
      type: 'delete-transaction';
      id: TransactionEntity['id'];
      reason: string;
      metadata?: Record<string, MetadataValue>;
    }
  | {
      type: 'link-transfer';
      fromId: TransactionEntity['id'];
      toId: TransactionEntity['id'];
      reason: string;
      metadata?: Record<string, MetadataValue>;
    }
  | {
      type: 'skip';
      id?: TransactionEntity['id'];
      reason: string;
      metadata?: Record<string, MetadataValue>;
    };

export type AutomationPlan = {
  name?: string;
  operations: AutomationOperation[];
};

export type Automation = {
  name: string;
  version?: string;
  plan: (
    context: AutomationContext,
  ) =>
    | AutomationPlan
    | AutomationPlanBuilder
    | Promise<AutomationPlan | AutomationPlanBuilder>;
};

export type AutomationContext = {
  accounts: APIAccountEntity[];
  payees: APIPayeeEntity[];
  accountByName: (
    name: APIAccountEntity['name'],
  ) => APIAccountEntity | undefined;
  accountsByNamePrefix: (prefix: string) => APIAccountEntity[];
  payeeByName: (name: APIPayeeEntity['name']) => APIPayeeEntity | undefined;
  transferPayeeForAccount: (
    accountId: APIAccountEntity['id'],
  ) => APIPayeeEntity | undefined;
  query: <T>(query: Query) => Promise<T[]>;
  queryTransactions: (
    filter?: AutomationTransactionFilter,
  ) => Promise<TransactionEntity[]>;
  createPlan: (name?: string) => AutomationPlanBuilder;
  daysBetween: (leftDate: string, rightDate: string) => number;
  isWithinDays: (leftDate: string, rightDate: string, days: number) => boolean;
};

export type AutomationRunOptions = {
  dryRun?: boolean;
  allowReconciledTransactions?: boolean;
  allowDeletingLinkedTransfers?: boolean;
  runTransfers?: boolean;
};

export type AutomationTransactionPreview = Omit<
  TransactionEntity,
  'category' | 'payee' | 'schedule' | 'transfer_id'
> & {
  category?: TransactionEntity['category'] | null;
  payee?: TransactionEntity['payee'] | null;
  schedule?: TransactionEntity['schedule'] | null;
  transfer_id?: TransactionEntity['transfer_id'] | null;
};

export type AutomationOperationPreview = {
  operation: AutomationOperation;
  status: 'ready' | 'skipped' | 'error';
  error?: string;
  before?: TransactionEntity[];
  after?: AutomationTransactionPreview[];
};

export type AutomationRunResult = {
  automationName: string;
  dryRun: boolean;
  applied: boolean;
  plan: AutomationPlan;
  previews: AutomationOperationPreview[];
  summary: {
    updates: number;
    deletes: number;
    transferLinks: number;
    skips: number;
    errors: number;
  };
};

type MutableTransactionUpdate = AutomationTransactionUpdateFields & {
  id: TransactionEntity['id'];
};

export class AutomationPlanBuilder {
  readonly name?: string;
  readonly operations: AutomationOperation[] = [];

  constructor(name?: string) {
    this.name = name;
  }

  updateTransaction(
    id: TransactionEntity['id'],
    fields: AutomationTransactionUpdateFields,
    reason: string,
    metadata?: Record<string, MetadataValue>,
  ) {
    this.operations.push({
      type: 'update-transaction',
      id,
      fields,
      reason,
      metadata,
    });
  }

  deleteTransaction(
    id: TransactionEntity['id'],
    reason: string,
    metadata?: Record<string, MetadataValue>,
  ) {
    this.operations.push({ type: 'delete-transaction', id, reason, metadata });
  }

  linkTransfer(
    fromId: TransactionEntity['id'],
    toId: TransactionEntity['id'],
    reason: string,
    metadata?: Record<string, MetadataValue>,
  ) {
    this.operations.push({
      type: 'link-transfer',
      fromId,
      toId,
      reason,
      metadata,
    });
  }

  skip(
    reason: string,
    id?: TransactionEntity['id'],
    metadata?: Record<string, MetadataValue>,
  ) {
    this.operations.push({ type: 'skip', id, reason, metadata });
  }

  toPlan(): AutomationPlan {
    return {
      name: this.name,
      operations: [...this.operations],
    };
  }
}

export function defineAutomation(automation: Automation): Automation {
  return automation;
}

export async function createAutomationContext(): Promise<AutomationContext> {
  const [accounts, payees] = await Promise.all([getAccounts(), getPayees()]);

  function accountByName(name: APIAccountEntity['name']) {
    return accounts.find(account => account.name === name);
  }

  function accountsByNamePrefix(prefix: string) {
    return accounts.filter(account => account.name.startsWith(prefix));
  }

  function payeeByName(name: APIPayeeEntity['name']) {
    return payees.find(payee => payee.name === name);
  }

  function transferPayeeForAccount(accountId: APIAccountEntity['id']) {
    return payees.find(payee => payee.transfer_acct === accountId);
  }

  async function query<T>(queryToRun: Query) {
    const result = (await aqlQuery(queryToRun)) as QueryResult<T>;
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
        .filter((id): id is APIAccountEntity['id'] => Boolean(id)),
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
        .filter((id): id is APIPayeeEntity['id'] => Boolean(id)),
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
    payees,
    accountByName,
    accountsByNamePrefix,
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
    allowReconciledTransactions: options.allowReconciledTransactions ?? false,
    allowDeletingLinkedTransfers: options.allowDeletingLinkedTransfers ?? false,
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
    summary: summarize(normalizedPlan.operations, previews),
  };
}

async function previewOperations(
  operations: AutomationOperation[],
  context: AutomationContext,
  options: Required<
    Pick<
      AutomationRunOptions,
      'allowReconciledTransactions' | 'allowDeletingLinkedTransfers'
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
      return { operation, status: 'skipped' };
    }

    const ids = getOperationTransactionIds(operation);
    const duplicateId = ids.find(id => touchedIds.has(id));
    if (duplicateId) {
      return {
        operation,
        status: 'error',
        error: `Transaction ${duplicateId} is changed by more than one operation`,
      };
    }
    ids.forEach(id => touchedIds.add(id));

    const missingId = ids.find(id => !transactionsById.has(id));
    if (missingId) {
      return {
        operation,
        status: 'error',
        error: `Transaction ${missingId} does not exist`,
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
      };
    }

    if (operation.type === 'delete-transaction') {
      const transaction = getKnownTransaction(transactionsById, operation.id);
      if (transaction?.transfer_id && !options.allowDeletingLinkedTransfers) {
        return {
          operation,
          status: 'error',
          error: `Transaction ${operation.id} is linked to a transfer`,
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
  const updated: MutableTransactionUpdate[] = [];
  const deleted: Array<Pick<TransactionEntity, 'id'>> = [];

  for (const operation of operations) {
    switch (operation.type) {
      case 'update-transaction':
        updated.push({ id: operation.id, ...operation.fields });
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
        });
        updated.push({
          id: toTransaction.id,
          category: null,
          payee: fromTransferPayee.id,
          transfer_id: fromTransaction.id,
        });
        break;
      }
      case 'skip':
        break;
      default:
        assertNever(operation);
    }
  }

  await batchUpdateTransactions({
    updated: updated as Partial<TransactionEntity>[],
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
  accountId: APIAccountEntity['id'],
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
  transferPayeeId: APIPayeeEntity['id'],
): AutomationTransactionPreview {
  return {
    ...transaction,
    category: null,
    payee: transferPayeeId,
    transfer_id: linkedTransaction.id,
  };
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
