import { Command, Option } from 'commander';
import { requireAccessToken } from '../auth.js';
import { HttpError } from '../lib/http.js';
import { printListOutput, printOutput, printError, type OutputFormat, EXIT_RUNTIME } from '../lib/output.js';
import { listAccounts, getAccount } from '../services/accounts.js';

export function registerAccountsCommands(program: Command): void {
  const accounts = program.command('accounts').description('Manage ad accounts');

  accounts
    .command('list')
    .description('List ad accounts accessible by the current user')
    .option('--access-token <token>', 'Access token')
    .option('--limit <n>', 'Maximum number of accounts to return')
    .option('--after <cursor>', 'Pagination cursor')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: { accessToken?: string; limit?: string; after?: string; output: OutputFormat; verbose?: boolean }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;

        if (opts.verbose) console.error(`GET /me/adaccounts`);

        const result = await listAccounts(token, { limit, after: opts.after });

        printListOutput(result.data, opts.output, {
          has_more: result.has_more,
          next_cursor: result.next_cursor,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          printError({ code: error.code, message: error.message, retry_after: error.retryAfter }, opts.output);
        } else {
          printError({ code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }, opts.output);
        }
        process.exit(EXIT_RUNTIME);
      }
    });

  accounts
    .command('get')
    .description('Get details for a specific ad account')
    .requiredOption('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: { accountId: string; accessToken?: string; output: OutputFormat; verbose?: boolean }) => {
      try {
        const token = requireAccessToken(opts.accessToken);

        if (opts.verbose) console.error(`GET /${opts.accountId}`);

        const account = await getAccount(token, opts.accountId);
        printOutput(account, opts.output);
      } catch (error) {
        if (error instanceof HttpError) {
          printError({ code: error.code, message: error.message, retry_after: error.retryAfter }, opts.output);
        } else {
          printError({ code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }, opts.output);
        }
        process.exit(EXIT_RUNTIME);
      }
    });
}
