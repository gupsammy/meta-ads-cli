import { Command } from 'commander';
import { printError, EXIT_RUNTIME } from '../lib/output.js';

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
    .action(async (_opts: { accountId: string }) => {
      printError({ code: 'NOT_IMPLEMENTED', message: 'intel defaults: not yet implemented', hint: 'This command is under development' }, 'json');
      process.exit(EXIT_RUNTIME);
    });

  intel
    .command('scan')
    .description('Creative scan for onboarding')
    .requiredOption('--account-id <id>', 'Ad account ID')
    .action(async (_opts: { accountId: string }) => {
      printError({ code: 'NOT_IMPLEMENTED', message: 'intel scan: not yet implemented', hint: 'This command is under development' }, 'json');
      process.exit(EXIT_RUNTIME);
    });
}
