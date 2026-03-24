import { Command, Option } from 'commander';
import { requireAccessToken, requireAccountId } from '../auth.js';
import { printOutput, handleCommandError, type OutputFormat } from '../lib/output.js';
import { computeDefaults } from './defaults.js';
import { creativeScan } from './scan.js';
import { pull } from './pull.js';

export function registerIntelCommands(program: Command): void {
  const intel = program
    .command('intel', { hidden: true })
    .description('Analysis pipeline for Meta Ads Intel skill');

  intel
    .command('run')
    .description('Run full analysis pipeline')
    .argument('[date-preset]', 'Date preset (last_7d, last_14d, last_30d)', 'last_14d')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('json'))
    .action(async (datePreset: string, opts: { accessToken?: string; output: OutputFormat }) => {
      try {
        const result = await pull({ datePreset, accessToken: opts.accessToken });
        printOutput({ run_dir: result.runDir, ...result.pipelineStatus } as unknown as Record<string, unknown>, opts.output);
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
}
