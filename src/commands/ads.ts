import { Command, Option } from 'commander';
import { requireAccessToken } from '../auth.js';
import { HttpError } from '../lib/http.js';
import { printListOutput, printOutput, printError, confirmAction, type OutputFormat, EXIT_RUNTIME, EXIT_USAGE } from '../lib/output.js';
import { listAds, getAd, updateAd, dryRunUpdateAd, buildUpdateAdBody } from '../services/ads.js';

const DESTRUCTIVE_STATUSES = ['PAUSED', 'DELETED', 'ARCHIVED'];

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
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
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
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;

        if (opts.verbose) console.error(`GET /${opts.accountId}/ads`);

        const result = await listAds(token, {
          accountId: opts.accountId,
          adsetId: opts.adsetId,
          campaignId: opts.campaignId,
          status: opts.status,
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

        if (opts.verbose) console.error(`GET /${opts.adId}`);

        const ad = await getAd(token, opts.adId);
        printOutput(ad, opts.output);
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

        const serviceOpts = {
          adId: opts.adId,
          name: opts.name,
          status: opts.status,
        };

        const body = buildUpdateAdBody(serviceOpts);
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
          printOutput(dryRunUpdateAd(serviceOpts), opts.output);
          return;
        }

        if (opts.verbose) console.error(`POST /${opts.adId}`);

        const result = await updateAd(token, serviceOpts);
        printOutput({ ad_id: result.id, updated: result.updated, changes: result.changes }, opts.output);
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
