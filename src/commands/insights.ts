import { Command } from 'commander';
import { requireAccessToken } from '../auth.js';
import { graphRequestWithRetry, type GraphApiResponse, HttpError } from '../lib/http.js';
import { printOutput, printError, type OutputFormat } from '../lib/output.js';

interface InsightRow {
  account_id?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  impressions: string;
  clicks: string;
  spend: string;
  cpc?: string;
  cpm?: string;
  ctr?: string;
  reach?: string;
  frequency?: string;
  conversions?: string;
  cost_per_conversion?: string;
  date_start: string;
  date_stop: string;
}

const INSIGHT_FIELDS = 'account_id,campaign_id,campaign_name,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,date_start,date_stop';

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
    .option('--level <level>', 'Breakdown level (account, campaign, adset, ad)', 'account')
    .option('--fields <fields>', 'Comma-separated fields to request', INSIGHT_FIELDS)
    .option('--limit <n>', 'Maximum number of rows to return')
    .option('--access-token <token>', 'Access token')
    .option('-o, --output <format>', 'Output format (json, table, csv)', 'json')
    .option('-q, --quiet', 'Suppress non-essential output')
    .option('-v, --verbose', 'Enable verbose output')
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
      limit?: string;
      accessToken?: string;
      output: OutputFormat;
      quiet?: boolean;
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
        } else if (opts.accountId) {
          const accountId = opts.accountId.startsWith('act_') ? opts.accountId : `act_${opts.accountId}`;
          basePath = `/${accountId}/insights`;
        } else {
          console.error('Specify at least one of: --account-id, --campaign-id, --adset-id, --ad-id');
          process.exit(1);
        }

        const params: Record<string, string> = {
          fields: opts.fields ?? INSIGHT_FIELDS,
        };

        if (opts.datePreset) {
          params['date_preset'] = opts.datePreset;
        }
        if (opts.since && opts.until) {
          params['time_range'] = JSON.stringify({ since: opts.since, until: opts.until });
        }
        if (opts.level) {
          params['level'] = opts.level;
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

        const data = (response.data ?? []).map((row) => ({
          ...(row.campaign_id && { campaign_id: row.campaign_id }),
          ...(row.campaign_name && { campaign_name: row.campaign_name }),
          ...(row.adset_id && { adset_id: row.adset_id }),
          ...(row.adset_name && { adset_name: row.adset_name }),
          ...(row.ad_id && { ad_id: row.ad_id }),
          ...(row.ad_name && { ad_name: row.ad_name }),
          impressions: row.impressions,
          clicks: row.clicks,
          spend: row.spend,
          cpc: row.cpc ?? '',
          cpm: row.cpm ?? '',
          ctr: row.ctr ?? '',
          reach: row.reach ?? '',
          frequency: row.frequency ?? '',
          date_start: row.date_start,
          date_stop: row.date_stop,
        }));

        printOutput(data, opts.output);
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
