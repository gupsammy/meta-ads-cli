import { Command, Option } from 'commander';
import { execFile } from 'node:child_process';
import { printOutput, printError, type OutputFormat, EXIT_RUNTIME } from '../lib/output.js';

const PACKAGE_NAME = 'meta-ads-cli';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Update meta-ads-cli to the latest version')
    .option('--check', 'Check for updates without installing')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .action(async (opts: { check?: boolean; output: OutputFormat }) => {
      try {
        const currentVersion = program.version() ?? '0.0.0';

        console.error('Checking for updates...');
        const latestVersion = await fetchLatestVersion();

        if (latestVersion === currentVersion) {
          printOutput({ current_version: currentVersion, latest_version: latestVersion, status: 'up_to_date' }, opts.output);
          return;
        }

        if (opts.check) {
          printOutput({
            current_version: currentVersion,
            latest_version: latestVersion,
            status: 'update_available',
            message: `Run 'meta-ads update' to install v${latestVersion}`,
          }, opts.output);
          return;
        }

        console.error(`Updating ${currentVersion} -> ${latestVersion}...`);

        await new Promise<void>((resolve, reject) => {
          execFile('npm', ['install', '-g', `${PACKAGE_NAME}@latest`], (error, stdout, stderr) => {
            if (error) {
              reject(new Error(`Update failed: ${stderr || error.message}`));
              return;
            }
            if (stdout) console.error(stdout.trim());
            resolve();
          });
        });

        printOutput({
          previous_version: currentVersion,
          current_version: latestVersion,
          status: 'updated',
          message: `Successfully updated to v${latestVersion}`,
        }, opts.output);
      } catch (error) {
        printError({ code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }, opts.output);
        process.exit(EXIT_RUNTIME);
      }
    });
}

async function fetchLatestVersion(): Promise<string> {
  const response = await fetch(REGISTRY_URL);
  if (!response.ok) {
    throw new Error(`Failed to check npm registry: HTTP ${response.status}`);
  }
  const data = await response.json() as { version: string };
  return data.version;
}
