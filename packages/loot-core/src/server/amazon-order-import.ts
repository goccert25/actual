import { parse as csvToJson } from 'csv-parse/sync';

import { q } from '#shared/query';
import {
  makeChild,
  splitTransaction,
  updateTransaction,
} from '#shared/transactions';
import { amountToInteger, diffItems, looselyParseAmount } from '#shared/util';
import type {
  AmazonOrderImportPreviewMatch,
  AmazonOrderImportPreviewOrder,
  AmazonOrderImportRequest,
  AmazonOrderImportResult,
} from '#types/automations';
import type { TransactionEntity } from '#types/models';

import { aqlQuery } from './aql';
import * as db from './db';
import { payeeModel } from './models';
import { batchUpdateTransactions } from './transactions';
import { withUndo } from './undo';

const AMAZON_PAYEE_KEYWORDS = ['amazon', 'amzn'] as const;
const MATCH_WINDOW_DAYS = 10;
const REQUIRED_COLUMNS = [
  'Order Date',
  'Order ID',
  'Original Quantity',
  'Product Name',
  'Total Amount',
] as const;

type AmazonOrderImportCsvRow = Record<string, string>;

type AmazonOrderItem = {
  productName: string;
  quantity: number;
  totalAmount: number;
};

type AmazonOrder = {
  orderDate: string;
  orderId: string;
  totalAmount: number;
  items: AmazonOrderItem[];
};

type AmazonOrderParseResult = {
  invalidOrders: AmazonOrderImportPreviewOrder[];
  orders: AmazonOrder[];
};

type MatchCandidate = {
  accountName: string | null;
  dayDifference: number;
  payeeName: string | null;
  transaction: TransactionEntity;
};

type AmazonOrderPreviewBuildResult = {
  matches: Array<{
    order: AmazonOrder;
    transaction: TransactionEntity;
  }>;
  orders: AmazonOrderImportPreviewOrder[];
};

export async function previewAmazonOrderImport({
  csvText,
}: AmazonOrderImportRequest): Promise<AmazonOrderImportResult> {
  return runAmazonOrderImport(csvText, false);
}

export async function applyAmazonOrderImport({
  csvText,
}: AmazonOrderImportRequest): Promise<AmazonOrderImportResult> {
  return withUndo(() => runAmazonOrderImport(csvText, true), {
    type: 'automation',
    name: 'Amazon order split import',
  });
}

export function parseAmazonOrderCsv(csvText: string): AmazonOrderParseResult {
  if (!csvText.trim()) {
    throw new Error('Paste Amazon CSV data or choose a CSV file.');
  }

  let rows: AmazonOrderImportCsvRow[];
  try {
    rows = csvToJson(csvText, {
      bom: true,
      columns: true,
      delimiter: ',',
      quote: '"',
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }) as AmazonOrderImportCsvRow[];
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown CSV error';
    throw new Error(`Unable to parse the Amazon CSV: ${message}`);
  }

  if (rows.length === 0) {
    throw new Error('The CSV did not contain any rows.');
  }

  const firstRow = rows[0];
  for (const column of REQUIRED_COLUMNS) {
    if (!(column in firstRow)) {
      throw new Error(`The CSV is missing the "${column}" column.`);
    }
  }

  const ordersById = new Map<string, AmazonOrder>();
  const invalidOrders: AmazonOrderImportPreviewOrder[] = [];

  rows.forEach((row, index) => {
    const orderId = String(row['Order ID'] ?? '').trim();
    const orderDate = normalizeOrderDate(row['Order Date']);
    const productName = String(row['Product Name'] ?? '').trim();
    const totalAmount = parseCurrencyToInteger(row['Total Amount']);
    const quantity = parseQuantity(row['Original Quantity']);

    if (!orderId || !orderDate || !productName || totalAmount == null) {
      invalidOrders.push({
        items: [],
        match: null,
        orderDate,
        orderId: orderId || `Row ${index + 2}`,
        reason: buildInvalidRowReason({
          hasOrderDate: Boolean(orderDate),
          hasOrderId: Boolean(orderId),
          hasProductName: Boolean(productName),
          hasTotalAmount: totalAmount != null,
          rowNumber: index + 2,
        }),
        status: 'invalid',
        totalAmount,
      });
      return;
    }

    const existingOrder = ordersById.get(orderId);
    if (existingOrder) {
      existingOrder.items.push({ productName, quantity, totalAmount });
      existingOrder.totalAmount += totalAmount;
      return;
    }

    ordersById.set(orderId, {
      items: [{ productName, quantity, totalAmount }],
      orderDate,
      orderId,
      totalAmount,
    });
  });

  return {
    invalidOrders,
    orders: [...ordersById.values()],
  };
}

export function buildAmazonOrderImportPreview({
  accountNamesById,
  invalidOrders,
  orders,
  payeeNamesById,
  transactions,
}: {
  accountNamesById: Map<string, string>;
  invalidOrders: AmazonOrderImportPreviewOrder[];
  orders: AmazonOrder[];
  payeeNamesById: Map<string, string>;
  transactions: TransactionEntity[];
}): AmazonOrderPreviewBuildResult {
  const matchedTransactionIds = new Set<TransactionEntity['id']>();
  const results = new Map<string, AmazonOrderImportPreviewOrder>();
  const matches: AmazonOrderPreviewBuildResult['matches'] = [];
  const amazonTransactions = transactions.filter(transaction => {
    const payeeName = transaction.payee
      ? (payeeNamesById.get(transaction.payee) ?? null)
      : null;

    return transactionMatchesAmazon(payeeName, transaction.imported_payee);
  });

  const sortedOrders = [...orders].sort((left, right) => {
    const leftCandidates = getCandidatesForOrder(
      left,
      amazonTransactions,
      accountNamesById,
      payeeNamesById,
    );
    const rightCandidates = getCandidatesForOrder(
      right,
      amazonTransactions,
      accountNamesById,
      payeeNamesById,
    );
    const leftBest = Math.min(
      ...leftCandidates.map(candidate => candidate.dayDifference),
      Number.POSITIVE_INFINITY,
    );
    const rightBest = Math.min(
      ...rightCandidates.map(candidate => candidate.dayDifference),
      Number.POSITIVE_INFINITY,
    );

    if (leftBest !== rightBest) {
      return leftBest - rightBest;
    }

    if (leftCandidates.length !== rightCandidates.length) {
      return leftCandidates.length - rightCandidates.length;
    }

    return left.orderDate.localeCompare(right.orderDate);
  });

  for (const order of sortedOrders) {
    const availableCandidates = getCandidatesForOrder(
      order,
      amazonTransactions,
      accountNamesById,
      payeeNamesById,
    ).filter(candidate => !matchedTransactionIds.has(candidate.transaction.id));

    const unsplitCandidates = availableCandidates.filter(
      candidate =>
        candidate.transaction.is_parent !== true &&
        candidate.transaction.is_child !== true,
    );
    const splitCandidates = availableCandidates.filter(
      candidate => candidate.transaction.is_parent === true,
    );

    const selectedUnsplit = selectBestCandidate(unsplitCandidates);
    if (selectedUnsplit === 'ambiguous') {
      results.set(
        order.orderId,
        buildPreviewOrder(order, null, 'ambiguous', {
          reason: `Found ${unsplitCandidates.length} matching transactions with the same amount within ${MATCH_WINDOW_DAYS} days`,
        }),
      );
      continue;
    }

    if (selectedUnsplit) {
      matchedTransactionIds.add(selectedUnsplit.transaction.id);
      matches.push({
        order,
        transaction: selectedUnsplit.transaction,
      });
      results.set(
        order.orderId,
        buildPreviewOrder(order, selectedUnsplit, 'matched', {
          reason: 'Matched on amount, payee, and date window',
        }),
      );
      continue;
    }

    const selectedSplit = selectBestCandidate(splitCandidates);
    if (selectedSplit === 'ambiguous') {
      results.set(
        order.orderId,
        buildPreviewOrder(order, null, 'ambiguous', {
          reason: `Found multiple already-split transactions with the same amount within ${MATCH_WINDOW_DAYS} days`,
        }),
      );
      continue;
    }

    if (selectedSplit) {
      results.set(
        order.orderId,
        buildPreviewOrder(order, selectedSplit, 'already-split', {
          reason: 'The matching transaction is already a split transaction',
        }),
      );
      continue;
    }

    results.set(
      order.orderId,
      buildPreviewOrder(order, null, 'unmatched', {
        reason: `No Amazon or Amzn transaction was found within ${MATCH_WINDOW_DAYS} days`,
      }),
    );
  }

  return {
    matches,
    orders: [
      ...orders.map(order => {
        const preview = results.get(order.orderId);
        if (!preview) {
          throw new Error(
            `No preview result was produced for order ${order.orderId}`,
          );
        }
        return preview;
      }),
      ...invalidOrders,
    ],
  };
}

export function createAmazonOrderSplitDiff(
  order: AmazonOrder,
  transaction: TransactionEntity,
) {
  const splitResult = splitTransaction([transaction], transaction.id, parent =>
    order.items.map((item, index) =>
      makeChild(parent, {
        amount: -item.totalAmount,
        category: null,
        notes: item.productName,
        sort_order: -(index + 1),
      }),
    ),
  );

  if (!splitResult.newTransaction) {
    throw new Error(`Unable to create split transaction for ${transaction.id}`);
  }

  const finalizedResult = updateTransaction(
    splitResult.data,
    splitResult.newTransaction,
  );

  return diffItems([transaction], finalizedResult.data);
}

async function runAmazonOrderImport(
  csvText: string,
  apply: boolean,
): Promise<AmazonOrderImportResult> {
  const parsed = parseAmazonOrderCsv(csvText);
  const [accounts, payees] = await Promise.all([
    db.getAccounts(),
    db.getPayees(),
  ]);

  const accountNamesById = new Map(
    accounts.map(account => [account.id, account.name]),
  );
  const payeeNamesById = new Map(
    payees.map(payee => {
      const payeeEntity = payeeModel.fromDb(payee);
      return [payeeEntity.id, payeeEntity.name] as const;
    }),
  );

  const transactions = await queryCandidateTransactions(parsed.orders);
  const preview = buildAmazonOrderImportPreview({
    accountNamesById,
    invalidOrders: parsed.invalidOrders,
    orders: parsed.orders,
    payeeNamesById,
    transactions,
  });

  if (apply && preview.matches.length > 0) {
    const changes = preview.matches.map(match =>
      createAmazonOrderSplitDiff(match.order, match.transaction),
    );

    await batchUpdateTransactions({
      added: changes.flatMap(change => change.added),
      runTransfers: false,
      updated: changes.flatMap(change => change.updated),
    });
  }

  return {
    applied: apply && preview.matches.length > 0,
    orders: preview.orders,
    summary: summarizePreview(
      preview.orders,
      apply ? preview.matches.length : 0,
    ),
  };
}

async function queryCandidateTransactions(orders: AmazonOrder[]) {
  if (orders.length === 0) {
    return [];
  }

  const sortedDates = orders.map(order => order.orderDate).sort();
  const startDate = shiftDate(sortedDates[0], -MATCH_WINDOW_DAYS);
  const endDate = shiftDate(
    sortedDates.at(-1) ?? sortedDates[0],
    MATCH_WINDOW_DAYS,
  );

  const { data } = await aqlQuery(
    q('transactions')
      .filter({
        $and: [{ date: { $gte: startDate } }, { date: { $lte: endDate } }],
      })
      .select('*')
      .options({ splits: 'grouped' }),
  );

  return data as TransactionEntity[];
}

function getCandidatesForOrder(
  order: AmazonOrder,
  transactions: TransactionEntity[],
  accountNamesById: Map<string, string>,
  payeeNamesById: Map<string, string>,
): MatchCandidate[] {
  return transactions
    .filter(transaction => {
      return (
        Math.abs(transaction.amount) === order.totalAmount &&
        daysBetween(transaction.date, order.orderDate) <= MATCH_WINDOW_DAYS
      );
    })
    .map(transaction => {
      const payeeName = transaction.payee
        ? (payeeNamesById.get(transaction.payee) ?? null)
        : null;

      return {
        accountName: accountNamesById.get(transaction.account) ?? null,
        dayDifference: daysBetween(transaction.date, order.orderDate),
        payeeName,
        transaction,
      };
    });
}

function selectBestCandidate(candidates: MatchCandidate[]) {
  if (candidates.length === 0) {
    return null;
  }

  const sortedCandidates = [...candidates].sort((left, right) => {
    if (left.dayDifference !== right.dayDifference) {
      return left.dayDifference - right.dayDifference;
    }

    return left.transaction.date.localeCompare(right.transaction.date);
  });

  if (sortedCandidates.length === 1) {
    return sortedCandidates[0];
  }

  if (sortedCandidates[0].dayDifference < sortedCandidates[1].dayDifference) {
    return sortedCandidates[0];
  }

  return 'ambiguous' as const;
}

function buildPreviewOrder(
  order: AmazonOrder,
  candidate: MatchCandidate | null,
  status: AmazonOrderImportPreviewOrder['status'],
  { reason }: { reason: string },
): AmazonOrderImportPreviewOrder {
  return {
    items: order.items.map(item => ({
      productName: item.productName,
      quantity: item.quantity,
      totalAmount: item.totalAmount,
    })),
    match: candidate ? toPreviewMatch(candidate) : null,
    orderDate: order.orderDate,
    orderId: order.orderId,
    reason,
    status,
    totalAmount: order.totalAmount,
  };
}

function toPreviewMatch(
  candidate: MatchCandidate,
): AmazonOrderImportPreviewMatch {
  return {
    accountName: candidate.accountName,
    date: candidate.transaction.date,
    isChild: candidate.transaction.is_child === true,
    isParent: candidate.transaction.is_parent === true,
    payeeName: candidate.payeeName,
    reconciled: candidate.transaction.reconciled === true,
    totalAmount: Math.abs(candidate.transaction.amount),
    transactionId: candidate.transaction.id,
  };
}

function summarizePreview(
  orders: AmazonOrderImportPreviewOrder[],
  appliedOrders: number,
): AmazonOrderImportResult['summary'] {
  return {
    alreadySplitOrders: orders.filter(order => order.status === 'already-split')
      .length,
    ambiguousOrders: orders.filter(order => order.status === 'ambiguous')
      .length,
    appliedOrders,
    invalidOrders: orders.filter(order => order.status === 'invalid').length,
    matchedOrders: orders.filter(order => order.status === 'matched').length,
    totalOrders: orders.length,
    unmatchedOrders: orders.filter(order => order.status === 'unmatched')
      .length,
  };
}

function transactionMatchesAmazon(
  payeeName: string | null,
  importedPayee: string | undefined,
) {
  const normalizedPayee =
    `${payeeName ?? ''} ${importedPayee ?? ''}`.toLowerCase();
  return AMAZON_PAYEE_KEYWORDS.some(keyword =>
    normalizedPayee.includes(keyword),
  );
}

function buildInvalidRowReason({
  hasOrderDate,
  hasOrderId,
  hasProductName,
  hasTotalAmount,
  rowNumber,
}: {
  hasOrderDate: boolean;
  hasOrderId: boolean;
  hasProductName: boolean;
  hasTotalAmount: boolean;
  rowNumber: number;
}) {
  const missingFields = [
    !hasOrderId && 'Order ID',
    !hasOrderDate && 'Order Date',
    !hasProductName && 'Product Name',
    !hasTotalAmount && 'Total Amount',
  ].filter((value): value is string => Boolean(value));

  return `Row ${rowNumber} is missing or has an invalid ${missingFields.join(', ')}`;
}

function parseCurrencyToInteger(value: string | undefined) {
  if (!value) {
    return null;
  }

  const amount = looselyParseAmount(value);
  if (amount == null) {
    return null;
  }

  return amountToInteger(Math.abs(amount));
}

function parseQuantity(value: string | undefined) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 1 : parsed;
}

function normalizeOrderDate(value: string | undefined) {
  const trimmedValue = String(value ?? '').trim();
  const match = trimmedValue.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function shiftDate(date: string, days: number) {
  const utcDate = dateToUtc(date);
  const shifted = new Date(utcDate + days * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function daysBetween(leftDate: string, rightDate: string) {
  const dayMilliseconds = 24 * 60 * 60 * 1000;
  return Math.abs(dateToUtc(leftDate) - dateToUtc(rightDate)) / dayMilliseconds;
}

function dateToUtc(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}
