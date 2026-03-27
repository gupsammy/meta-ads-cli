import { Command, Option } from 'commander';
import { requireAccessToken, resolveAccountId } from '../auth.js';
import { graphRequestWithRetry, type GraphApiResponse } from '../lib/http.js';
import { printListOutput, printError, handleCommandError, type OutputFormat, EXIT_USAGE } from '../lib/output.js';

type InsightRow = Record<string, unknown>;

const INSIGHT_FIELDS = 'account_id,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,action_values,cost_per_action_type,purchase_roas,date_start,date_stop';

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

        let basePath: string;
        if (opts.adId) {
          basePath = `/${opts.adId}/insights`;
        } else if (opts.adsetId) {
          basePath = `/${opts.adsetId}/insights`;
        } else if (opts.campaignId) {
          basePath = `/${opts.campaignId}/insights`;
        } else {
          const accountId = resolveAccountId(opts.accountId);
          if (!accountId) {
            printError({ code: 'USAGE', message: 'Specify at least one of: --account-id, --campaign-id, --adset-id, --ad-id' }, opts.output);
            process.exit(EXIT_USAGE);
          }
          basePath = `/${accountId}/insights`;
        }

        if ((opts.since && !opts.until) || (!opts.since && opts.until)) {
          printError({ code: 'USAGE', message: '--since and --until must both be specified together' }, opts.output);
          process.exit(EXIT_USAGE);
        }

        const level = opts.level ?? (opts.adId ? 'ad' : opts.adsetId ? 'adset' : opts.campaignId ? 'campaign' : 'account');

        const defaultFields = opts.fields ?? (
          level === 'ad'
            ? INSIGHT_FIELDS + ',quality_ranking,engagement_rate_ranking,conversion_rate_ranking'
            : INSIGHT_FIELDS
        );

        const params: Record<string, string> = {
          fields: defaultFields,
          level,
        };

        if (opts.datePreset) {
          params['date_preset'] = opts.datePreset;
        }
        if (opts.since && opts.until) {
          params['time_range'] = JSON.stringify({ since: opts.since, until: opts.until });
        }
        if (opts.timeIncrement) {
          params['time_increment'] = opts.timeIncrement;
        }
        if (opts.limit) {
          params['limit'] = opts.limit;
        }

        if (opts.verbose) console.error(`GET ${basePath}`);

        const response = await graphRequestWithRetry<GraphApiResponse<InsightRow>>(
          basePath,
          token,
          { params },
        );

        const data = response.data ?? [];

        printListOutput(data, opts.output);
      } catch (error) {
        handleCommandError(error, opts.output);
      }
    });
}
