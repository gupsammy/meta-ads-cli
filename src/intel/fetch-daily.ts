import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { fetchInsightsAsync } from '../lib/http.js';
import { resolveAccessToken } from '../auth.js';
import { AD_INSIGHT_FIELDS, resolveIntelAccountId } from './pull.js';

export interface FetchDailyOptions {
  since: string;
  until: string;
  dataDir?: string;
  configPath?: string;
  accessToken?: string;
}

export interface FetchDailyResult {
  run_dir: string;
  account_id: string;
  since: string;
  until: string;
  rows: number;
  file: string;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Thin, scriptable ad×daily metrics pull for an explicit [since, until] window.
 * The creative-signal data layer calls this for both backfill chunks and
 * incremental catch-up. Ad-level, time_increment=1, async report — the same
 * path `intel run` uses for ads-daily.json, but driven by an explicit time_range
 * instead of a date preset, and reusing AD_INSIGHT_FIELDS so the retention
 * fields (hook/hold-rate) come along.
 *
 * NO effective_status filter (unlike `intel run`): Meta's insights returns rows
 * only for ads that actually delivered in the window, so the result is naturally
 * "every ad active at any point in [since, until]" — including ads now paused,
 * which is exactly what backfill needs. The async report API absorbs the volume.
 *
 * Dates are validated at the CLI boundary (both required, YYYY-MM-DD, since ≤ until).
 */
export async function fetchDaily(options: FetchDailyOptions): Promise<FetchDailyResult> {
  const { since, until } = options;
  const dataDir = options.dataDir
    ?? process.env['META_ADS_DATA_DIR']
    ?? path.join(homedir(), '.meta-ads-intel', 'data');
  const skillConfigPath = options.configPath ?? path.join(homedir(), '.meta-ads-intel', 'config.json');

  // Ad spend data is sensitive — restrict file permissions (matches pull()).
  let oldUmask: number | undefined;
  try { oldUmask = process.umask(0o077); } catch { /* worker thread */ }
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    const { accountId } = resolveIntelAccountId(skillConfigPath);
    const token = options.accessToken ?? resolveAccessToken();
    if (!token) {
      throw new Error(
        'No access token found.\n' +
        '  Provide via --access-token, META_ADS_ACCESS_TOKEN env, or run: meta-ads auth login',
      );
    }

    // Run dir namespaced under daily/ and keyed by the window: distinct backfill
    // chunks get distinct dirs; re-fetching the same window (the trailing-7d
    // catch-up) overwrites idempotently.
    const runDir = path.join(dataDir, 'daily', `${since}_${until}`);
    fs.mkdirSync(runDir, { recursive: true });

    console.error(`Fetching ad×daily insights for ${accountId} [${since} → ${until}]...`);
    // No row cap (limit omitted): paginateAll follows every cursor to completion.
    // A total cap would SILENTLY truncate — ad×day rows easily exceed a few
    // hundred, and this is the creative-signal store's source of truth. Volume is
    // bounded instead by the caller chunking backfill into ~30-day windows.
    const result = await fetchInsightsAsync<Record<string, unknown>>(
      `/${accountId}/insights`,
      token,
      {
        params: {
          fields: AD_INSIGHT_FIELDS,
          level: 'ad',
          time_increment: '1',
          time_range: JSON.stringify({ since, until }),
        },
      },
    );

    const file = path.join(runDir, 'ads-daily.json');
    writeJson(file, { data: result.data });

    return {
      run_dir: runDir,
      account_id: accountId,
      since,
      until,
      rows: result.data.length,
      file,
    };
  } finally {
    if (oldUmask !== undefined) { try { process.umask(oldUmask); } catch { /* ok */ } }
  }
}
