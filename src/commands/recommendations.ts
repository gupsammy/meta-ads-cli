import { Command, Option } from 'commander';
import { requireAccessToken, requireAccountId } from '../auth.js';
import { graphRequestWithRetry } from '../lib/http.js';
import { printOutput, printListOutput, handleCommandError, type OutputFormat } from '../lib/output.js';
import type { RecommendationsData } from '../intel/types.js';

export function registerRecommendationsCommands(program: Command): void {
  const recommendations = program.command('recommendations').description('Get account recommendations from Meta');

  recommendations
    .command('list')
    .description('List account optimization recommendations')
    .option('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .option('--limit <n>', 'Maximum number of recommendations to return')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      accountId?: string;
      limit?: string;
      accessToken?: string;
      output: OutputFormat;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const accountId = requireAccountId(opts.accountId);

        if (opts.verbose) console.error(`POST /${accountId}/recommendations`);

        const result = await graphRequestWithRetry<RecommendationsData>(
          `/${accountId}/recommendations`,
          token,
          { method: 'POST' },
        );

        if (opts.output === 'json') {
          // JSON: full object with opportunity_score + data array
          printOutput(result as unknown as Record<string, unknown>, opts.output);
        } else {
          // Table/CSV: render recommendations as rows
          if (typeof result.opportunity_score === 'number') {
            console.error(`Opportunity score: ${result.opportunity_score}/100`);
          }
          const data = Array.isArray(result.data) ? result.data as Record<string, unknown>[] : [];
          printListOutput(data, opts.output);
        }
      } catch (error) {
        handleCommandError(error, opts.output);
      }
    });
}
