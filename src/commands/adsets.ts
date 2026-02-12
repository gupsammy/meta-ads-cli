import { Command } from 'commander';
import { requireAccessToken } from '../auth.js';
import { graphRequestWithRetry, type GraphApiResponse, HttpError } from '../lib/http.js';
import { printOutput, printError, type OutputFormat } from '../lib/output.js';

interface AdSet {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  campaign_id: string;
  daily_budget?: string;
  lifetime_budget?: string;
  billing_event: string;
  optimization_goal: string;
  bid_amount?: string;
  targeting?: Record<string, unknown>;
  created_time: string;
  updated_time: string;
  start_time?: string;
  end_time?: string;
}

const ADSET_FIELDS = 'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,billing_event,optimization_goal,bid_amount,created_time,updated_time,start_time,end_time';

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
    .option('-o, --output <format>', 'Output format (json, table, csv)', 'json')
    .option('-q, --quiet', 'Suppress non-essential output')
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      accountId: string;
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
        const params: Record<string, string> = { fields: ADSET_FIELDS };
        if (opts.limit) params['limit'] = opts.limit;
        if (opts.after) params['after'] = opts.after;

        const filtering: Array<{ field: string; operator: string; value: string[] }> = [];
        if (opts.status) {
          filtering.push({ field: 'effective_status', operator: 'IN', value: [opts.status] });
        }
        if (opts.campaignId) {
          filtering.push({ field: 'campaign_id', operator: 'EQUAL', value: [opts.campaignId] });
        }
        if (filtering.length > 0) {
          params['filtering'] = JSON.stringify(filtering);
        }

        if (opts.verbose) console.error(`GET /${accountId}/adsets`);

        const response = await graphRequestWithRetry<GraphApiResponse<AdSet>>(
          `/${accountId}/adsets`,
          token,
          { params },
        );

        const data = (response.data ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          campaign_id: a.campaign_id,
          status: a.status,
          effective_status: a.effective_status,
          billing_event: a.billing_event,
          optimization_goal: a.optimization_goal,
          daily_budget: a.daily_budget ?? '',
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

  adsets
    .command('get')
    .description('Get details for a specific ad set')
    .requiredOption('--adset-id <id>', 'Ad set ID')
    .option('--access-token <token>', 'Access token')
    .option('-o, --output <format>', 'Output format (json, table, csv)', 'json')
    .option('-q, --quiet', 'Suppress non-essential output')
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      adsetId: string;
      accessToken?: string;
      output: OutputFormat;
      quiet?: boolean;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const fields = ADSET_FIELDS + ',targeting';
        const params: Record<string, string> = { fields };

        if (opts.verbose) console.error(`GET /${opts.adsetId}`);

        const adset = await graphRequestWithRetry<AdSet>(`/${opts.adsetId}`, token, { params });

        printOutput(
          {
            id: adset.id,
            name: adset.name,
            campaign_id: adset.campaign_id,
            status: adset.status,
            effective_status: adset.effective_status,
            billing_event: adset.billing_event,
            optimization_goal: adset.optimization_goal,
            daily_budget: adset.daily_budget ?? '',
            lifetime_budget: adset.lifetime_budget ?? '',
            bid_amount: adset.bid_amount ?? '',
            targeting: adset.targeting ? JSON.stringify(adset.targeting) : '',
            created_time: adset.created_time,
            updated_time: adset.updated_time,
            start_time: adset.start_time ?? '',
            end_time: adset.end_time ?? '',
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
    .option('-o, --output <format>', 'Output format (json, table, csv)', 'json')
    .option('-q, --quiet', 'Suppress non-essential output')
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
      quiet?: boolean;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const accountId = opts.accountId.startsWith('act_') ? opts.accountId : `act_${opts.accountId}`;

        const body: Record<string, unknown> = {
          campaign_id: opts.campaignId,
          name: opts.name,
          billing_event: opts.billingEvent,
          optimization_goal: opts.optimizationGoal,
          status: opts.status ?? 'PAUSED',
        };

        if (opts.dailyBudget) body['daily_budget'] = opts.dailyBudget;
        if (opts.lifetimeBudget) body['lifetime_budget'] = opts.lifetimeBudget;
        if (opts.bidAmount) body['bid_amount'] = opts.bidAmount;
        if (opts.targeting) {
          try {
            body['targeting'] = JSON.parse(opts.targeting);
          } catch {
            console.error('Invalid targeting JSON. Provide a valid JSON string.');
            process.exit(1);
          }
        }
        if (opts.startTime) body['start_time'] = opts.startTime;
        if (opts.endTime) body['end_time'] = opts.endTime;

        if (opts.dryRun) {
          printOutput({ dry_run: true, method: 'POST', path: `/${accountId}/adsets`, body }, opts.output);
          return;
        }

        if (opts.verbose) console.error(`POST /${accountId}/adsets`);

        const result = await graphRequestWithRetry<{ id: string }>(
          `/${accountId}/adsets`,
          token,
          { method: 'POST', body },
        );

        printOutput({ id: result.id, name: opts.name, campaign_id: opts.campaignId, status: opts.status ?? 'PAUSED' }, opts.output);
      } catch (error) {
        if (error instanceof HttpError) {
          printError({ code: error.code, message: error.message, retry_after: error.retryAfter }, opts.output);
        } else {
          printError({ code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }, opts.output);
        }
        process.exit(1);
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
    .option('--dry-run', 'Show the request that would be made without executing it')
    .option('--access-token <token>', 'Access token')
    .option('-o, --output <format>', 'Output format (json, table, csv)', 'json')
    .option('-q, --quiet', 'Suppress non-essential output')
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      adsetId: string;
      name?: string;
      status?: string;
      dailyBudget?: string;
      lifetimeBudget?: string;
      bidAmount?: string;
      targeting?: string;
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
        if (opts.dailyBudget) body['daily_budget'] = opts.dailyBudget;
        if (opts.lifetimeBudget) body['lifetime_budget'] = opts.lifetimeBudget;
        if (opts.bidAmount) body['bid_amount'] = opts.bidAmount;
        if (opts.targeting) {
          try {
            body['targeting'] = JSON.parse(opts.targeting);
          } catch {
            console.error('Invalid targeting JSON.');
            process.exit(1);
          }
        }

        if (Object.keys(body).length === 0) {
          console.error('No update fields specified.');
          process.exit(1);
        }

        if (opts.dryRun) {
          printOutput({ dry_run: true, method: 'POST', path: `/${opts.adsetId}`, body }, opts.output);
          return;
        }

        if (opts.verbose) console.error(`POST /${opts.adsetId}`);

        const result = await graphRequestWithRetry<{ success: boolean }>(
          `/${opts.adsetId}`,
          token,
          { method: 'POST', body },
        );

        printOutput({ adset_id: opts.adsetId, updated: result.success ?? true, changes: body }, opts.output);
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
