import { createRequire } from 'node:module';
import { Command } from 'commander';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');
import { registerAuthCommands } from './commands/auth.js';
import { registerAccountsCommands } from './commands/accounts.js';
import { registerCampaignsCommands } from './commands/campaigns.js';
import { registerAdsetsCommands } from './commands/adsets.js';
import { registerAdsCommands } from './commands/ads.js';
import { registerInsightsCommands } from './commands/insights.js';
import { registerAudiencesCommands } from './commands/audiences.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerUninstallCommand } from './commands/uninstall.js';
import { registerIntelCommands } from './intel/index.js';

const program = new Command();

program
  .name('meta-ads')
  .description('Command-line interface for the Meta (Facebook) Marketing API')
  .version(version, '--version')
  .action(() => {
    program.help();
  });

program.configureOutput({
  writeErr: (str) => process.stderr.write(str),
});

registerAuthCommands(program);
registerAccountsCommands(program);
registerCampaignsCommands(program);
registerAdsetsCommands(program);
registerAdsCommands(program);
registerInsightsCommands(program);
registerAudiencesCommands(program);
registerSetupCommand(program);
registerUpdateCommand(program);
registerUninstallCommand(program);
registerIntelCommands(program);

program.parse();
