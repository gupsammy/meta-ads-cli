import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CampaignSummary, AdsetSummary, AdSummary, IntelConfig, PipelineStatus } from '../types.js';
import { computeAccountHealth } from './account-health.js';
import { computeBudgetActions } from './budget-actions.js';
import { computeFunnel } from './funnel.js';
import { computeTrends } from './trends.js';
import { computeCreativeRanking } from './creative-ranking.js';

function readJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Run the full analysis pipeline: read summary files + config, compute
 * 6 analysis files, write output + pipeline-status.json.
 *
 * Port of prepare-analysis.sh — the orchestrator handles all file I/O,
 * each computation module is a pure function.
 *
 * @param runDir - directory containing _summaries/, optionally _recent/ and _raw/
 * @param configPath - path to config.json (defaults to ~/.meta-ads-intel/config.json)
 */
export function prepare(runDir: string, configPath?: string): PipelineStatus {
  const cfgPath = configPath ?? path.join(process.env.HOME ?? '', '.meta-ads-intel', 'config.json');

  // Read and validate config
  const config = readJsonSafe<IntelConfig>(cfgPath);
  if (!config) {
    throw new Error(`config.json not found at ${cfgPath}. Run onboarding first.`);
  }
  if ((config.config_version ?? 1) < 2) {
    throw new Error('config.json is v1 format. Re-run onboarding to upgrade to v2 (per-objective targets).');
  }

  const summariesDir = path.join(runDir, '_summaries');
  const expectedFiles = [
    'account-health.json',
    'budget-actions.json',
    'funnel.json',
    'trends.json',
    'creative-analysis.json',
    'creative-media.json',
  ];
  const produced: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  // Read summary files
  const campaignsPath = path.join(summariesDir, 'campaigns-summary.json');
  const adsetsPath = path.join(summariesDir, 'adsets-summary.json');
  const adsPath = path.join(summariesDir, 'ads-summary.json');

  const campaigns = fs.existsSync(campaignsPath) ? readJsonSafe<CampaignSummary[]>(campaignsPath) : null;
  const adsets = fs.existsSync(adsetsPath) ? readJsonSafe<AdsetSummary[]>(adsetsPath) : null;
  const ads = fs.existsSync(adsPath) ? readJsonSafe<AdSummary[]>(adsPath) : null;

  // 1. account-health.json
  if (campaigns) {
    const health = computeAccountHealth(campaigns, config);
    writeJson(path.join(runDir, 'account-health.json'), health);
    produced.push('account-health.json');
  }

  // 2. budget-actions.json
  if (adsets) {
    const actions = computeBudgetActions(adsets, config);
    writeJson(path.join(runDir, 'budget-actions.json'), actions);
    produced.push('budget-actions.json');
  }

  // 3. funnel.json
  if (campaigns) {
    const funnel = computeFunnel(campaigns, config);
    writeJson(path.join(runDir, 'funnel.json'), funnel);
    produced.push('funnel.json');
  }

  // 4. trends.json
  const recentPath = path.join(runDir, '_recent', 'campaigns-summary.json');
  const recentCampaigns = fs.existsSync(recentPath) ? readJsonSafe<CampaignSummary[]>(recentPath) : null;

  if (campaigns) {
    const trends = computeTrends(campaigns, recentCampaigns);
    writeJson(path.join(runDir, 'trends.json'), trends);
    produced.push('trends.json');
  } else {
    // Always produce trends.json (matches shell behavior)
    writeJson(path.join(runDir, 'trends.json'), { available: false, reason: 'no campaigns data' });
    produced.push('trends.json');
  }

  // 5 & 6. creative-analysis.json + creative-media.json
  if (ads) {
    // Read creative URLs from _raw/creatives.json
    const creativesPath = path.join(runDir, '_raw', 'creatives.json');
    let creativeUrls: Record<string, { creative_image_url: string; creative_thumbnail_url: string }> = {};
    if (fs.existsSync(creativesPath)) {
      const raw = readJsonSafe<Record<string, unknown>>(creativesPath);
      if (raw) {
        const entries = Array.isArray(raw) ? raw : (raw as Record<string, unknown>).data;
        if (Array.isArray(entries)) {
          for (const e of entries as Record<string, unknown>[]) {
            const id = String(e.id ?? '');
            if (id) {
              creativeUrls[id] = {
                creative_image_url: String(e.creative_image_url ?? ''),
                creative_thumbnail_url: String(e.creative_thumbnail_url ?? ''),
              };
            }
          }
        }
      }
    }

    const { analysis, media } = computeCreativeRanking(ads, config, creativeUrls);
    writeJson(path.join(runDir, 'creative-analysis.json'), analysis);
    writeJson(path.join(runDir, 'creative-media.json'), media);
    produced.push('creative-analysis.json');
    produced.push('creative-media.json');
  } else {
    // Shell writes empty array for creative-media when no ads data
    writeJson(path.join(runDir, 'creative-media.json'), []);
    produced.push('creative-media.json');
  }

  // Merge pull-phase warnings
  const pullWarningsPath = path.join(runDir, '_pull-warnings.json');
  if (fs.existsSync(pullWarningsPath)) {
    const pullWarnings = readJsonSafe<string[]>(pullWarningsPath);
    if (Array.isArray(pullWarnings)) {
      warnings.push(...pullWarnings);
    }
    fs.unlinkSync(pullWarningsPath);
  }

  // Determine skipped files
  for (const f of expectedFiles) {
    if (!produced.includes(f)) {
      skipped.push(f);
    }
  }

  const status: PipelineStatus = {
    status: skipped.length > 0 ? 'partial' : 'complete',
    files_produced: produced,
    files_skipped: skipped,
    warnings,
  };

  writeJson(path.join(runDir, 'pipeline-status.json'), status);

  return status;
}
