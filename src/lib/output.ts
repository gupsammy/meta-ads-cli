import Table from 'cli-table3';
import { stringify } from 'csv-stringify/sync';
import { createInterface } from 'node:readline';

export type OutputFormat = 'json' | 'table' | 'csv';

export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;

function isColorDisabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  return (
    !!process.env['NO_COLOR'] ||
    process.env['TERM'] === 'dumb' ||
    !stream.isTTY
  );
}

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

export function printListOutput(
  data: Record<string, unknown>[],
  format: OutputFormat,
  paging?: { has_more: boolean; next_cursor?: string },
): void {
  if (format === 'json') {
    const output: Record<string, unknown> = { data };
    if (paging) {
      output['has_more'] = paging.has_more;
      if (paging.next_cursor) output['next_cursor'] = paging.next_cursor;
    } else {
      output['has_more'] = false;
    }
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (data.length === 0) {
      console.log(format === 'table' ? 'No data' : '');
    } else {
      console.log(format === 'table' ? formatTable(data) : formatCsv(data));
    }
  }
}

export function getErrorHint(code: string): string | null {
  switch (code) {
    case 'AUTH_FAILED':
    case 'API_ERROR_190':
      return 'meta-ads auth login --token <token>';
    case 'API_ERROR_200':
      return 'Check app permissions in Meta Business Manager';
    case 'API_ERROR_2635':
      return 'Check account status in Meta Business Manager';
    case 'RATE_LIMITED':
    case 'API_ERROR_100':
    case 'UNKNOWN':
      return null;
    default:
      return null;
  }
}

export function printError(
  error: { code: string; message: string; retry_after?: number; hint?: string | null },
  format: OutputFormat,
): void {
  const hint = error.hint !== undefined ? error.hint : getErrorHint(error.code);
  if (format === 'json') {
    const obj: Record<string, unknown> = { error: error.code, message: error.message };
    if (error.retry_after) obj['retry_after'] = error.retry_after;
    if (hint) obj['hint'] = hint;
    console.error(JSON.stringify(obj, null, 2));
  } else {
    let msg = `Error [${error.code}]: ${error.message}`;
    if (error.retry_after) msg += `\nRetry after: ${error.retry_after}s`;
    if (hint) msg += `\nHint: ${hint}`;
    console.error(msg);
  }
}

export async function confirmAction(message: string, force?: boolean): Promise<boolean> {
  if (force) return true;
  if (!process.stdin.isTTY) return false;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

export async function promptInput(message: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function formatTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return 'No data';
  const keys = Object.keys(rows[0]);
  const noColor = isColorDisabled();
  const table = new Table({
    head: keys,
    style: { head: noColor ? [] : ['cyan'], border: noColor ? [] : undefined },
  });
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
