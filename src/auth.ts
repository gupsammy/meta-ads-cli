import { createServer } from 'node:http';
import { URL } from 'node:url';
import { ConfigManager } from './lib/config.js';
import { API_VERSION } from './lib/constants.js';
import { EXIT_USAGE } from './lib/output.js';

const config = new ConfigManager('meta-ads');

const OAUTH_AUTHORIZE_URL = `https://www.facebook.com/${API_VERSION}/dialog/oauth`;
const OAUTH_TOKEN_URL = `https://graph.facebook.com/${API_VERSION}/oauth/access_token`;
const REDIRECT_PORT = 8484;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = 'ads_management,ads_read';

export function resolveAccessToken(flagValue?: string): string | undefined {
  if (flagValue) return flagValue;
  const envVal = process.env['META_ADS_ACCESS_TOKEN'];
  if (envVal) return envVal;
  return config.read().auth?.access_token;
}

export function requireAccessToken(flagValue?: string): string {
  const token = resolveAccessToken(flagValue);
  if (!token) {
    console.error(
      `No access token found. Provide one via:\n` +
        `  1. --access-token flag\n` +
        `  2. META_ADS_ACCESS_TOKEN environment variable\n` +
        `  3. meta-ads auth login`,
    );
    process.exit(1);
  }
  return token;
}

export function resolveAccountId(flagValue?: string): string | undefined {
  if (flagValue) return flagValue.startsWith('act_') ? flagValue : `act_${flagValue}`;
  const configVal = config.getDefault('account_id');
  if (configVal) return configVal.startsWith('act_') ? configVal : `act_${configVal}`;
  return undefined;
}

export function requireAccountId(flagValue?: string): string {
  const accountId = resolveAccountId(flagValue);
  if (!accountId) {
    console.error(
      `No account ID found. Provide one via:\n` +
        `  1. --account-id flag\n` +
        `  2. Config default (run: meta-ads setup)`,
    );
    process.exit(EXIT_USAGE);
  }
  return accountId;
}

export function getAuthStatus(): { authenticated: boolean; configPath: string; hasToken: boolean; hasAppId: boolean } {
  const cfg = config.read();
  return {
    authenticated: !!cfg.auth?.access_token,
    configPath: config.getConfigPath(),
    hasToken: !!cfg.auth?.access_token,
    hasAppId: !!cfg.auth?.app_id,
  };
}

export function buildOAuthUrl(appId: string, state: string): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    response_type: 'code',
    state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(
  code: string,
  appId: string,
  appSecret: string,
): Promise<{ access_token: string; token_type: string; expires_in?: number }> {
  const params = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: REDIRECT_URI,
    code,
  });

  // POST body instead of query string to avoid leaking client_secret in logs
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${text}`);
  }
  return response.json() as Promise<{ access_token: string; token_type: string; expires_in?: number }>;
}

export async function exchangeForLongLivedToken(
  shortLivedToken: string,
  appId: string,
  appSecret: string,
): Promise<{ access_token: string; token_type: string; expires_in?: number }> {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLivedToken,
  });

  // POST body instead of query string to avoid leaking client_secret in logs
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Long-lived token exchange failed: ${text}`);
  }
  return response.json() as Promise<{ access_token: string; token_type: string; expires_in?: number }>;
}

export function saveToken(accessToken: string, appId?: string): void {
  const cfg = config.read();
  cfg.auth = {
    ...cfg.auth,
    access_token: accessToken,
    ...(appId && { app_id: appId }),
  };
  delete cfg.auth.app_secret;
  config.write(cfg);
}

export interface OAuthCallbackResult {
  code: string;
  state?: string;
}

export function startOAuthCallbackServer(): Promise<OAuthCallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://localhost:${REDIRECT_PORT}`);

        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state') ?? undefined;
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h1>Authorization failed: ${error}</h1></body></html>`);
          server.close();
          reject(new Error(`OAuth authorization failed: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Missing authorization code</h1></body></html>');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h1>Authorization successful!</h1><p>You can close this window and return to the terminal.</p></body></html>',
        );
        server.close();
        resolve({ code, state });
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.listen(REDIRECT_PORT, '127.0.0.1');
    server.on('error', reject);

    setTimeout(() => {
      server.close();
      reject(new Error('OAuth callback timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}
