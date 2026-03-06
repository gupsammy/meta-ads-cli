import { Command, Option } from 'commander';
import { requireAccessToken } from '../auth.js';
import { HttpError } from '../lib/http.js';
import { printListOutput, printError, type OutputFormat, EXIT_RUNTIME, EXIT_USAGE } from '../lib/output.js';
import { getInsights, InsightsValidationError } from '../services/insights.js';

const DATE_PRESETS = [
  'today', 'yesterday', 'this_month', 'last_month',
  'this_quarter', 'last_3d', 'last_7d', 'last_14d',
  'last_28d', 'last_30d', 'last_90d', 'last_week_mon_sun',
  'last_week_sun_sat', 'last_quarter', 'last_year', 'this_week_mon_today',
  'this_week_sun_today', 'this_year',
];

export function registerInsightsCommands(program: Command): void {
  const insights = program.command('insights').description('Get advertising insights and reports');

  insights
    .command('get')
    .description('Get insights for an ad account, campaign, ad set, or ad')
    .option('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .option('--campaign-id <id>', 'Campaign ID (get campaign-level insights)')
    .option('--adset-id <id>', 'Ad set ID (get ad-set-level insights)')
    .option('--ad-id <id>', 'Ad ID (get ad-level insights)')
    .option('--date-preset <preset>', `Date preset (${DATE_PRESETS.slice(0, 5).join(', ')}...)`)
    .option('--since <date>', 'Start date (YYYY-MM-DD)')
    .option('--until <date>', 'End date (YYYY-MM-DD)')
    .option('--level <level>', 'Breakdown level (account, campaign, adset, ad); defaults to match the ID flag used')
    .option('--fields <fields>', 'Comma-separated fields to request (use --verbose --help to see defaults)')
    .option('--time-increment <n>', 'Time increment in days (1 for daily breakdown)')
    .option('--limit <n>', 'Maximum number of rows to return')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .addHelpText('after', `
Examples:
  $ meta-ads insights get --account-id act_123456 --date-preset last_30d
  $ meta-ads insights get --account-id act_123456 --since 2024-01-01 --until 2024-01-31 --level campaign
  $ meta-ads insights get --campaign-id 123 --time-increment 1 -o json
`)
    .action(async (opts: {
      accountId?: string;
      campaignId?: string;
      adsetId?: string;
      adId?: string;
      datePreset?: string;
      since?: string;
      until?: string;
      level?: string;
      fields?: string;
      timeIncrement?: string;
      limit?: string;
      accessToken?: string;
      output: OutputFormat;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);

        if (opts.verbose) {
          const id = opts.adId ?? opts.adsetId ?? opts.campaignId ?? opts.accountId ?? '?';
          console.error(`GET /${id}/insights`);
        }

        const data = await getInsights(token, {
          accountId: opts.accountId,
          campaignId: opts.campaignId,
          adsetId: opts.adsetId,
          adId: opts.adId,
          datePreset: opts.datePreset,
          since: opts.since,
          until: opts.until,
          level: opts.level,
          fields: opts.fields,
          timeIncrement: opts.timeIncrement,
          limit: opts.limit,
        });

        printListOutput(data, opts.output);
      } catch (error) {
        if (error instanceof InsightsValidationError) {
          printError({ code: 'USAGE', message: error.message }, opts.output);
          process.exit(EXIT_USAGE);
        } else if (error instanceof HttpError) {
          printError({ code: error.code, message: error.message, retry_after: error.retryAfter }, opts.output);
        } else {
          printError({ code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }, opts.output);
        }
        process.exit(EXIT_RUNTIME);
      }
    });
}
