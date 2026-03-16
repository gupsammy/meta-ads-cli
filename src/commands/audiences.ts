import { Command, Option } from 'commander';
import { requireAccessToken, requireAccountId } from '../auth.js';
import { paginateAll, graphRequestWithRetry, HttpError } from '../lib/http.js';
import { printListOutput, printOutput, printError, type OutputFormat, EXIT_RUNTIME } from '../lib/output.js';

interface CustomAudience {
  id: string;
  name: string;
  description?: string;
  subtype: string;
  approximate_count_lower_bound?: number;
  approximate_count_upper_bound?: number;
  time_created?: string;
  time_updated?: string;
  delivery_status?: { status: string };
}

const AUDIENCE_FIELDS = 'id,name,description,subtype,approximate_count_lower_bound,approximate_count_upper_bound,time_created,time_updated,delivery_status';

export function registerAudiencesCommands(program: Command): void {
  const audiences = program.command('audiences').description('Manage custom audiences');

  audiences
    .command('list')
    .description('List custom audiences for an ad account')
    .option('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .option('--limit <n>', 'Maximum number of audiences to return')
    .option('--after <cursor>', 'Pagination cursor')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      accountId?: string;
      limit?: string;
      after?: string;
      accessToken?: string;
      output: OutputFormat;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const accountId = requireAccountId(opts.accountId);
        const params: Record<string, string> = { fields: AUDIENCE_FIELDS };
        if (opts.after) params['after'] = opts.after;

        const limit = opts.limit ? parseInt(opts.limit, 10) : 50;

        if (opts.verbose) console.error(`GET /${accountId}/customaudiences`);

        const result = await paginateAll<CustomAudience>(
          `/${accountId}/customaudiences`,
          token,
          { params },
          limit,
        );

        const data = result.data.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description ?? '',
          subtype: a.subtype,
          approx_count_lower: a.approximate_count_lower_bound ?? '',
          approx_count_upper: a.approximate_count_upper_bound ?? '',
          delivery_status: a.delivery_status?.status ?? '',
          time_created: a.time_created ?? '',
        }));

        printListOutput(data, opts.output, {
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
        const params: Record<string, string> = { fields: AUDIENCE_FIELDS };

        if (opts.verbose) console.error(`GET /${opts.audienceId}`);

        const audience = await graphRequestWithRetry<CustomAudience>(`/${opts.audienceId}`, token, { params });

        printOutput(
          {
            id: audience.id,
            name: audience.name,
            description: audience.description ?? '',
            subtype: audience.subtype,
            approx_count_lower: audience.approximate_count_lower_bound ?? '',
            approx_count_upper: audience.approximate_count_upper_bound ?? '',
            delivery_status: audience.delivery_status?.status ?? '',
            time_created: audience.time_created ?? '',
            time_updated: audience.time_updated ?? '',
          },
          opts.output,
        );
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
