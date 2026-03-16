import { Command, Option } from 'commander';
import { requireAccessToken, requireAccountId } from '../auth.js';
import { paginateAll, graphRequestWithRetry, HttpError } from '../lib/http.js';
import { printListOutput, printOutput, printError, confirmAction, type OutputFormat, EXIT_RUNTIME, EXIT_USAGE } from '../lib/output.js';

interface Campaign {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  objective: string;
  daily_budget?: string;
  lifetime_budget?: string;
  created_time: string;
  updated_time: string;
  start_time?: string;
  stop_time?: string;
}

const CAMPAIGN_FIELDS = 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,updated_time,start_time,stop_time';

const DESTRUCTIVE_STATUSES = ['PAUSED', 'DELETED', 'ARCHIVED'];

export function registerCampaignsCommands(program: Command): void {
  const campaigns = program.command('campaigns').description('Manage ad campaigns');

  campaigns
    .command('list')
    .description('List campaigns for an ad account')
    .option('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .option('--status <status>', 'Filter by status (ACTIVE, PAUSED, DELETED, ARCHIVED)')
    .option('--limit <n>', 'Maximum number of campaigns to return')
    .option('--after <cursor>', 'Pagination cursor')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .addHelpText('after', `
Examples:
  $ meta-ads campaigns list --account-id act_123456
  $ meta-ads campaigns list --account-id act_123456 --status ACTIVE -o json
  $ meta-ads campaigns list --account-id act_123456 --limit 10 --after <cursor>
`)
    .action(async (opts: {
      accountId?: string;
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
        const params: Record<string, string> = { fields: CAMPAIGN_FIELDS };
        if (opts.after) params['after'] = opts.after;
        if (opts.status) {
          params['filtering'] = JSON.stringify([
            { field: 'effective_status', operator: 'IN', value: [opts.status] },
          ]);
        }

        const limit = opts.limit ? parseInt(opts.limit, 10) : 50;

        if (opts.verbose) console.error(`GET /${accountId}/campaigns`);

        const result = await paginateAll<Campaign>(
          `/${accountId}/campaigns`,
          token,
          { params },
          limit,
        );

        const data = result.data.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          effective_status: c.effective_status,
          objective: c.objective,
          daily_budget: c.daily_budget ?? '',
          lifetime_budget: c.lifetime_budget ?? '',
          created_time: c.created_time,
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

  campaigns
    .command('get')
    .description('Get details for a specific campaign')
    .requiredOption('--campaign-id <id>', 'Campaign ID')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      campaignId: string;
      accessToken?: string;
      output: OutputFormat;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const params: Record<string, string> = { fields: CAMPAIGN_FIELDS };

        if (opts.verbose) console.error(`GET /${opts.campaignId}`);

        const campaign = await graphRequestWithRetry<Campaign>(`/${opts.campaignId}`, token, { params });

        printOutput(
          {
            id: campaign.id,
            name: campaign.name,
            status: campaign.status,
            effective_status: campaign.effective_status,
            objective: campaign.objective,
            daily_budget: campaign.daily_budget ?? '',
            lifetime_budget: campaign.lifetime_budget ?? '',
            created_time: campaign.created_time,
            updated_time: campaign.updated_time,
            start_time: campaign.start_time ?? '',
            stop_time: campaign.stop_time ?? '',
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

  campaigns
    .command('create')
    .description('Create a new campaign')
    .option('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .requiredOption('--name <name>', 'Campaign name')
    .requiredOption('--objective <objective>', 'Campaign objective (OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_APP_PROMOTION, OUTCOME_SALES)')
    .option('--status <status>', 'Campaign status (ACTIVE, PAUSED)', 'PAUSED')
    .option('--daily-budget <amount>', 'Daily budget in cents (e.g., 1000 = $10.00)')
    .option('--lifetime-budget <amount>', 'Lifetime budget in cents')
    .option('--special-ad-categories <categories>', 'Special ad categories (comma-separated: CREDIT, EMPLOYMENT, HOUSING, ISSUES_ELECTIONS_POLITICS)', '')
    .option('--dry-run', 'Show the request that would be made without executing it')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (opts: {
      accountId?: string;
      name: string;
      objective: string;
      status?: string;
      dailyBudget?: string;
      lifetimeBudget?: string;
      specialAdCategories?: string;
      dryRun?: boolean;
      accessToken?: string;
      output: OutputFormat;
      verbose?: boolean;
    }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const accountId = requireAccountId(opts.accountId);

        const body: Record<string, unknown> = {
          name: opts.name,
          objective: opts.objective,
          status: opts.status ?? 'PAUSED',
          special_ad_categories: opts.specialAdCategories
            ? opts.specialAdCategories.split(',').map((s) => s.trim())
            : [],
        };

        if (opts.dailyBudget) body['daily_budget'] = opts.dailyBudget;
        if (opts.lifetimeBudget) body['lifetime_budget'] = opts.lifetimeBudget;

        if (opts.dryRun) {
          printOutput({ dry_run: true, method: 'POST', path: `/${accountId}/campaigns`, body }, opts.output);
          return;
        }

        if (opts.verbose) console.error(`POST /${accountId}/campaigns`);

        const result = await graphRequestWithRetry<{ id: string }>(
          `/${accountId}/campaigns`,
          token,
          { method: 'POST', body },
        );

        printOutput({ id: result.id, name: opts.name, status: opts.status ?? 'PAUSED', objective: opts.objective }, opts.output);
      } catch (error) {
        if (error instanceof HttpError) {
          printError({ code: error.code, message: error.message, retry_after: error.retryAfter }, opts.output);
        } else {
          printError({ code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }, opts.output);
        }
        process.exit(EXIT_RUNTIME);
      }
    });

  campaigns
    .command('update')
    .description('Update an existing campaign')
    .requiredOption('--campaign-id <id>', 'Campaign ID')
    .option('--name <name>', 'New campaign name')
    .option('--status <status>', 'New status (ACTIVE, PAUSED, DELETED, ARCHIVED)')
    .option('--daily-budget <amount>', 'New daily budget in cents')
    .option('--lifetime-budget <amount>', 'New lifetime budget in cents')
    .option('--force', 'Skip confirmation for destructive status changes')
    .option('--dry-run', 'Show the request that would be made without executing it')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .option('-v, --verbose', 'Enable verbose output')
    .addHelpText('after', `
Examples:
  $ meta-ads campaigns update --campaign-id 123 --name "New Name"
  $ meta-ads campaigns update --campaign-id 123 --status PAUSED --dry-run
  $ meta-ads campaigns update --campaign-id 123 --status PAUSED --force
`)
    .action(async (opts: {
      campaignId: string;
      name?: string;
      status?: string;
      dailyBudget?: string;
      lifetimeBudget?: string;
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
        if (opts.dailyBudget) body['daily_budget'] = opts.dailyBudget;
        if (opts.lifetimeBudget) body['lifetime_budget'] = opts.lifetimeBudget;

        if (Object.keys(body).length === 0) {
          printError({ code: 'USAGE', message: 'No update fields specified. Use --name, --status, --daily-budget, or --lifetime-budget.' }, opts.output);
          process.exit(EXIT_USAGE);
        }

        if (opts.status && DESTRUCTIVE_STATUSES.includes(opts.status) && !opts.dryRun) {
          const confirmed = await confirmAction(`Change campaign ${opts.campaignId} status to ${opts.status}?`, opts.force);
          if (!confirmed) {
            if (!process.stdin.isTTY) {
              printError({
                code: 'USAGE',
                message: 'Destructive status change requires --force in non-interactive mode.',
                hint: `meta-ads campaigns update --campaign-id ${opts.campaignId} --status ${opts.status} --force`,
              }, opts.output);
            } else {
              console.error('Aborted.');
            }
            process.exit(EXIT_USAGE);
          }
        }

        if (opts.dryRun) {
          printOutput({ dry_run: true, method: 'POST', path: `/${opts.campaignId}`, body }, opts.output);
          return;
        }

        if (opts.verbose) console.error(`POST /${opts.campaignId}`);

        const result = await graphRequestWithRetry<{ success: boolean }>(
          `/${opts.campaignId}`,
          token,
          { method: 'POST', body },
        );

        printOutput({ campaign_id: opts.campaignId, updated: result.success ?? true, changes: body }, opts.output);
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
