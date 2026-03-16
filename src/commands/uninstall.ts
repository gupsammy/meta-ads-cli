import { Command, Option } from 'commander';
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { ConfigManager } from '../lib/config.js';
import { printOutput, printError, confirmAction, type OutputFormat, EXIT_RUNTIME, EXIT_USAGE } from '../lib/output.js';

const config = new ConfigManager('meta-ads');
const PACKAGE_NAME = 'meta-ads-cli';

export function registerUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .description('Uninstall meta-ads-cli')
    .option('--keep-config', 'Keep configuration files')
    .option('--force', 'Skip confirmation prompts')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .action(async (opts: { keepConfig?: boolean; force?: boolean; output: OutputFormat }) => {
      try {
        const confirmed = await confirmAction('Uninstall meta-ads-cli?', opts.force);
        if (!confirmed) {
          if (!process.stdin.isTTY) {
            printError({
              code: 'USAGE',
              message: 'Uninstall requires --force in non-interactive mode.',
              hint: 'meta-ads uninstall --force',
            }, opts.output);
          } else {
            console.error('Aborted.');
          }
          process.exit(EXIT_USAGE);
        }

        if (!opts.keepConfig) {
          const configDir = config.getConfigDir();
          const removeConfig = opts.force || await confirmAction(`Remove config directory ${configDir}?`);
          if (removeConfig) {
            try {
              rmSync(configDir, { recursive: true, force: true });
              console.error(`Removed ${configDir}`);
            } catch {
              console.error(`Could not remove ${configDir} — remove manually if needed.`);
            }
          }
        }

        console.error('Uninstalling...');

        await new Promise<void>((resolve, reject) => {
          execFile('npm', ['uninstall', '-g', PACKAGE_NAME], (error, _stdout, stderr) => {
            if (error) {
              reject(new Error(`Uninstall failed: ${stderr || error.message}`));
              return;
            }
            resolve();
          });
        });

        printOutput({ status: 'uninstalled', message: 'meta-ads-cli has been uninstalled.' }, opts.output);
      } catch (error) {
        printError({ code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }, opts.output);
        process.exit(EXIT_RUNTIME);
      }
    });
}
