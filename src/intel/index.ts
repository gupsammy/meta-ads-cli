import { Command } from 'commander';

export function registerIntelCommands(program: Command): void {
  const intel = program
    .command('intel', { hidden: true })
    .description('Analysis pipeline for Meta Ads Intel skill');

  intel
    .command('run')
    .description('Run full analysis pipeline')
    .argument('[date-preset]', 'Date preset (last_7d, last_14d, last_30d)', 'last_14d')
    .action(async (_datePreset: string) => {
      console.error('intel run: not yet implemented');
      process.exit(1);
    });

  intel
    .command('defaults')
    .description('Compute target defaults from current performance')
    .requiredOption('--account-id <id>', 'Ad account ID')
    .action(async (_opts: { accountId: string }) => {
      console.error('intel defaults: not yet implemented');
      process.exit(1);
    });

  intel
    .command('scan')
    .description('Creative scan for onboarding')
    .requiredOption('--account-id <id>', 'Ad account ID')
    .action(async (_opts: { accountId: string }) => {
      console.error('intel scan: not yet implemented');
      process.exit(1);
    });
}
