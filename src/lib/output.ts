import Table from 'cli-table3';
import { stringify } from 'csv-stringify/sync';

export type OutputFormat = 'json' | 'table' | 'csv';

export function formatOutput(
  data: Record<string, unknown>[] | Record<string, unknown>,
  format: OutputFormat,
): string {
  const rows = Array.isArray(data) ? data : [data];

  switch (format) {
    case 'json':
      return JSON.stringify(Array.isArray(data) ? rows : data, null, 2);
    case 'table':
      return formatTable(rows);
    case 'csv':
      return formatCsv(rows);
    default:
      return JSON.stringify(data, null, 2);
  }
}

export function printOutput(
  data: Record<string, unknown>[] | Record<string, unknown>,
  format: OutputFormat,
): void {
  console.log(formatOutput(data, format));
}

export function printError(
  error: { code: string; message: string; retry_after?: number },
  format: OutputFormat,
): void {
  if (format === 'json') {
    console.error(JSON.stringify({ error }, null, 2));
  } else {
    let msg = `Error [${error.code}]: ${error.message}`;
    if (error.retry_after) msg += `\nRetry after: ${error.retry_after}s`;
    console.error(msg);
  }
}

function formatTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return 'No data';
  const keys = Object.keys(rows[0]);
  const table = new Table({ head: keys, style: { head: ['cyan'] } });
  for (const row of rows) {
    table.push(keys.map((k) => String(row[k] ?? '')));
  }
  return table.toString();
}

function formatCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const keys = Object.keys(rows[0]);
  return stringify(
    rows.map((row) => keys.map((k) => row[k])),
    { header: true, columns: keys },
  );
}
