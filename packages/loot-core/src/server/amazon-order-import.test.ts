import { describe, expect, it } from 'vitest';

import { applyChanges } from '#shared/util';
import type { TransactionEntity } from '#types/models';

import {
  buildAmazonOrderImportPreview,
  createAmazonOrderSplitDiff,
  parseAmazonOrderCsv,
} from './amazon-order-import';

describe('amazon-order-import', () => {
  it('parses amazon csv rows into grouped orders', () => {
    const csvText = [
      'ASIN,"Order Date","Order ID","Original Quantity","Product Name","Total Amount"',
      'A1,2025-01-10T00:00:00Z,111-1,1,"First item",12.34',
      'A2,2025-01-10T00:00:00Z,111-1,2,"Second item",5.66',
    ].join('\n');

    const result = parseAmazonOrderCsv(csvText);

    expect(result.invalidOrders).toEqual([]);
    expect(result.orders).toEqual([
      {
        items: [
          {
            productName: 'First item',
            quantity: 1,
            totalAmount: 1234,
          },
          {
            productName: 'Second item',
            quantity: 2,
            totalAmount: 566,
          },
        ],
        orderDate: '2025-01-10',
        orderId: '111-1',
        totalAmount: 1800,
      },
    ]);
  });

  it('classifies matched, already split, ambiguous, and unmatched orders', () => {
    const orders = [
      {
        items: [
          { productName: 'Matched item', quantity: 1, totalAmount: 1800 },
        ],
        orderDate: '2025-01-10',
        orderId: 'order-matched',
        totalAmount: 1800,
      },
      {
        items: [{ productName: 'Split item', quantity: 1, totalAmount: 2500 }],
        orderDate: '2025-01-10',
        orderId: 'order-split',
        totalAmount: 2500,
      },
      {
        items: [
          { productName: 'Ambiguous item', quantity: 1, totalAmount: 3300 },
        ],
        orderDate: '2025-01-10',
        orderId: 'order-ambiguous',
        totalAmount: 3300,
      },
      {
        items: [
          { productName: 'Missing item', quantity: 1, totalAmount: 4400 },
        ],
        orderDate: '2025-01-10',
        orderId: 'order-missing',
        totalAmount: 4400,
      },
    ];
    const transactions: TransactionEntity[] = [
      makeTransaction({
        account: 'acct-1',
        amount: -1800,
        date: '2025-01-12',
        id: 'tx-matched',
        payee: 'payee-amazon',
      }),
      makeTransaction({
        account: 'acct-1',
        amount: -2500,
        date: '2025-01-11',
        id: 'tx-split',
        is_parent: true,
        payee: 'payee-amazon',
      }),
      makeTransaction({
        account: 'acct-2',
        amount: -3300,
        date: '2025-01-09',
        id: 'tx-ambiguous-1',
        payee: 'payee-amazon',
      }),
      makeTransaction({
        account: 'acct-2',
        amount: -3300,
        date: '2025-01-11',
        id: 'tx-ambiguous-2',
        payee: 'payee-amazon',
      }),
    ];

    const result = buildAmazonOrderImportPreview({
      accountNamesById: new Map([
        ['acct-1', 'Checking'],
        ['acct-2', 'Credit Card'],
      ]),
      invalidOrders: [],
      orders,
      payeeNamesById: new Map([['payee-amazon', 'Amazon Marketplace']]),
      transactions,
    });

    expect(result.matches.map(match => match.transaction.id)).toEqual([
      'tx-matched',
    ]);
    expect(result.orders.map(order => [order.orderId, order.status])).toEqual([
      ['order-matched', 'matched'],
      ['order-split', 'already-split'],
      ['order-ambiguous', 'ambiguous'],
      ['order-missing', 'unmatched'],
    ]);
  });

  it('creates split transaction diffs with item notes and amounts', () => {
    const transaction = makeTransaction({
      account: 'acct-1',
      amount: -1800,
      date: '2025-01-10',
      id: 'tx-1',
      notes: 'Original note',
      payee: 'payee-amazon',
    });

    const diff = createAmazonOrderSplitDiff(
      {
        items: [
          { productName: 'First item', quantity: 1, totalAmount: 1200 },
          { productName: 'Second item', quantity: 2, totalAmount: 600 },
        ],
        orderDate: '2025-01-10',
        orderId: '111-1',
        totalAmount: 1800,
      },
      transaction,
    );

    const finalTransactions = applyChanges(diff, [
      transaction,
    ]) as TransactionEntity[];
    const [parent, ...children] = finalTransactions;

    expect(parent.is_parent).toBe(true);
    expect(parent.error).toBeNull();
    expect(children.map(child => [child.notes, child.amount])).toEqual([
      ['First item', -1200],
      ['Second item', -600],
    ]);
    expect(children.every(child => child.parent_id === parent.id)).toBe(true);
  });
});

function makeTransaction(
  fields: Partial<TransactionEntity> & Pick<TransactionEntity, 'id'>,
): TransactionEntity {
  return {
    ...fields,
    account: fields.account ?? 'acct-1',
    amount: fields.amount ?? -1000,
    date: fields.date ?? '2025-01-01',
  } as TransactionEntity;
}
