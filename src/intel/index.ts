import { Command, Option } from 'commander';
import { requireAccessToken, requireAccountId } from '../auth.js';
import { printOutput, printError, handleCommandError, EXIT_USAGE, type OutputFormat } from '../lib/output.js';
import { computeDefaults } from './defaults.js';
import { creativeScan } from './scan.js';
import { run } from './run.js';
import { fetchDaily } from './fetch-daily.js';

export function registerIntelCommands(program: Command): void {
  const intel = program
    .command('intel', { hidden: true })
    .description('Analysis pipeline for Meta Ads Intel skill');

  intel
    .command('run')
    .description('Run full analysis pipeline')
    .argument('[date-preset]', 'Date preset (last_7d, last_14d, last_30d)', 'last_14d')
    .option('--access-token <token>', 'Access token')
    .option('--keep-video', 'Retain each ad\'s source video (audio+motion), not just extracted frames')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('json'))
    .action(async (datePreset: string, opts: { accessToken?: string; keepVideo?: boolean; output: OutputFormat }) => {
      try {
        const result = await run({ datePreset, accessToken: opts.accessToken, keepVideo: opts.keepVideo });
        printOutput({
          run_dir: result.runDir,
          ...result.pipelineStatus,
          ...(result.creatives ? { creatives: { total_ads: result.creatives.total_ads, total_frames: result.creatives.total_frames } } : {}),
        } as unknown as Record<string, unknown>, opts.output);
      } catch (error) {
        handleCommandError(error, opts.output);
      }
    });

  intel
    .command('defaults')
    .description('Compute target defaults from current performance')
    .option('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('json'))
    .action(async (opts: { accountId?: string; accessToken?: string; output: OutputFormat }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const accountId = requireAccountId(opts.accountId);
        const result = await computeDefaults(accountId, token);
        printOutput(result as unknown as Record<string, unknown>, opts.output);
      } catch (error) {
        handleCommandError(error, opts.output);
      }
    });

  intel
    .command('scan')
    .description('Creative scan for onboarding')
    .option('--account-id <id>', 'Ad account ID (e.g., act_123456)')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('json'))
    .action(async (opts: { accountId?: string; accessToken?: string; output: OutputFormat }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const accountId = requireAccountId(opts.accountId);
        const result = await creativeScan(accountId, token);
        printOutput(result as unknown as Record<string, unknown>, opts.output);
      } catch (error) {
        handleCommandError(error, opts.output);
      }
    });

  intel
    .command('fetch-daily')
    .description('Scriptable ad×daily metrics pull for a date range (backfill / catch-up)')
    .option('--since <date>', 'Start date (YYYY-MM-DD)')
    .option('--until <date>', 'End date (YYYY-MM-DD)')
    .option('--keep-video', 'Also retain each current ad\'s source video (audio+motion) for tagging')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('json'))
    .action(async (opts: { since?: string; until?: string; keepVideo?: boolean; accessToken?: string; output: OutputFormat }) => {
      // Boundary validation → usage errors (exit 2), mirroring `insights get`.
      if (!opts.since || !opts.until) {
        printError({ code: 'USAGE', message: '--since and --until are both required (YYYY-MM-DD)' }, opts.output);
        process.exit(EXIT_USAGE);
      }
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRe.test(opts.since) || !dateRe.test(opts.until)) {
        printError({ code: 'USAGE', message: '--since and --until must be YYYY-MM-DD' }, opts.output);
        process.exit(EXIT_USAGE);
      }
      if (opts.since > opts.until) {
        printError({ code: 'USAGE', message: '--since must be on or before --until' }, opts.output);
        process.exit(EXIT_USAGE);
      }
      try {
        const result = await fetchDaily({ since: opts.since, until: opts.until, keepVideo: opts.keepVideo, accessToken: opts.accessToken });
        printOutput(result as unknown as Record<string, unknown>, opts.output);
      } catch (error) {
        handleCommandError(error, opts.output);
      }
    });
}
