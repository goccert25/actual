import type { Query } from '../shared/query';
import type {
  AccountEntity,
  CategoryEntity,
  PayeeEntity,
  ScheduleEntity,
  TransactionEntity,
} from './models';

type MetadataValue = string | number | boolean | null;

export type AutomationAccountEntity = Pick<AccountEntity, 'id' | 'name'> & {
  offbudget?: boolean;
  closed?: boolean;
  balance_current?: number | null;
};

export type AutomationCategoryEntity = Pick<
  CategoryEntity,
  'id' | 'name' | 'is_income' | 'hidden'
> & {
  group_id: string;
};

export type AutomationPayeeEntity = Pick<
  PayeeEntity,
  'id' | 'name' | 'transfer_acct'
>;

export type AutomationTransactionUpdateFields = {
  category?: TransactionEntity['category'] | null;
  payee?: TransactionEntity['payee'] | null;
  notes?: TransactionEntity['notes'];
  cleared?: TransactionEntity['cleared'];
  reconciled?: TransactionEntity['reconciled'];
  schedule?: ScheduleEntity['id'] | null;
  transfer_id?: TransactionEntity['transfer_id'] | null;
};

export type AutomationTransactionFilter = {
  accountIds?: Array<AutomationAccountEntity['id']>;
  accountNames?: Array<AutomationAccountEntity['name']>;
  accountNameStartsWith?: string;
  payeeIds?: Array<AutomationPayeeEntity['id']>;
  payeeNames?: Array<AutomationPayeeEntity['name']>;
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

export type AutomationContext = {
  accounts: AutomationAccountEntity[];
  categories: AutomationCategoryEntity[];
  payees: AutomationPayeeEntity[];
  accountByName: (
    name: AutomationAccountEntity['name'],
  ) => AutomationAccountEntity | undefined;
  accountsByNamePrefix: (prefix: string) => AutomationAccountEntity[];
  categoryByName: (
    name: AutomationCategoryEntity['name'],
  ) => AutomationCategoryEntity | undefined;
  payeeByName: (
    name: AutomationPayeeEntity['name'],
  ) => AutomationPayeeEntity | undefined;
  transferPayeeForAccount: (
    accountId: AutomationAccountEntity['id'],
  ) => AutomationPayeeEntity | undefined;
  query: <T>(query: Query) => Promise<T[]>;
  queryTransactions: (
    filter?: AutomationTransactionFilter,
  ) => Promise<TransactionEntity[]>;
  createPlan: (name?: string) => AutomationPlanBuilder;
  daysBetween: (leftDate: string, rightDate: string) => number;
  isWithinDays: (leftDate: string, rightDate: string, days: number) => boolean;
};

export type Automation = {
  name: string;
  description?: string;
  version?: string;
  plan: (
    context: AutomationContext,
  ) =>
    | AutomationPlan
    | AutomationPlanBuilder
    | Promise<AutomationPlan | AutomationPlanBuilder>;
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
  schedule?: ScheduleEntity['id'] | null;
  transfer_id?: TransactionEntity['transfer_id'] | null;
};

export type AutomationOperationPreview = {
  operation: AutomationOperation;
  status: 'ready' | 'skipped' | 'error';
  error?: string;
  before?: TransactionEntity[];
  after?: AutomationTransactionPreview[];
};

export type AutomationPreviewField =
  | 'date'
  | 'accountName'
  | 'payeeName'
  | 'categoryName'
  | 'notes'
  | 'paymentAmount'
  | 'depositAmount';

export type AutomationPreviewTableRow = {
  id: string;
  groupId: string;
  operationType: AutomationOperation['type'];
  rowRole: 'before' | 'after' | 'current';
  status: AutomationOperationPreview['status'];
  transferSide?: 'from' | 'to';
  transactionId?: TransactionEntity['id'];
  date?: string | null;
  accountName?: string | null;
  payeeName?: string | null;
  categoryName?: string | null;
  notes?: string | null;
  paymentAmount?: TransactionEntity['amount'] | null;
  depositAmount?: TransactionEntity['amount'] | null;
  reason: string;
  error?: string;
  changedFields: AutomationPreviewField[];
};

export type AutomationRunResult = {
  automationName: string;
  dryRun: boolean;
  applied: boolean;
  plan: AutomationPlan;
  previews: AutomationOperationPreview[];
  tableRows: AutomationPreviewTableRow[];
  summary: {
    updates: number;
    deletes: number;
    transferLinks: number;
    skips: number;
    errors: number;
  };
};

export type AutomationListItem = Pick<
  Automation,
  'name' | 'description' | 'version'
>;

export type AutomationsListResult = {
  automations: AutomationListItem[];
};

export type AutomationsRunRequest = {
  name: string;
  dryRun?: boolean;
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
