import { Command } from 'commander';
import { requireAccessToken } from '../auth.js';
import { graphRequestWithRetry, type GraphApiResponse } from '../lib/http.js';
import { printOutput, printError, type OutputFormat } from '../lib/output.js';
import { HttpError } from '../lib/http.js';

interface AdAccount {
  id: string;
  name: string;
  account_id: string;
  account_status: number;
  currency: string;
  timezone_name: string;
  amount_spent: string;
}

const ACCOUNT_FIELDS = 'id,name,account_id,account_status,currency,timezone_name,amount_spent';

const ACCOUNT_STATUS_MAP: Record<number, string> = {
  1: 'ACTIVE',
  2: 'DISABLED',
  3: 'UNSETTLED',
  7: 'PENDING_RISK_REVIEW',
  8: 'PENDING_SETTLEMENT',
  9: 'IN_GRACE_PERIOD',
  100: 'PENDING_CLOSURE',
  101: 'CLOSED',
  201: 'ANY_ACTIVE',
  202: 'ANY_CLOSED',
};

export function registerAccountsCommands(program: Command): void {
  const accounts = program.command('accounts').description('Manage ad accounts');

  accounts
    .command('list')
    .description('List ad accounts accessible by the current user')
    .option('--access-token <token>', 'Access token')
    .option('--limit <n>', 'Maximum number of accounts to return')
    .option('-o, --output <format>', 'Output format (json, table, csv)', 'json')
    .option('-q, --quiet', 'Suppress non-essential output')
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: { accessToken?: string; limit?: string; output: OutputFormat; quiet?: boolean; verbose?: boolean }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const params: Record<string, string> = { fields: ACCOUNT_FIELDS };
        if (opts.limit) params['limit'] = opts.limit;

        if (opts.verbose) console.error(`GET /me/adaccounts?fields=${ACCOUNT_FIELDS}`);

        const response = await graphRequestWithRetry<GraphApiResponse<AdAccount>>(
          '/me/adaccounts',
          token,
          { params },
        );

        const accounts = (response.data ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          account_id: a.account_id,
          status: ACCOUNT_STATUS_MAP[a.account_status] ?? String(a.account_status),
          currency: a.currency,
          timezone: a.timezone_name,
          amount_spent: a.amount_spent,
        }));

        printOutput(accounts, opts.output);
      } catch (error) {
        if (error instanceof HttpError) {
          printError({ code: error.code, message: error.message, retry_after: error.retryAfter }, opts.output);
        } else {
          printError({ code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }, opts.output);
        }
        process.exit(1);
      }
    });

  accounts
    .command('get')
    .description('Get details for a specific ad account')
    .requiredOption('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .option('--access-token <token>', 'Access token')
    .option('-o, --output <format>', 'Output format (json, table, csv)', 'json')
    .option('-q, --quiet', 'Suppress non-essential output')
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: { accountId: string; accessToken?: string; output: OutputFormat; quiet?: boolean; verbose?: boolean }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const accountId = opts.accountId.startsWith('act_') ? opts.accountId : `act_${opts.accountId}`;
        const params: Record<string, string> = { fields: ACCOUNT_FIELDS };

        if (opts.verbose) console.error(`GET /${accountId}?fields=${ACCOUNT_FIELDS}`);

        const account = await graphRequestWithRetry<AdAccount>(`/${accountId}`, token, { params });

        printOutput(
          {
            id: account.id,
            name: account.name,
            account_id: account.account_id,
            status: ACCOUNT_STATUS_MAP[account.account_status] ?? String(account.account_status),
            currency: account.currency,
            timezone: account.timezone_name,
            amount_spent: account.amount_spent,
          },
          opts.output,
        );
      } catch (error) {
        if (error instanceof HttpError) {
          printError({ code: error.code, message: error.message, retry_after: error.retryAfter }, opts.output);
        } else {
          printError({ code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }, opts.output);
        }
        process.exit(1);
      }
    });
}
