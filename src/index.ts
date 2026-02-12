import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { registerAccountsCommands } from './commands/accounts.js';
import { registerCampaignsCommands } from './commands/campaigns.js';
import { registerAdsetsCommands } from './commands/adsets.js';
import { registerAdsCommands } from './commands/ads.js';
import { registerInsightsCommands } from './commands/insights.js';
import { registerAudiencesCommands } from './commands/audiences.js';

const program = new Command();

program
  .name('meta-ads')
  .description('Command-line interface for the Meta (Facebook) Marketing API')
  .version('0.1.0');

registerAuthCommands(program);
registerAccountsCommands(program);
registerCampaignsCommands(program);
registerAdsetsCommands(program);
registerAdsCommands(program);
registerInsightsCommands(program);
registerAudiencesCommands(program);

program.parse();
