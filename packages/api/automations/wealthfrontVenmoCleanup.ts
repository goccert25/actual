import type { TransactionEntity } from '@actual-app/core/types/models';

import { defineAutomation } from '../automation';
import type { APIAccountEntity, APIPayeeEntity } from '../models';

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

function findAccountsContaining(
  accounts: APIAccountEntity[],
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
  payeesById: Map<APIPayeeEntity['id'], APIPayeeEntity>,
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
