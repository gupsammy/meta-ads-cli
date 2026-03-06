import { Command, Option } from 'commander';
import { requireAccessToken } from '../auth.js';
import { HttpError } from '../lib/http.js';
import { printListOutput, printOutput, printError, type OutputFormat, EXIT_RUNTIME } from '../lib/output.js';
import { listAudiences, getAudience } from '../services/audiences.js';

export function registerAudiencesCommands(program: Command): void {
  const audiences = program.command('audiences').description('Manage custom audiences');

  audiences
    .command('list')
    .description('List custom audiences for an ad account')
    .requiredOption('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .option('--limit <n>', 'Maximum number of audiences to return')
    .option('--after <cursor>', 'Pagination cursor')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      accountId: string;
      limit?: string;
      after?: string;
      accessToken?: string;
      output: OutputFormat;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;

        if (opts.verbose) console.error(`GET /${opts.accountId}/customaudiences`);

        const result = await listAudiences(token, {
          accountId: opts.accountId,
          limit,
          after: opts.after,
        });

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

  audiences
    .command('get')
    .description('Get details for a specific custom audience')
    .requiredOption('--audience-id <id>', 'Custom audience ID')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      audienceId: string;
      accessToken?: string;
      output: OutputFormat;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);

        if (opts.verbose) console.error(`GET /${opts.audienceId}`);

        const audience = await getAudience(token, opts.audienceId);
        printOutput(audience, opts.output);
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
