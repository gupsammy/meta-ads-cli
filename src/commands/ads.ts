import { Command, Option } from 'commander';
import { requireAccessToken, requireAccountId } from '../auth.js';
import { paginateAll, graphRequestWithRetry, HttpError } from '../lib/http.js';
import { printListOutput, printOutput, printError, confirmAction, type OutputFormat, EXIT_RUNTIME, EXIT_USAGE } from '../lib/output.js';

interface Ad {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  adset_id: string;
  campaign_id: string;
  creative?: { id: string; title?: string; body?: string; image_url?: string; thumbnail_url?: string };
  created_time: string;
  updated_time: string;
}

const AD_FIELDS = 'id,name,status,effective_status,adset_id,campaign_id,creative{id,title,body,image_url,thumbnail_url},created_time,updated_time';

const DESTRUCTIVE_STATUSES = ['PAUSED', 'DELETED', 'ARCHIVED'];

export function registerAdsCommands(program: Command): void {
  const ads = program.command('ads').description('Manage ads');

  ads
    .command('list')
    .description('List ads for an ad account')
    .option('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .option('--adset-id <id>', 'Filter by ad set ID')
    .option('--campaign-id <id>', 'Filter by campaign ID')
    .option('--status <status>', 'Filter by effective status (ACTIVE, PAUSED, DELETED, ARCHIVED)')
    .option('--limit <n>', 'Maximum number of ads to return')
    .option('--after <cursor>', 'Pagination cursor')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      accountId?: string;
      adsetId?: string;
      campaignId?: string;
      status?: string;
      limit?: string;
      after?: string;
      accessToken?: string;
      output: OutputFormat;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const accountId = requireAccountId(opts.accountId);
        const params: Record<string, string> = { fields: AD_FIELDS };
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

        const limit = opts.limit ? parseInt(opts.limit, 10) : 50;

        if (opts.verbose) console.error(`GET /${accountId}/ads`);

        const result = await paginateAll<Ad>(
          `/${accountId}/ads`,
          token,
          { params },
          limit,
        );

        const data = result.data.map((a) => ({
          id: a.id,
          name: a.name,
          adset_id: a.adset_id,
          campaign_id: a.campaign_id,
          status: a.status,
          effective_status: a.effective_status,
          creative_id: a.creative?.id ?? '',
          creative_title: a.creative?.title ?? '',
          creative_body: a.creative?.body ?? '',
          creative_image_url: a.creative?.image_url ?? '',
          creative_thumbnail_url: a.creative?.thumbnail_url ?? '',
          created_time: a.created_time,
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

  ads
    .command('get')
    .description('Get details for a specific ad')
    .requiredOption('--ad-id <id>', 'Ad ID')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      adId: string;
      accessToken?: string;
      output: OutputFormat;
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
            creative_title: ad.creative?.title ?? '',
            creative_body: ad.creative?.body ?? '',
            creative_image_url: ad.creative?.image_url ?? '',
            creative_thumbnail_url: ad.creative?.thumbnail_url ?? '',
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
        process.exit(EXIT_RUNTIME);
      }
    });

  ads
    .command('update')
    .description('Update an existing ad')
    .requiredOption('--ad-id <id>', 'Ad ID')
    .option('--name <name>', 'New ad name')
    .option('--status <status>', 'New status (ACTIVE, PAUSED, DELETED, ARCHIVED)')
    .option('--force', 'Skip confirmation for destructive status changes')
    .option('--dry-run', 'Show the request that would be made without executing it')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      adId: string;
      name?: string;
      status?: string;
      force?: boolean;
      dryRun?: boolean;
      accessToken?: string;
      output: OutputFormat;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);

        const body: Record<string, unknown> = {};
        if (opts.name) body['name'] = opts.name;
        if (opts.status) body['status'] = opts.status;

        if (Object.keys(body).length === 0) {
          printError({ code: 'USAGE', message: 'No update fields specified. Use --name or --status.' }, opts.output);
          process.exit(EXIT_USAGE);
        }

        if (opts.status && DESTRUCTIVE_STATUSES.includes(opts.status) && !opts.dryRun) {
          const confirmed = await confirmAction(`Change ad ${opts.adId} status to ${opts.status}?`, opts.force);
          if (!confirmed) {
            if (!process.stdin.isTTY) {
              printError({
                code: 'USAGE',
                message: 'Destructive status change requires --force in non-interactive mode.',
                hint: `meta-ads ads update --ad-id ${opts.adId} --status ${opts.status} --force`,
              }, opts.output);
            } else {
              console.error('Aborted.');
            }
            process.exit(EXIT_USAGE);
          }
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
        process.exit(EXIT_RUNTIME);
      }
    });
}
