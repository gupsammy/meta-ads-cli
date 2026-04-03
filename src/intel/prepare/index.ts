import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CampaignSummary, AdsetSummary, AdSummary, DailyAdMetric, IntelConfig, PipelineStatus, AccountHealth, BudgetActions, FunnelData, TrendsData, CreativeAnalysis, FatigueData, RecommendationsData, DataReport } from '../types.js';
import { computeAccountHealth } from './account-health.js';
import { computeBudgetActions } from './budget-actions.js';
import { computeFunnel } from './funnel.js';
import { computeTrends } from './trends.js';
import { computeCreativeRanking } from './creative-ranking.js';
import { computeReport, buildDataReport } from './report.js';
import { computeFatigue } from './fatigue.js';

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
export function prepare(runDir: string, configPath?: string, datePreset: string = 'last_14d'): PipelineStatus {
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
    'report.json',
  ];
  const produced: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  // Read summary files
  const campaignsPath = path.join(summariesDir, 'campaigns-summary.json');
  const adsetsPath = path.join(summariesDir, 'adsets-summary.json');
  const adsPath = path.join(summariesDir, 'ads-summary.json');

  const adsDailyPath = path.join(summariesDir, 'ads-daily-summary.json');

  const campaigns = fs.existsSync(campaignsPath) ? readJsonSafe<CampaignSummary[]>(campaignsPath) : null;
  const adsets = fs.existsSync(adsetsPath) ? readJsonSafe<AdsetSummary[]>(adsetsPath) : null;
  const ads = fs.existsSync(adsPath) ? readJsonSafe<AdSummary[]>(adsPath) : null;
  const dailyAds = fs.existsSync(adsDailyPath) ? readJsonSafe<DailyAdMetric[]>(adsDailyPath) : null;

  // Track computed results for report generation
  let healthResult: AccountHealth | null = null;
  let actionsResult: BudgetActions | null = null;
  let funnelResult: FunnelData | null = null;
  let trendsResult: TrendsData | null; // always assigned in if/else below
  let creativeResult: CreativeAnalysis | null = null;
  let recsResult: RecommendationsData | null = null;
  let fatigueResult: FatigueData | null = null;

  // 1. account-health.json
  if (campaigns) {
    healthResult = computeAccountHealth(campaigns, config);
    writeJson(path.join(runDir, 'account-health.json'), healthResult);
    produced.push('account-health.json');
  }

  // 2. budget-actions.json
  if (adsets) {
    actionsResult = computeBudgetActions(adsets, config);
    writeJson(path.join(runDir, 'budget-actions.json'), actionsResult);
    produced.push('budget-actions.json');
  }

  // 3. funnel.json
  if (campaigns) {
    funnelResult = computeFunnel(campaigns, config);
    writeJson(path.join(runDir, 'funnel.json'), funnelResult);
    produced.push('funnel.json');
  }

  // 4. trends.json
  const recentPath = path.join(runDir, '_recent', 'campaigns-summary.json');
  const recentCampaigns = fs.existsSync(recentPath) ? readJsonSafe<CampaignSummary[]>(recentPath) : null;

  if (campaigns) {
    trendsResult = computeTrends(campaigns, recentCampaigns);
    writeJson(path.join(runDir, 'trends.json'), trendsResult);
    produced.push('trends.json');
  } else {
    trendsResult = { available: false, reason: 'no campaigns data' };
    writeJson(path.join(runDir, 'trends.json'), trendsResult);
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
        // Pull phase produces {data: [...]}, but handle bare array defensively
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
    creativeResult = analysis;
    writeJson(path.join(runDir, 'creative-analysis.json'), analysis);
    writeJson(path.join(runDir, 'creative-media.json'), media);
    produced.push('creative-analysis.json');
    produced.push('creative-media.json');
  } else {
    // Shell writes empty array for creative-media when no ads data
    writeJson(path.join(runDir, 'creative-media.json'), []);
    produced.push('creative-media.json');
  }

  // 7. fatigue.json
  if (dailyAds) {
    fatigueResult = computeFatigue(dailyAds, config);
    writeJson(path.join(runDir, 'fatigue.json'), fatigueResult);
    produced.push('fatigue.json');
  }

  // 8. recommendations.json (pass-through from _raw)
  const rawRecsPath = path.join(runDir, '_raw', 'recommendations.json');
  if (fs.existsSync(rawRecsPath)) {
    const rawRecs = readJsonSafe<RecommendationsData>(rawRecsPath);
    if (rawRecs) {
      recsResult = rawRecs;
      writeJson(path.join(runDir, 'recommendations.json'), rawRecs);
      produced.push('recommendations.json');
    }
  }

  // 9. report.json (client-ready summary)
  // Read prior DataReport for cross-run delta
  const reportsDir = path.resolve(configPath ? path.dirname(configPath) : path.join(process.env.HOME ?? '', '.meta-ads-intel'), 'reports');
  let priorData: DataReport | null = null;
  if (fs.existsSync(reportsDir)) {
    const dataFiles = fs.readdirSync(reportsDir).filter((f) => f.startsWith('data-') && f.endsWith('.json')).sort();
    if (dataFiles.length > 0) {
      // Read the most recent prior data file
      priorData = readJsonSafe<DataReport>(path.join(reportsDir, dataFiles[dataFiles.length - 1]));
    }
  }

  const report = computeReport(healthResult, actionsResult, funnelResult, trendsResult, creativeResult, recsResult, config, fatigueResult, priorData);
  // Fill date_range from campaigns if available
  if (campaigns && campaigns.length > 0) {
    const starts = campaigns.map((c) => c.date_start).filter(Boolean).sort();
    const stops = campaigns.map((c) => c.date_stop).filter(Boolean).sort();
    report.date_range = { start: starts[0], stop: stops[stops.length - 1] };
  }
  writeJson(path.join(runDir, 'report.json'), report);
  produced.push('report.json');

  // 10. data-report.json — structured data for cross-run comparison
  const budgetSummary = report.sections.budget_summary;
  // Extract date from runDir name (YYYY-MM-DD_HHMM)
  const runDirName = path.basename(runDir);
  const dateStr = runDirName.slice(0, 10); // YYYY-MM-DD
  const timestamp = runDirName; // full YYYY-MM-DD_HHMM
  const dataReport = buildDataReport(healthResult, budgetSummary, fatigueResult, creativeResult, recsResult, datePreset, dateStr);
  writeJson(path.join(runDir, 'data-report.json'), dataReport);
  produced.push('data-report.json');

  // Also persist to ~/.meta-ads-intel/reports/ for cross-run access
  fs.mkdirSync(reportsDir, { recursive: true });
  writeJson(path.join(reportsDir, `data-${timestamp}.json`), dataReport);

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
