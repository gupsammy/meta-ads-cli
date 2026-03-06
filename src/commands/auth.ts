import { Command, Option } from 'commander';
import {
  buildOAuthUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getAuthStatus,
  saveToken,
  startOAuthCallbackServer,
} from '../auth.js';
import { printOutput, printError, confirmAction, type OutputFormat, EXIT_RUNTIME, EXIT_USAGE } from '../lib/output.js';

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Manage authentication');

  auth
    .command('login')
    .description('Authenticate with Meta via OAuth2 or access token')
    .option('--app-id <id>', 'Meta App ID')
    .option('--token <token>', 'Access token (use - to read from stdin)')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .addHelpText('after', `
Examples:
  $ meta-ads auth login --token EAAx...
  $ echo $TOKEN | meta-ads auth login --token -
  $ META_ADS_APP_SECRET=xxx meta-ads auth login --app-id 123456
`)
    .action(async (opts: { appId?: string; token?: string; output: OutputFormat }) => {
      try {
        if (opts.token) {
          let tokenValue = opts.token;

          if (tokenValue === '-') {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin) {
              chunks.push(chunk);
            }
            tokenValue = Buffer.concat(chunks).toString().trim();
            if (!tokenValue) {
              printError({ code: 'USAGE', message: 'No token provided on stdin.' }, opts.output);
              process.exit(EXIT_USAGE);
            }
          } else {
            console.error('Warning: passing tokens via CLI flags is insecure. Use stdin: echo $TOKEN | meta-ads auth login --token -');
          }

          saveToken(tokenValue);
          printOutput({ status: 'authenticated', message: 'Access token saved successfully.' }, opts.output);
          return;
        }

        const appId = opts.appId ?? process.env['META_ADS_APP_ID'];
        const appSecret = process.env['META_ADS_APP_SECRET'];

        if (!appId || !appSecret) {
          printError({
            code: 'USAGE',
            message: 'App ID and App Secret are required for OAuth flow.',
            hint: 'Set META_ADS_APP_ID and META_ADS_APP_SECRET env vars, or use --token to set an access token directly.',
          }, opts.output);
          process.exit(EXIT_USAGE);
        }

        const { randomBytes } = await import('node:crypto');
        const state = randomBytes(32).toString('hex');
        const authUrl = buildOAuthUrl(appId, state);

        console.error(`Opening browser for authorization...\n\n  ${authUrl}\n`);
        console.error('If the browser does not open, visit the URL above manually.\n');
        console.error('Waiting for callback...');

        const openModule = await import('open');
        await openModule.default(authUrl);

        const callbackResult = await startOAuthCallbackServer();

        if (callbackResult.state !== state) {
          console.error('OAuth state mismatch. Authorization may have been tampered with.');
          process.exit(EXIT_RUNTIME);
        }

        console.error('Exchanging authorization code for access token...');
        const tokenResult = await exchangeCodeForToken(callbackResult.code, appId, appSecret);

        console.error('Exchanging for long-lived token...');
        const longLived = await exchangeForLongLivedToken(tokenResult.access_token, appId, appSecret);

        saveToken(longLived.access_token, appId);

        printOutput(
          {
            status: 'authenticated',
            message: 'Successfully authenticated with Meta.',
            expires_in: longLived.expires_in,
          },
          opts.output,
        );
      } catch (error) {
        printError({ code: 'AUTH_FAILED', message: error instanceof Error ? error.message : String(error) }, opts.output);
        process.exit(EXIT_RUNTIME);
      }
    });

  auth
    .command('status')
    .description('Show current authentication status')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .action((opts: { output: OutputFormat }) => {
      const status = getAuthStatus();
      printOutput(
        {
          authenticated: status.authenticated,
          config_file: status.configPath,
          has_access_token: status.hasToken,
          has_app_id: status.hasAppId,
        },
        opts.output,
      );
    });

  auth
    .command('logout')
    .description('Remove stored credentials')
    .option('--force', 'Skip confirmation')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .action(async (opts: { force?: boolean; output: OutputFormat }) => {
      const confirmed = await confirmAction('Remove credentials?', opts.force);
      if (!confirmed) {
        if (!process.stdin.isTTY) {
          printError({
            code: 'USAGE',
            message: 'Logout requires --force in non-interactive mode.',
            hint: 'meta-ads auth logout --force',
          }, opts.output);
        } else {
          console.error('Aborted.');
        }
        process.exit(EXIT_USAGE);
      }
      saveToken('');
      printOutput({ status: 'logged_out', message: 'Credentials removed.' }, opts.output);
    });
}
