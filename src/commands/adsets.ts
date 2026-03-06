import { Command, Option } from 'commander';
import { requireAccessToken } from '../auth.js';
import { HttpError } from '../lib/http.js';
import { printListOutput, printOutput, printError, confirmAction, type OutputFormat, EXIT_RUNTIME, EXIT_USAGE } from '../lib/output.js';
import { listAdSets, getAdSet, createAdSet, updateAdSet, dryRunCreateAdSet, dryRunUpdateAdSet, buildUpdateAdSetBody } from '../services/adsets.js';

const DESTRUCTIVE_STATUSES = ['PAUSED', 'DELETED', 'ARCHIVED'];

export function registerAdsetsCommands(program: Command): void {
  const adsets = program.command('adsets').description('Manage ad sets');

  adsets
    .command('list')
    .description('List ad sets for an ad account')
    .requiredOption('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .option('--campaign-id <id>', 'Filter by campaign ID')
    .option('--status <status>', 'Filter by effective status (ACTIVE, PAUSED, DELETED, ARCHIVED)')
    .option('--limit <n>', 'Maximum number of ad sets to return')
    .option('--after <cursor>', 'Pagination cursor')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      accountId: string;
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

        if (opts.verbose) console.error(`GET /${opts.accountId}/adsets`);

        const result = await listAdSets(token, {
          accountId: opts.accountId,
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

  adsets
    .command('get')
    .description('Get details for a specific ad set')
    .requiredOption('--adset-id <id>', 'Ad set ID')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      adsetId: string;
      accessToken?: string;
      output: OutputFormat;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);

        if (opts.verbose) console.error(`GET /${opts.adsetId}`);

        const adset = await getAdSet(token, opts.adsetId);
        printOutput(adset, opts.output);
      } catch (error) {
        if (error instanceof HttpError) {
          printError({ code: error.code, message: error.message, retry_after: error.retryAfter }, opts.output);
        } else {
          printError({ code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }, opts.output);
        }
        process.exit(EXIT_RUNTIME);
      }
    });

  adsets
    .command('create')
    .description('Create a new ad set')
    .requiredOption('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .requiredOption('--campaign-id <id>', 'Campaign ID')
    .requiredOption('--name <name>', 'Ad set name')
    .requiredOption('--billing-event <event>', 'Billing event (IMPRESSIONS, LINK_CLICKS, APP_INSTALLS, PAGE_LIKES)')
    .requiredOption('--optimization-goal <goal>', 'Optimization goal (REACH, IMPRESSIONS, LINK_CLICKS, LANDING_PAGE_VIEWS, LEAD_GENERATION, CONVERSIONS)')
    .option('--daily-budget <amount>', 'Daily budget in cents')
    .option('--lifetime-budget <amount>', 'Lifetime budget in cents')
    .option('--bid-amount <amount>', 'Bid amount in cents')
    .option('--targeting <json>', 'Targeting spec as JSON string')
    .option('--start-time <time>', 'Start time (ISO 8601)')
    .option('--end-time <time>', 'End time (ISO 8601)')
    .option('--status <status>', 'Status (ACTIVE, PAUSED)', 'PAUSED')
    .option('--dry-run', 'Show the request that would be made without executing it')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      accountId: string;
      campaignId: string;
      name: string;
      billingEvent: string;
      optimizationGoal: string;
      dailyBudget?: string;
      lifetimeBudget?: string;
      bidAmount?: string;
      targeting?: string;
      startTime?: string;
      endTime?: string;
      status?: string;
      dryRun?: boolean;
      accessToken?: string;
      output: OutputFormat;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);

        let targeting: Record<string, unknown> | undefined;
        if (opts.targeting) {
          try {
            targeting = JSON.parse(opts.targeting);
          } catch {
            printError({ code: 'USAGE', message: 'Invalid targeting JSON. Provide a valid JSON string.' }, opts.output);
            process.exit(EXIT_USAGE);
          }
        }

        const serviceOpts = {
          accountId: opts.accountId,
          campaignId: opts.campaignId,
          name: opts.name,
          billingEvent: opts.billingEvent,
          optimizationGoal: opts.optimizationGoal,
          dailyBudget: opts.dailyBudget,
          lifetimeBudget: opts.lifetimeBudget,
          bidAmount: opts.bidAmount,
          targeting,
          startTime: opts.startTime,
          endTime: opts.endTime,
          status: opts.status,
        };

        if (opts.dryRun) {
          printOutput(dryRunCreateAdSet(serviceOpts), opts.output);
          return;
        }

        if (opts.verbose) console.error(`POST /${opts.accountId}/adsets`);

        const result = await createAdSet(token, serviceOpts);
        printOutput(result, opts.output);
      } catch (error) {
        if (error instanceof HttpError) {
          printError({ code: error.code, message: error.message, retry_after: error.retryAfter }, opts.output);
        } else {
          printError({ code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }, opts.output);
        }
        process.exit(EXIT_RUNTIME);
      }
    });

  adsets
    .command('update')
    .description('Update an existing ad set')
    .requiredOption('--adset-id <id>', 'Ad set ID')
    .option('--name <name>', 'New ad set name')
    .option('--status <status>', 'New status (ACTIVE, PAUSED, DELETED, ARCHIVED)')
    .option('--daily-budget <amount>', 'New daily budget in cents')
    .option('--lifetime-budget <amount>', 'New lifetime budget in cents')
    .option('--bid-amount <amount>', 'New bid amount in cents')
    .option('--targeting <json>', 'New targeting spec as JSON string')
    .option('--force', 'Skip confirmation for destructive status changes')
    .option('--dry-run', 'Show the request that would be made without executing it')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      adsetId: string;
      name?: string;
      status?: string;
      dailyBudget?: string;
      lifetimeBudget?: string;
      bidAmount?: string;
      targeting?: string;
      force?: boolean;
      dryRun?: boolean;
      accessToken?: string;
      output: OutputFormat;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);

        let targeting: Record<string, unknown> | undefined;
        if (opts.targeting) {
          try {
            targeting = JSON.parse(opts.targeting);
          } catch {
            printError({ code: 'USAGE', message: 'Invalid targeting JSON.' }, opts.output);
            process.exit(EXIT_USAGE);
          }
        }

        const serviceOpts = {
          adsetId: opts.adsetId,
          name: opts.name,
          status: opts.status,
          dailyBudget: opts.dailyBudget,
          lifetimeBudget: opts.lifetimeBudget,
          bidAmount: opts.bidAmount,
          targeting,
        };

        const body = buildUpdateAdSetBody(serviceOpts);
        if (Object.keys(body).length === 0) {
          printError({ code: 'USAGE', message: 'No update fields specified.' }, opts.output);
          process.exit(EXIT_USAGE);
        }

        if (opts.status && DESTRUCTIVE_STATUSES.includes(opts.status) && !opts.dryRun) {
          const confirmed = await confirmAction(`Change adset ${opts.adsetId} status to ${opts.status}?`, opts.force);
          if (!confirmed) {
            if (!process.stdin.isTTY) {
              printError({
                code: 'USAGE',
                message: 'Destructive status change requires --force in non-interactive mode.',
                hint: `meta-ads adsets update --adset-id ${opts.adsetId} --status ${opts.status} --force`,
              }, opts.output);
            } else {
              console.error('Aborted.');
            }
            process.exit(EXIT_USAGE);
          }
        }

        if (opts.dryRun) {
          printOutput(dryRunUpdateAdSet(serviceOpts), opts.output);
          return;
        }

        if (opts.verbose) console.error(`POST /${opts.adsetId}`);

        const result = await updateAdSet(token, serviceOpts);
        printOutput({ adset_id: result.id, updated: result.updated, changes: result.changes }, opts.output);
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
