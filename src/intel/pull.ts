import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { paginateAll, graphRequestWithRetry } from '../lib/http.js';
import { resolveAccessToken } from '../auth.js';
import { ConfigManager } from '../lib/config.js';
import { summarize } from './summarize.js';
import { prepare } from './prepare/index.js';
import type { PipelineStatus, AdCreativeRow, RecommendationsData } from './types.js';

// Same fields as src/commands/insights.ts — duplicated here to avoid coupling
// pull's API contract to the CLI command's display fields.
const INSIGHT_FIELDS =
  'account_id,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,' +
  'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,' +
  'actions,action_values,cost_per_action_type,purchase_roas,date_start,date_stop';

const PULL_LIMIT = 500;
const pad = (n: number) => String(n).padStart(2, '0');

export interface PullOptions {
  datePreset?: string;
  dataDir?: string;
  configPath?: string;
  accessToken?: string;
}

export interface PullResult {
  runDir: string;
  pipelineStatus: PipelineStatus;
  warnings: string[];
}

// ─── Internal helpers ───────────────────────────────────────────────

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * 3-step account ID resolution (matches pull-data.sh):
 * 1. META_ADS_ACCOUNT_ID env var
 * 2. Skill config → .account_id
 * 3. CLI config → .defaults.account_id
 */
function resolveIntelAccountId(skillConfigPath: string): { accountId: string; source: string } {
  // Step 1: env var
  const envVal = process.env['META_ADS_ACCOUNT_ID'];
  if (envVal) {
    const id = envVal.startsWith('act_') ? envVal : `act_${envVal}`;
    return { accountId: id, source: 'env' };
  }

  // Step 2: skill config
  if (fs.existsSync(skillConfigPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(skillConfigPath, 'utf-8'));
      if (cfg.account_id) {
        const id = String(cfg.account_id);
        return { accountId: id.startsWith('act_') ? id : `act_${id}`, source: 'skill config' };
      }
    } catch { /* malformed config — fall through */ }
  }

  // Step 3: CLI config
  const cliConfig = new ConfigManager('meta-ads');
  const cliVal = cliConfig.getDefault('account_id');
  if (cliVal) {
    const id = cliVal.startsWith('act_') ? cliVal : `act_${cliVal}`;
    return { accountId: id, source: 'CLI config' };
  }

  throw new Error(
    'No account ID found.\n' +
    '  Set META_ADS_ACCOUNT_ID, run \'meta-ads setup\', or create ~/.meta-ads-intel/config.json',
  );
}

/** Returns true if file exists and mtime is within maxAgeMs. */
function isCacheFresh(filePath: string, maxAgeMs: number): boolean {
  try {
    const stat = fs.statSync(filePath);
    return Date.now() - stat.mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

/** Atomic directory-based lock. Throws if lock already held. */
function acquireLock(dataDir: string): string {
  const lockDir = path.join(dataDir, '.pull-lock');

  // Remove stale lock (>30 min old)
  if (fs.existsSync(lockDir) && !isCacheFresh(lockDir, 30 * 60 * 1000)) {
    console.error('Warning: Removing stale lock (>30 min old)');
    try { fs.rmdirSync(lockDir); } catch { fs.rmSync(lockDir, { recursive: true, force: true }); }
  }

  try {
    fs.mkdirSync(lockDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Another pull instance is running (lockdir: ${lockDir}).\n` +
        `  If this is stale, remove it: rmdir ${lockDir}`,
        { cause: err },
      );
    }
    throw err;
  }

  return lockDir;
}

function releaseLock(lockDir: string): void {
  try { fs.rmdirSync(lockDir); } catch { /* already removed or doesn't exist */ }
}

/**
 * Auto-migrate legacy config keys:
 * targets.OUTCOME_TRAFFIC.target_ctr → ctr
 * targets.OUTCOME_ENGAGEMENT.target_engagement_rate → engagement_rate
 */
function migrateConfigKeys(skillConfigPath: string): void {
  if (!fs.existsSync(skillConfigPath)) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(skillConfigPath, 'utf-8'));
    let changed = false;

    if (cfg.targets?.OUTCOME_TRAFFIC?.target_ctr !== undefined) {
      cfg.targets.OUTCOME_TRAFFIC.ctr = cfg.targets.OUTCOME_TRAFFIC.target_ctr;
      delete cfg.targets.OUTCOME_TRAFFIC.target_ctr;
      changed = true;
    }
    if (cfg.targets?.OUTCOME_ENGAGEMENT?.target_engagement_rate !== undefined) {
      cfg.targets.OUTCOME_ENGAGEMENT.engagement_rate = cfg.targets.OUTCOME_ENGAGEMENT.target_engagement_rate;
      delete cfg.targets.OUTCOME_ENGAGEMENT.target_engagement_rate;
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(skillConfigPath, JSON.stringify(cfg, null, 2));
      console.error('  Migrated config keys (target_ctr→ctr, target_engagement_rate→engagement_rate)');
    }
  } catch { /* malformed config — skip migration */ }
}

/** Atomically replace a symlink (like ln -sf). Removes existing target first. */
function forceSymlink(target: string, linkPath: string): void {
  try { fs.unlinkSync(linkPath); } catch { /* doesn't exist */ }
  fs.symlinkSync(path.relative(path.dirname(linkPath), target), linkPath);
}

/** Adds warning if data length >= limit (possible truncation). */
function checkTruncation(dataLength: number, label: string, limit: number, warnings: string[]): void {
  if (dataLength >= limit) {
    warnings.push(`${label} returned ${dataLength} items (limit ${limit} reached) — results may be truncated`);
  }
}

/** Scans for YYYY-MM-DD* directories, writes manifest.json and latest.json. */
function updateManifest(dataDir: string): void {
  const entries: string[] = [];
  for (const entry of fs.readdirSync(dataDir)) {
    if (/^\d{4}-\d{2}-\d{2}/.test(entry) && fs.statSync(path.join(dataDir, entry)).isDirectory()) {
      entries.push(entry);
    }
  }
  entries.sort();

  writeJson(path.join(dataDir, 'manifest.json'), { entries, count: entries.length });

  if (entries.length > 0) {
    writeJson(path.join(dataDir, 'latest.json'), { latest: entries[entries.length - 1] });
  }

  console.error(`Manifest updated: ${entries.length} entries available`);
}

// ─── Main pull function ─────────────────────────────────────────────

export async function pull(options?: PullOptions): Promise<PullResult> {
  const datePreset = options?.datePreset ?? 'last_14d';
  const dataDir = options?.dataDir ?? process.env['META_ADS_DATA_DIR'] ?? path.join(homedir(), '.meta-ads-intel', 'data');
  const skillConfigPath = options?.configPath ?? path.join(homedir(), '.meta-ads-intel', 'config.json');
  const warnings: string[] = [];

  // Restrict file permissions to owner-only (matches shell's umask 077)
  // process.umask() is unavailable in worker threads — gracefully skip
  let oldUmask: number | undefined;
  try { oldUmask = process.umask(0o077); } catch { /* worker thread */ }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let lockDir: string | undefined;
  try {
    lockDir = acquireLock(dataDir);
    // Resolve account and token
    const { accountId, source } = resolveIntelAccountId(skillConfigPath);
    const token = options?.accessToken ?? resolveAccessToken();
    if (!token) {
      throw new Error(
        'No access token found.\n' +
        '  Provide via --access-token, META_ADS_ACCESS_TOKEN env, or run: meta-ads auth login',
      );
    }

    console.error(`Account: ${accountId} (source: ${source})`);

    // Auto-migrate legacy config keys
    migrateConfigKeys(skillConfigPath);

    // Create timestamped run directory (YYYY-MM-DD_HHMM)
    const now = new Date();
    const runDirName = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    const runDir = path.join(dataDir, runDirName);
    const rawDir = path.join(runDir, '_raw');
    fs.mkdirSync(rawDir, { recursive: true });

    console.error(`Pulling Meta Ads data (${datePreset})...`);
    console.error(`Run directory: ${runDir}`);

    // ── Parallel API pull: 3 insights levels ──
    console.error(`  Pulling period data (${datePreset})...`);
    const insightsParams = {
      fields: INSIGHT_FIELDS,
      date_preset: datePreset,
    };

    const [campaignResult, adsetResult, adResult] = await Promise.all([
      paginateAll<Record<string, unknown>>(
        `/${accountId}/insights`,
        token,
        { params: { ...insightsParams, level: 'campaign' } },
        PULL_LIMIT,
      ),
      paginateAll<Record<string, unknown>>(
        `/${accountId}/insights`,
        token,
        { params: { ...insightsParams, level: 'adset' } },
        PULL_LIMIT,
      ),
      paginateAll<Record<string, unknown>>(
        `/${accountId}/insights`,
        token,
        { params: { ...insightsParams, level: 'ad' } },
        PULL_LIMIT,
      ),
    ]);

    // Write raw JSON
    writeJson(path.join(rawDir, 'campaigns.json'), { data: campaignResult.data });
    writeJson(path.join(rawDir, 'adsets.json'), { data: adsetResult.data });
    writeJson(path.join(rawDir, 'ads.json'), { data: adResult.data });

    // Check truncation
    checkTruncation(campaignResult.data.length, 'period campaigns', PULL_LIMIT, warnings);
    checkTruncation(adsetResult.data.length, 'period adsets', PULL_LIMIT, warnings);
    checkTruncation(adResult.data.length, 'period ads', PULL_LIMIT, warnings);

    // ── Master files ──

    // Campaigns metadata — always re-pull (lightweight, provides objective lookup)
    const campaignsMasterPath = path.join(dataDir, 'campaigns-master.json');
    const campaignsMeta = await paginateAll<Record<string, unknown>>(
      `/${accountId}/campaigns`,
      token,
      { params: { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,updated_time,start_time,stop_time' } },
      PULL_LIMIT,
    );
    writeJson(campaignsMasterPath, { data: campaignsMeta.data });
    checkTruncation(campaignsMeta.data.length, 'campaign metadata', PULL_LIMIT, warnings);
    forceSymlink(campaignsMasterPath, path.join(rawDir, 'campaigns-meta.json'));

    // Creatives — 24h TTL
    const creativesMasterPath = path.join(dataDir, 'creatives-master.json');
    if (!isCacheFresh(creativesMasterPath, 24 * 60 * 60 * 1000)) {
      const creativesResult = await paginateAll<AdCreativeRow>(
        `/${accountId}/ads`,
        token,
        { params: { fields: 'id,name,creative{id,title,body,image_url,thumbnail_url}' } },
        PULL_LIMIT,
      );
      // Flatten nested creative fields to match ads list CLI output format
      const flatData = creativesResult.data.map(a => ({
        id: a.id,
        name: a.name,
        creative_id: a.creative?.id ?? '',
        creative_body: a.creative?.body ?? '',
        creative_title: a.creative?.title ?? '',
        creative_image_url: a.creative?.image_url ?? '',
        creative_thumbnail_url: a.creative?.thumbnail_url ?? '',
      }));
      writeJson(creativesMasterPath, { data: flatData });
      checkTruncation(creativesResult.data.length, 'ad creatives', PULL_LIMIT, warnings);
    }
    forceSymlink(creativesMasterPath, path.join(rawDir, 'creatives.json'));

    // Account info — 7-day TTL
    const accountMasterPath = path.join(dataDir, 'account-master.json');
    if (!isCacheFresh(accountMasterPath, 7 * 24 * 60 * 60 * 1000)) {
      const accountInfo = await graphRequestWithRetry<Record<string, unknown>>(
        `/${accountId}`,
        token,
        { params: { fields: 'id,name,account_id,account_status,currency,timezone_name' } },
      );
      writeJson(accountMasterPath, accountInfo);
    }
    forceSymlink(accountMasterPath, path.join(rawDir, 'account.json'));

    // Recommendations — always fresh, non-blocking
    try {
      console.error('  Pulling account recommendations...');
      const recsResponse = await graphRequestWithRetry<RecommendationsData>(
        `/${accountId}/recommendations`,
        token,
        { method: 'POST' },
      );
      writeJson(path.join(rawDir, 'recommendations.json'), recsResponse);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Recommendations fetch failed (non-blocking): ${msg}`);
    }

    // ── Summarize ──
    console.error('  Summarizing period data...');
    await summarize(rawDir);

    // Move summaries to _summaries/
    const summariesDir = path.join(runDir, '_summaries');
    fs.mkdirSync(summariesDir, { recursive: true });

    const summaryFiles = ['campaigns-summary.json', 'adsets-summary.json', 'ads-summary.json'];
    for (const file of summaryFiles) {
      const src = path.join(rawDir, file);
      const dest = path.join(summariesDir, file);
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest);
      } else if (file !== 'campaigns-summary.json') {
        // campaigns-summary is required; others are optional
        const label = file.replace('-summary.json', '');
        warnings.push(`${file} missing — ${label}-level analysis will be skipped`);
      }
    }

    // campaigns-summary.json is required for downstream analysis — abort if missing
    if (!fs.existsSync(path.join(summariesDir, 'campaigns-summary.json'))) {
      throw new Error('summarize produced no campaigns-summary.json — cannot proceed with analysis');
    }

    // ── Recent window (for trends) ──
    if (datePreset !== 'last_7d') {
      console.error('  Pulling recent window (last_7d) for comparison...');
      const recentRaw = path.join(runDir, '_recent_raw');
      const recentDir = path.join(runDir, '_recent');
      fs.mkdirSync(recentRaw, { recursive: true });
      fs.mkdirSync(recentDir, { recursive: true });

      // Symlink campaign metadata for objective lookup
      forceSymlink(campaignsMasterPath, path.join(recentRaw, 'campaigns-meta.json'));

      const recentResult = await paginateAll<Record<string, unknown>>(
        `/${accountId}/insights`,
        token,
        { params: { fields: INSIGHT_FIELDS, date_preset: 'last_7d', level: 'campaign' } },
        PULL_LIMIT,
      );
      writeJson(path.join(recentRaw, 'campaigns.json'), { data: recentResult.data });
      checkTruncation(recentResult.data.length, 'recent campaigns', PULL_LIMIT, warnings);

      await summarize(recentRaw);

      const recentSummary = path.join(recentRaw, 'campaigns-summary.json');
      if (fs.existsSync(recentSummary)) {
        fs.renameSync(recentSummary, path.join(recentDir, 'campaigns-summary.json'));
      } else {
        console.error('Warning: recent-window summarize produced no campaigns-summary.json');
      }

      // Clean up _recent_raw
      fs.rmSync(recentRaw, { recursive: true, force: true });
    }

    // ── Write pull warnings ──
    if (warnings.length > 0) {
      writeJson(path.join(runDir, '_pull-warnings.json'), warnings);
    }

    // ── Prepare analysis files ──
    console.error('  Preparing analysis files...');
    const pipelineStatus = prepare(runDir, skillConfigPath);

    // ── Update manifest ──
    updateManifest(dataDir);

    console.error('');
    console.error(`Data pull complete. Run directory: ${runDir}`);

    return { runDir, pipelineStatus, warnings };
  } finally {
    if (lockDir) releaseLock(lockDir);
    if (oldUmask !== undefined) try { process.umask(oldUmask); } catch { /* worker thread */ }
  }
}
