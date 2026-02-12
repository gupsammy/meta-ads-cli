import { Command } from 'commander';
import { requireAccessToken } from '../auth.js';
import { graphRequestWithRetry, type GraphApiResponse, HttpError } from '../lib/http.js';
import { printOutput, printError, type OutputFormat } from '../lib/output.js';

interface Ad {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  adset_id: string;
  campaign_id: string;
  creative?: { id: string };
  created_time: string;
  updated_time: string;
}

const AD_FIELDS = 'id,name,status,effective_status,adset_id,campaign_id,creative{id},created_time,updated_time';

export function registerAdsCommands(program: Command): void {
  const ads = program.command('ads').description('Manage ads');

  ads
    .command('list')
    .description('List ads for an ad account')
    .requiredOption('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .option('--adset-id <id>', 'Filter by ad set ID')
    .option('--campaign-id <id>', 'Filter by campaign ID')
    .option('--status <status>', 'Filter by effective status (ACTIVE, PAUSED, DELETED, ARCHIVED)')
    .option('--limit <n>', 'Maximum number of ads to return')
    .option('--after <cursor>', 'Pagination cursor')
    .option('--access-token <token>', 'Access token')
    .option('-o, --output <format>', 'Output format (json, table, csv)', 'json')
    .option('-q, --quiet', 'Suppress non-essential output')
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      accountId: string;
      adsetId?: string;
      campaignId?: string;
      status?: string;
      limit?: string;
      after?: string;
      accessToken?: string;
      output: OutputFormat;
      quiet?: boolean;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const accountId = opts.accountId.startsWith('act_') ? opts.accountId : `act_${opts.accountId}`;
        const params: Record<string, string> = { fields: AD_FIELDS };
        if (opts.limit) params['limit'] = opts.limit;
        if (opts.after) params['after'] = opts.after;

        const filtering: Array<{ field: string; operator: string; value: string[] }> = [];
        if (opts.status) {
          filtering.push({ field: 'effective_status', operator: 'IN', value: [opts.status] });
        }
        if (opts.adsetId) {
          filtering.push({ field: 'adset_id', operator: 'EQUAL', value: [opts.adsetId] });
        }
        if (opts.campaignId) {
          filtering.push({ field: 'campaign_id', operator: 'EQUAL', value: [opts.campaignId] });
        }
        if (filtering.length > 0) {
          params['filtering'] = JSON.stringify(filtering);
        }

        if (opts.verbose) console.error(`GET /${accountId}/ads`);

        const response = await graphRequestWithRetry<GraphApiResponse<Ad>>(
          `/${accountId}/ads`,
          token,
          { params },
        );

        const data = (response.data ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          adset_id: a.adset_id,
          campaign_id: a.campaign_id,
          status: a.status,
          effective_status: a.effective_status,
          creative_id: a.creative?.id ?? '',
          created_time: a.created_time,
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

  ads
    .command('get')
    .description('Get details for a specific ad')
    .requiredOption('--ad-id <id>', 'Ad ID')
    .option('--access-token <token>', 'Access token')
    .option('-o, --output <format>', 'Output format (json, table, csv)', 'json')
    .option('-q, --quiet', 'Suppress non-essential output')
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      adId: string;
      accessToken?: string;
      output: OutputFormat;
      quiet?: boolean;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const params: Record<string, string> = { fields: AD_FIELDS };

        if (opts.verbose) console.error(`GET /${opts.adId}`);

        const ad = await graphRequestWithRetry<Ad>(`/${opts.adId}`, token, { params });

        printOutput(
          {
            id: ad.id,
            name: ad.name,
            adset_id: ad.adset_id,
            campaign_id: ad.campaign_id,
            status: ad.status,
            effective_status: ad.effective_status,
            creative_id: ad.creative?.id ?? '',
            created_time: ad.created_time,
            updated_time: ad.updated_time,
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

  ads
    .command('update')
    .description('Update an existing ad')
    .requiredOption('--ad-id <id>', 'Ad ID')
    .option('--name <name>', 'New ad name')
    .option('--status <status>', 'New status (ACTIVE, PAUSED, DELETED, ARCHIVED)')
    .option('--dry-run', 'Show the request that would be made without executing it')
    .option('--access-token <token>', 'Access token')
    .option('-o, --output <format>', 'Output format (json, table, csv)', 'json')
    .option('-q, --quiet', 'Suppress non-essential output')
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      adId: string;
      name?: string;
      status?: string;
      dryRun?: boolean;
      accessToken?: string;
      output: OutputFormat;
      quiet?: boolean;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);

        const body: Record<string, unknown> = {};
        if (opts.name) body['name'] = opts.name;
        if (opts.status) body['status'] = opts.status;

        if (Object.keys(body).length === 0) {
          console.error('No update fields specified. Use --name or --status.');
          process.exit(1);
        }

        if (opts.dryRun) {
          printOutput({ dry_run: true, method: 'POST', path: `/${opts.adId}`, body }, opts.output);
          return;
        }

        if (opts.verbose) console.error(`POST /${opts.adId}`);

        const result = await graphRequestWithRetry<{ success: boolean }>(
          `/${opts.adId}`,
          token,
          { method: 'POST', body },
        );

        printOutput({ ad_id: opts.adId, updated: result.success ?? true, changes: body }, opts.output);
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
