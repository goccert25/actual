// @ts-strict-ignore
import { parse as csv2json } from 'csv-parse/sync';

import * as fs from '#platform/server/fs';
import { logger } from '#platform/server/log';
import { looselyParseAmount } from '#shared/util';

import { ofx2json } from './ofx2json';
import { qif2json } from './qif2json';
import { xmlCAMT2json } from './xmlcamt2json';

/**
 * Parse OFX amount strings to numbers.
 * Handles various OFX amount formats including currency symbols, parentheses, and multiple decimal places.
 * Returns null for invalid amounts instead of NaN.
 */
function parseOfxAmount(amount: string): number | null {
  if (!amount || typeof amount !== 'string') {
    return null;
  }

  // Handle parentheses for negative amounts (e.g., "(30.00)" -> "-30.00")
  let cleaned = amount.trim();
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = '-' + cleaned.slice(1, -1);
  }

  // Remove currency symbols and other non-numeric characters except decimal point and minus sign
  cleaned = cleaned.replace(/[^\d.-]/g, '');

  // Handle multiple decimal points by keeping only the first one
  const decimalIndex = cleaned.indexOf('.');
  if (decimalIndex !== -1) {
    const beforeDecimal = cleaned.slice(0, decimalIndex);
    const afterDecimal = cleaned.slice(decimalIndex + 1).replace(/\./g, '');
    cleaned = beforeDecimal + '.' + afterDecimal;
  }

  // Ensure we have a valid number format
  if (!cleaned || cleaned === '-' || cleaned === '.') {
    return null;
  }

  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

type StructuredTransaction = {
  amount: number;
  date: string;
  payee_name: string;
  imported_payee: string;
  notes: string | null;
  imported_id?: string;
};

// CSV files return raw data that are not guaranteed to be StructuredTransactions
type CsvTransaction = Record<string, string> | string[];

type Transaction = StructuredTransaction | CsvTransaction;

type ParseError = { message: string; internal: string };
export type DetectedImportFormat = 'venmo';
export type ParseFileResult = {
  errors: ParseError[];
  detectedFormat?: DetectedImportFormat | null;
  transactions?: Transaction[];
};

export type ParseFileOptions = {
  hasHeaderRow?: boolean;
  delimiter?: string;
  fallbackMissingPayeeToMemo?: boolean;
  swapPayeeAndMemo?: boolean;
  skipStartLines?: number;
  skipEndLines?: number;
  importNotes?: boolean;
};

export async function parseFile(
  filepath: string,
  options: ParseFileOptions = {},
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  const m = filepath.match(/\.[^.]*$/);

  if (m) {
    const ext = m[0];

    switch (ext.toLowerCase()) {
      case '.qif':
        return parseQIF(filepath, options);
      case '.csv':
      case '.tsv':
        return parseCSV(filepath, options);
      case '.ofx':
      case '.qfx':
        return parseOFX(filepath, options);
      case '.xml':
        return parseCAMT(filepath, options);
      default:
    }
  }

  errors.push({
    message: 'Invalid file type',
    internal: '',
  });
  return { errors, transactions: [] };
}

async function parseCSV(
  filepath: string,
  options: ParseFileOptions,
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  let contents = await fs.readFile(filepath);

  const venmoImport = parseVenmoCSV(contents);
  if (venmoImport) {
    return {
      errors,
      detectedFormat: 'venmo',
      transactions: venmoImport,
    };
  }

  const skipStart = Math.max(0, options.skipStartLines || 0);
  const skipEnd = Math.max(0, options.skipEndLines || 0);

  if (skipStart > 0 || skipEnd > 0) {
    const lines = contents.split(/\r?\n/);

    if (skipStart + skipEnd >= lines.length) {
      errors.push({
        message: 'Cannot skip more lines than exist in the file',
        internal: `Attempted to skip ${skipStart} start + ${skipEnd} end lines from ${lines.length} total lines`,
      });
      return { errors, transactions: [] };
    }

    const startLine = skipStart;
    const endLine = skipEnd > 0 ? lines.length - skipEnd : lines.length;
    contents = lines.slice(startLine, endLine).join('\r\n');
  }

  let data: ReturnType<typeof csv2json>;
  try {
    data = csv2json(contents, {
      columns: options?.hasHeaderRow,
      bom: true,
      delimiter: options?.delimiter || ',',

      quote: '"',
      trim: true,
      relax_column_count: true,
      skip_empty_lines: true,
    });
  } catch (err) {
    errors.push({
      message: 'Failed parsing: ' + err.message,
      internal: err.message,
    });
    return { errors, transactions: [] };
  }

  return { errors, transactions: data };
}

const VENMO_COLUMNS = [
  'ID',
  'Datetime',
  'Type',
  'Status',
  'From',
  'To',
  'Amount (total)',
] as const;

function parseVenmoCSV(contents: string): StructuredTransaction[] | null {
  let rows: string[][];
  try {
    rows = csv2json(contents, {
      columns: false,
      bom: true,
      delimiter: ',',
      quote: '"',
      trim: true,
      relax_column_count: true,
      skip_empty_lines: true,
    }) as string[][];
  } catch {
    return null;
  }

  const headerIndex = rows.findIndex(row => isVenmoHeaderRow(row));
  if (headerIndex === -1) {
    return null;
  }

  const headers = rows[headerIndex].map(value => String(value).trim());
  const records = rows
    .slice(headerIndex + 1)
    .map(row => venmoRowToRecord(headers, row))
    .filter(record => record.ID || record.Datetime);

  const ownerName = inferVenmoOwnerName(records);

  return records
    .filter(record => record.ID && record.Datetime)
    .map(record => normalizeVenmoTransaction(record, ownerName))
    .filter(
      transaction => transaction.date != null && transaction.amount != null,
    );
}

function isVenmoHeaderRow(row: unknown): row is string[] {
  if (!Array.isArray(row)) {
    return false;
  }

  const values = new Set(row.map(value => String(value).trim()));
  return VENMO_COLUMNS.every(column => values.has(column));
}

function venmoRowToRecord(headers: string[], row: string[]) {
  const record: Record<string, string> = {};

  headers.forEach((header, index) => {
    record[header] = String(row[index] ?? '').trim();
  });

  return record;
}

function inferVenmoOwnerName(records: Record<string, string>[]): string | null {
  const counts = new Map<string, number>();

  records.forEach(record => {
    [record.From, record.To].forEach(name => {
      if (!name) {
        return;
      }

      counts.set(name, (counts.get(name) || 0) + 1);
    });
  });

  let selectedName: string | null = null;
  let highestCount = 0;
  counts.forEach((count, name) => {
    if (count > highestCount) {
      selectedName = name;
      highestCount = count;
    }
  });

  return selectedName;
}

function normalizeVenmoTransaction(
  record: Record<string, string>,
  ownerName: string | null,
): StructuredTransaction {
  const type = record.Type || 'Venmo';
  const status = record.Status;
  const from = record.From;
  const to = record.To;
  const counterparty =
    getVenmoCounterparty(record, ownerName) ||
    record.Destination ||
    record['Funding Source'] ||
    type ||
    'Venmo';
  const note = buildVenmoNotes(record);

  return {
    amount: looselyParseAmount(record['Amount (total)']),
    date: record.Datetime.slice(0, 10),
    imported_id: `venmo:${record.ID || buildVenmoFallbackId(record)}`,
    payee_name: counterparty,
    imported_payee: `${type}${status ? ` / ${status}` : ''} / ${
      from || '(blank)'
    } -> ${to || '(blank)'}`,
    notes: note,
  };
}

function getVenmoCounterparty(
  record: Record<string, string>,
  ownerName: string | null,
): string | null {
  const from = record.From;
  const to = record.To;

  if (ownerName) {
    if (from === ownerName && to && to !== ownerName) {
      return to;
    }
    if (to === ownerName && from && from !== ownerName) {
      return from;
    }
  }

  if (from && to) {
    return to;
  }

  return from || to || null;
}

function buildVenmoNotes(record: Record<string, string>): string | null {
  const parts = [];

  if (record.Status && record.Status !== 'Complete') {
    parts.push(`[Status: ${record.Status}]`);
  }

  if (record.Note) {
    parts.push(record.Note);
  } else if (record.Type) {
    parts.push(record.Type);
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

function buildVenmoFallbackId(record: Record<string, string>): string {
  return [
    record.Datetime,
    record.Type,
    record.From,
    record.To,
    record['Amount (total)'],
    record.Note,
  ].join('|');
}

async function parseQIF(
  filepath: string,
  options: ParseFileOptions = {},
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  const contents = await fs.readFile(filepath);

  let data: ReturnType<typeof qif2json>;
  try {
    data = qif2json(contents);
  } catch (err) {
    errors.push({
      message: "Failed parsing: doesn't look like a valid QIF file.",
      internal: err.stack,
    });
    return { errors, transactions: [] };
  }

  const swap = options.swapPayeeAndMemo;

  return {
    errors: [],
    transactions: data.transactions
      .map(trans => {
        const payeeSource = swap ? trans.memo : trans.payee;
        const memoSource = swap ? trans.payee : trans.memo;
        const fallbackUsed = !payeeSource && swap;

        return {
          amount:
            trans.amount != null ? looselyParseAmount(trans.amount) : null,
          date: trans.date,
          payee_name: payeeSource || (fallbackUsed ? memoSource : null),
          imported_payee: payeeSource || (fallbackUsed ? memoSource : null),
          notes:
            options.importNotes && !fallbackUsed ? memoSource || null : null,
        };
      })
      .filter(trans => trans.date != null && trans.amount != null),
  };
}

async function parseOFX(
  filepath: string,
  options: ParseFileOptions,
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  const contents = await fs.readFile(filepath);

  let data: Awaited<ReturnType<typeof ofx2json>>;
  try {
    data = await ofx2json(contents);
  } catch (err) {
    errors.push({
      message: 'Failed importing file',
      internal: err.stack,
    });
    return { errors };
  }

  // Banks don't always implement the OFX standard properly
  // If no payee is available try and fallback to memo
  const useMemoFallback = options.fallbackMissingPayeeToMemo;
  const swap = options.swapPayeeAndMemo;

  return {
    errors,
    transactions: data.transactions.map(trans => {
      const parsedAmount = parseOfxAmount(trans.amount);
      if (parsedAmount === null) {
        errors.push({
          message: `Invalid amount format: ${trans.amount}`,
          internal: `Failed to parse amount: ${trans.amount}`,
        });
      }

      const payeeSource = swap ? trans.memo : trans.name;
      const memoSource = swap ? trans.name : trans.memo;
      const fallbackUsed = !payeeSource && useMemoFallback;

      return {
        amount: parsedAmount || 0,
        imported_id: trans.fitId,
        date: trans.date,
        payee_name: payeeSource || (fallbackUsed ? memoSource : null),
        imported_payee: payeeSource || (fallbackUsed ? memoSource : null),
        notes: options.importNotes && !fallbackUsed ? memoSource || null : null,
      };
    }),
  };
}

async function parseCAMT(
  filepath: string,
  options: ParseFileOptions = {},
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  const contents = await fs.readFile(filepath);

  let data: Awaited<ReturnType<typeof xmlCAMT2json>>;
  try {
    data = await xmlCAMT2json(contents);
  } catch (err) {
    logger.error(err);
    errors.push({
      message: 'Failed importing file',
      internal: err.stack,
    });
    return { errors };
  }

  const swap = options.swapPayeeAndMemo;

  return {
    errors,
    transactions: data.map(trans => {
      const payeeSource = swap ? trans.notes : trans.payee_name;
      const memoSource = swap ? trans.payee_name : trans.notes;
      const fallbackUsed = !payeeSource && swap;

      return {
        ...trans,
        payee_name: payeeSource || (fallbackUsed ? memoSource : null),
        imported_payee: payeeSource || (fallbackUsed ? memoSource : null),
        notes: options.importNotes && !fallbackUsed ? memoSource || null : null,
      };
    }),
  };
}
