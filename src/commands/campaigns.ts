import { Command, Option } from 'commander';
import { requireAccessToken } from '../auth.js';
import { HttpError } from '../lib/http.js';
import { printListOutput, printOutput, printError, confirmAction, type OutputFormat, EXIT_RUNTIME, EXIT_USAGE } from '../lib/output.js';
import { listCampaigns, getCampaign, createCampaign, updateCampaign, dryRunCreateCampaign, dryRunUpdateCampaign, buildUpdateCampaignBody } from '../services/campaigns.js';

const DESTRUCTIVE_STATUSES = ['PAUSED', 'DELETED', 'ARCHIVED'];

export function registerCampaignsCommands(program: Command): void {
  const campaigns = program.command('campaigns').description('Manage ad campaigns');

  campaigns
    .command('list')
    .description('List campaigns for an ad account')
    .requiredOption('--account-id <id>', 'Ad account ID (e.g., act_123456)')
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
      accountId: string;
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

        if (opts.verbose) console.error(`GET /${opts.accountId}/campaigns`);

        const result = await listCampaigns(token, {
          accountId: opts.accountId,
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

        if (opts.verbose) console.error(`GET /${opts.campaignId}`);

        const campaign = await getCampaign(token, opts.campaignId);
        printOutput(campaign, opts.output);
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
    .requiredOption('--account-id <id>', 'Ad account ID (e.g., act_123456)')
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
      accountId: string;
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

        const serviceOpts = {
          accountId: opts.accountId,
          name: opts.name,
          objective: opts.objective,
          status: opts.status,
          dailyBudget: opts.dailyBudget,
          lifetimeBudget: opts.lifetimeBudget,
          specialAdCategories: opts.specialAdCategories,
        };

        if (opts.dryRun) {
          printOutput(dryRunCreateCampaign(serviceOpts), opts.output);
          return;
        }

        if (opts.verbose) console.error(`POST /${opts.accountId}/campaigns`);

        const result = await createCampaign(token, serviceOpts);
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

        const serviceOpts = {
          campaignId: opts.campaignId,
          name: opts.name,
          status: opts.status,
          dailyBudget: opts.dailyBudget,
          lifetimeBudget: opts.lifetimeBudget,
        };

        const body = buildUpdateCampaignBody(serviceOpts);
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
          printOutput(dryRunUpdateCampaign(serviceOpts), opts.output);
          return;
        }

        if (opts.verbose) console.error(`POST /${opts.campaignId}`);

        const result = await updateCampaign(token, serviceOpts);
        printOutput({ campaign_id: result.id, updated: result.updated, changes: result.changes }, opts.output);
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
