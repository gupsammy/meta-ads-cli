import { Command, Option } from 'commander';
import { requireAccessToken } from '../auth.js';
import { printOutput, printError, handleCommandError, type OutputFormat, EXIT_RUNTIME } from '../lib/output.js';
import { computeDefaults } from './defaults.js';
import { creativeScan } from './scan.js';

export function registerIntelCommands(program: Command): void {
  const intel = program
    .command('intel', { hidden: true })
    .description('Analysis pipeline for Meta Ads Intel skill');

  intel
    .command('run')
    .description('Run full analysis pipeline')
    .argument('[date-preset]', 'Date preset (last_7d, last_14d, last_30d)', 'last_14d')
    .action(async (_datePreset: string) => {
      printError({ code: 'NOT_IMPLEMENTED', message: 'intel run: not yet implemented', hint: 'This command is under development' }, 'json');
      process.exit(EXIT_RUNTIME);
    });

  intel
    .command('defaults')
    .description('Compute target defaults from current performance')
    .requiredOption('--account-id <id>', 'Ad account ID')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('json'))
    .action(async (opts: { accountId: string; accessToken?: string; output: OutputFormat }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const result = await computeDefaults(opts.accountId, token);
        printOutput(result as unknown as Record<string, unknown>, opts.output);
      } catch (error) {
        handleCommandError(error, opts.output);
      }
    });

  intel
    .command('scan')
    .description('Creative scan for onboarding')
    .requiredOption('--account-id <id>', 'Ad account ID')
    .option('--access-token <token>', 'Access token')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('json'))
    .action(async (opts: { accountId: string; accessToken?: string; output: OutputFormat }) => {
      try {
        const token = requireAccessToken(opts.accessToken);
        const result = await creativeScan(opts.accountId, token);
        printOutput(result as unknown as Record<string, unknown>, opts.output);
      } catch (error) {
        handleCommandError(error, opts.output);
      }
    });
}
