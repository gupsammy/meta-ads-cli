import { Command, Option } from 'commander';
import { spawn } from 'node:child_process';
import { resolveAccessToken, saveToken, exchangeForLongLivedToken } from '../auth.js';
import { ConfigManager } from '../lib/config.js';
import { graphRequestWithRetry, paginateAll, HttpError } from '../lib/http.js';
import { printOutput, printError, promptInput, confirmAction, type OutputFormat, EXIT_RUNTIME, EXIT_USAGE } from '../lib/output.js';

const config = new ConfigManager('meta-ads');

interface AdAccount {
  id: string;
  name: string;
  account_id: string;
  account_status: number;
  currency: string;
}

interface TokenDebugInfo {
  data: {
    app_id?: string;
    type?: string;
    is_valid: boolean;
    expires_at: number;
    scopes?: string[];
  };
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Configure meta-ads-cli with your access token and default account')
    .option('--skip-auth', 'Skip authentication setup')
    .option('--skip-account', 'Skip default account selection')
    .option('--non-interactive', 'Non-interactive mode (requires --token)')
    .option('--token <token>', 'Access token (for non-interactive mode)')
    .option('--account-id <id>', 'Default account ID (for non-interactive mode)')
    .option('--install-skill', 'Install the meta-ads-intel AI analysis skill')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table', 'csv']).default('table'))
    .action(async (opts: {
      skipAuth?: boolean;
      skipAccount?: boolean;
      nonInteractive?: boolean;
      token?: string;
      accountId?: string;
      installSkill?: boolean;
      output: OutputFormat;
    }) => {
      try {
        if (opts.nonInteractive) {
          await runNonInteractive(opts);
        } else {
          await runInteractive(opts);
        }
      } catch (error) {
        if (error instanceof HttpError) {
          printError({ code: error.code, message: error.message, retry_after: error.retryAfter }, opts.output);
        } else {
          printError({ code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }, opts.output);
        }
        process.exit(EXIT_RUNTIME);
      }
    });
}

async function runNonInteractive(opts: {
  skipAuth?: boolean;
  skipAccount?: boolean;
  token?: string;
  accountId?: string;
  installSkill?: boolean;
  output: OutputFormat;
}): Promise<void> {
  if (!opts.skipAuth) {
    if (!opts.token) {
      printError({ code: 'USAGE', message: 'Non-interactive mode requires --token' }, opts.output);
      process.exit(EXIT_USAGE);
    }
    const existingToken = resolveAccessToken();
    if (existingToken && existingToken !== opts.token) {
      const masked = `****${existingToken.slice(-4)}`;
      console.error(`Warning: overwriting existing token (${masked}) with new token.`);
    }
    saveToken(opts.token);
    console.error('Token saved.');
  }

  if (!opts.skipAccount && opts.accountId) {
    const accountId = opts.accountId.startsWith('act_') ? opts.accountId : `act_${opts.accountId}`;
    config.setDefault('account_id', accountId);
    console.error(`Default account set to ${accountId}`);
  }

  const token = resolveAccessToken(opts.token);
  if (token) {
    await runHealthCheck(token, opts.output);
  }

  if (opts.installSkill) {
    await installSkill(true);
  }

  printOutput({ status: 'configured', message: 'Setup complete.' }, opts.output);
}

async function runInteractive(opts: {
  skipAuth?: boolean;
  skipAccount?: boolean;
  installSkill?: boolean;
  output: OutputFormat;
}): Promise<void> {
  console.error('\n  meta-ads-cli setup\n');
  console.error('  This wizard will configure your CLI with a Meta API access token');
  console.error('  and set a default ad account.\n');

  let token: string | undefined;

  // Step 1: Authentication
  if (!opts.skipAuth) {
    token = await setupAuth(opts.output);
  } else {
    token = resolveAccessToken();
    if (!token) {
      console.error('No existing token found. Run setup without --skip-auth to configure.');
      process.exit(EXIT_USAGE);
    }
  }

  // Step 2: Token longevity check
  if (token) {
    await checkTokenLongevity(token);
  }

  // Step 3: Default account selection
  if (!opts.skipAccount && token) {
    await setupDefaultAccount(token, opts.output);
  }

  // Step 4: Health check
  if (token) {
    const defaultAccountId = config.getDefault('account_id');
    if (defaultAccountId) {
      await runHealthCheck(token, opts.output);
    }
  }

  // Step 5: AI skill installation
  await installSkill(opts.installSkill);

  // Step 6: Shell completions (stub)
  console.error('\n  Shell completions: coming soon.\n');

  // Step 7: Quick-start examples
  printQuickStart();
}

async function setupAuth(format: OutputFormat): Promise<string> {
  const existingToken = resolveAccessToken();

  if (existingToken) {
    const masked = `****${existingToken.slice(-4)}`;
    console.error(`  Current token: ${masked}`);
    const replace = await confirmAction('  Replace existing token?');
    if (!replace) {
      console.error('  Keeping existing token.\n');
      return existingToken;
    }
  }

  console.error('  To get an access token:');
  console.error('  1. Go to https://developers.facebook.com/tools/explorer/');
  console.error('  2. Select your app and request ads_management + ads_read permissions');
  console.error('  3. Generate the token and paste it below\n');

  const token = await promptInput('  Paste your access token: ');
  if (!token) {
    printError({ code: 'USAGE', message: 'No token provided.' }, format);
    process.exit(EXIT_USAGE);
  }

  saveToken(token);
  console.error('  Token saved.\n');
  return token;
}

async function checkTokenLongevity(token: string): Promise<void> {
  const appSecret = process.env['META_ADS_APP_SECRET'];
  const appId = process.env['META_ADS_APP_ID'];

  if (!appId || !appSecret) {
    console.error('  Token expiry check requires META_ADS_APP_ID and META_ADS_APP_SECRET.');
    console.error('  Set these env vars and re-run setup to check token lifetime.\n');
    return;
  }

  try {
    // /debug_token requires an app access token (APP_ID|APP_SECRET), not a user token
    const appAccessToken = `${appId}|${appSecret}`;
    const debugInfo = await graphRequestWithRetry<TokenDebugInfo>(
      '/debug_token',
      appAccessToken,
      { params: { input_token: token } },
    );

    const expiresAt = debugInfo.data.expires_at;
    if (expiresAt === 0) {
      console.error('  Token type: never expires\n');
      return;
    }

    const expiresIn = expiresAt - Math.floor(Date.now() / 1000);
    if (expiresIn < 7200) {
      // Short-lived token (< 2 hours)
      console.error(`  Warning: this token expires in ${Math.max(0, Math.floor(expiresIn / 60))} minutes.`);

      const exchange = await confirmAction('  Exchange for a long-lived token (60 days)?');
      if (exchange) {
        const result = await exchangeForLongLivedToken(token, appId, appSecret);
        saveToken(result.access_token);
        console.error('  Exchanged for long-lived token (60 days).\n');
        return;
      }
    } else {
      const days = Math.floor(expiresIn / 86400);
      console.error(`  Token expires in ${days} day${days !== 1 ? 's' : ''}.\n`);
    }
  } catch {
    console.error('  Could not check token expiry (non-fatal).\n');
  }
}

async function setupDefaultAccount(token: string, format: OutputFormat): Promise<void> {
  const existingDefault = config.getDefault('account_id');
  if (existingDefault) {
    console.error(`  Current default account: ${existingDefault}`);
    const replace = await confirmAction('  Change default account?');
    if (!replace) {
      console.error('  Keeping existing default.\n');
      return;
    }
  }

  console.error('  Fetching your ad accounts...\n');

  try {
    const result = await paginateAll<AdAccount>(
      '/me/adaccounts',
      token,
      { params: { fields: 'id,name,account_id,account_status,currency' } },
      100,
    );

    if (result.data.length === 0) {
      console.error('  No ad accounts found for this token.\n');
      return;
    }

    console.error('  Available accounts:');
    result.data.forEach((account, i) => {
      const status = account.account_status === 1 ? '' : ' (inactive)';
      console.error(`    ${i + 1}. ${account.name} (${account.id}) - ${account.currency}${status}`);
    });
    console.error('');

    const choice = await promptInput(`  Select account [1-${result.data.length}]: `);
    const index = parseInt(choice, 10) - 1;

    if (isNaN(index) || index < 0 || index >= result.data.length) {
      console.error('  Invalid selection. Skipping default account.\n');
      return;
    }

    const selected = result.data[index];
    config.setDefault('account_id', selected.id);
    console.error(`  Default account set to: ${selected.name} (${selected.id})\n`);
  } catch (error) {
    if (error instanceof HttpError) {
      printError({ code: error.code, message: error.message }, format);
    }
    console.error('  Could not fetch accounts. You can set a default later with:');
    console.error('  meta-ads setup\n');
  }
}

async function runHealthCheck(token: string, format: OutputFormat): Promise<void> {
  const accountId = config.getDefault('account_id');
  if (!accountId) return;

  try {
    const account = await graphRequestWithRetry<{
      id: string;
      name: string;
      currency: string;
      account_status: number;
    }>(
      `/${accountId}`,
      token,
      { params: { fields: 'id,name,currency,account_status' } },
    );

    console.error(`  Connected to: ${account.name} (${account.id}) - ${account.currency}`);
    if (account.account_status !== 1) {
      console.error(`  Warning: account status is ${account.account_status} (not active)`);
    }
    console.error('');
  } catch (error) {
    if (error instanceof HttpError) {
      printError({ code: error.code, message: `Health check failed: ${error.message}` }, format);
    }
  }
}

async function installSkill(force?: boolean): Promise<boolean> {
  if (!process.stdin.isTTY && !force) {
    return false;
  }

  console.error('\n  AI-powered ad analysis\n');
  console.error('  The meta-ads-intel skill lets AI coding agents (Claude Code, Cursor,');
  console.error('  Codex, etc.) analyze your ad performance automatically — budget');
  console.error('  optimization, creative analysis, trends, and recommendations.\n');

  if (!force) {
    const proceed = await confirmAction('  Install AI ad analysis skill?');
    if (!proceed) {
      console.error('  Skipped skill installation.\n');
      return false;
    }
  }

  console.error('  Installing skill...\n');
  const result = await runNpxSkills(['-y', 'skills', 'add', 'gupsammy/meta-ads-cli']);

  if (result.success) {
    console.error('  AI analysis skill installed.\n');
    return true;
  }

  console.error('  Skill installation failed. You can install it manually:');
  console.error('    npx skills add gupsammy/meta-ads-cli\n');
  return false;
}

function runNpxSkills(args: string[]): Promise<{ success: boolean }> {
  return new Promise((resolve) => {
    // shell: true needed on Windows where npx is a .cmd file
    // Route child stdout to stderr so npx output doesn't pollute --output json
    const child = spawn('npx', args, { shell: true, stdio: ['inherit', process.stderr, 'inherit'] });
    child.on('close', (code) => resolve({ success: code === 0 }));
    child.on('error', () => resolve({ success: false }));
  });
}

function printQuickStart(): void {
  console.error('  Quick start:');
  console.error('    meta-ads accounts list');
  console.error('    meta-ads campaigns list');
  console.error('    meta-ads insights get --date-preset last_7d');
  console.error('');
  console.error('  Run meta-ads --help for all commands.\n');
}
