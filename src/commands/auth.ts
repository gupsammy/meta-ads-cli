import { Command } from 'commander';
import {
  buildOAuthUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getAuthStatus,
  saveToken,
  startOAuthCallbackServer,
} from '../auth.js';
import { printOutput, type OutputFormat } from '../lib/output.js';

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Manage authentication');

  auth
    .command('login')
    .description('Authenticate with Meta via OAuth2 or access token')
    .option('--app-id <id>', 'Meta App ID')
    .option('--app-secret <secret>', 'Meta App Secret')
    .option('--token <token>', 'Directly set an access token (skip OAuth flow)')
    .option('-o, --output <format>', 'Output format (json, table, csv)', 'json')
    .action(async (opts: { appId?: string; appSecret?: string; token?: string; output: OutputFormat }) => {
      try {
        if (opts.token) {
          saveToken(opts.token);
          printOutput({ status: 'authenticated', message: 'Access token saved successfully.' }, opts.output);
          return;
        }

        const appId = opts.appId ?? process.env['META_ADS_APP_ID'];
        const appSecret = opts.appSecret ?? process.env['META_ADS_APP_SECRET'];

        if (!appId || !appSecret) {
          console.error(
            'App ID and App Secret are required for OAuth flow.\n' +
              'Provide via --app-id and --app-secret flags, or set META_ADS_APP_ID and META_ADS_APP_SECRET env vars.\n\n' +
              'Alternatively, use --token to directly set an access token.',
          );
          process.exit(1);
        }

        const state = Math.random().toString(36).substring(2);
        const authUrl = buildOAuthUrl(appId, state);

        console.error(`Opening browser for authorization...\n\n  ${authUrl}\n`);
        console.error('If the browser does not open, visit the URL above manually.\n');
        console.error('Waiting for callback...');

        const openModule = await import('open');
        await openModule.default(authUrl);

        const callbackResult = await startOAuthCallbackServer();

        if (callbackResult.state !== state) {
          console.error('OAuth state mismatch. Authorization may have been tampered with.');
          process.exit(1);
        }

        console.error('Exchanging authorization code for access token...');
        const tokenResult = await exchangeCodeForToken(callbackResult.code, appId, appSecret);

        console.error('Exchanging for long-lived token...');
        const longLived = await exchangeForLongLivedToken(tokenResult.access_token, appId, appSecret);

        saveToken(longLived.access_token, appId, appSecret);

        printOutput(
          {
            status: 'authenticated',
            message: 'Successfully authenticated with Meta.',
            expires_in: longLived.expires_in,
          },
          opts.output,
        );
      } catch (error) {
        console.error('Authentication failed:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  auth
    .command('status')
    .description('Show current authentication status')
    .option('-o, --output <format>', 'Output format (json, table, csv)', 'json')
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
    .option('-o, --output <format>', 'Output format (json, table, csv)', 'json')
    .action((opts: { output: OutputFormat }) => {
      saveToken('');
      printOutput({ status: 'logged_out', message: 'Credentials removed.' }, opts.output);
    });
}
