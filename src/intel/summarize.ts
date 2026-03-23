import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InsightsRow, CampaignSummary, AdsetSummary, AdSummary } from './types.js';
import { extractMetrics, addDerived } from './metrics.js';
import { normalizeObjective } from './objective-map.js';

/**
 * Handles Meta API's two response formats: {data: [...]} and bare [...].
 * Matches jq's (.data // .)[] pattern.
 */
function unwrapData(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && 'data' in raw && Array.isArray((raw as Record<string, unknown>).data)) {
    return (raw as Record<string, unknown>).data as Record<string, unknown>[];
  }
  return [];
}

/**
 * Reads campaigns-meta.json, builds campaign_id → normalized objective map.
 * Returns {} if file missing or parse fails.
 */
function buildObjectiveLookup(dir: string): Record<string, string> {
  const filePath = path.join(dir, 'campaigns-meta.json');
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const rows = unwrapData(raw);
    const lookup: Record<string, string> = {};
    for (const c of rows) {
      const id = String(c.id ?? '');
      const objective = normalizeObjective(String(c.objective ?? 'UNKNOWN'));
      if (id) lookup[id] = objective;
    }
    return lookup;
  } catch {
    return {};
  }
}

/**
 * Reads creatives.json, builds ad_id → {creative_body, creative_title} map.
 * Returns {} if file missing or parse fails.
 */
function buildCreativeLookup(dir: string): Record<string, { creative_body: string; creative_title: string }> {
  const filePath = path.join(dir, 'creatives.json');
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const rows = unwrapData(raw);
    const lookup: Record<string, { creative_body: string; creative_title: string }> = {};
    for (const c of rows) {
      const id = String(c.id ?? '');
      if (id) {
        lookup[id] = {
          creative_body: String(c.creative_body ?? ''),
          creative_title: String(c.creative_title ?? ''),
        };
      }
    }
    return lookup;
  } catch {
    return {};
  }
}

/**
 * Summarize raw Meta API JSON files into compact summary JSON files.
 *
 * Reads campaigns.json, adsets.json, ads.json (insights data) plus
 * campaigns-meta.json (objective lookup) and creatives.json (creative text lookup)
 * from the given directory. Writes *-summary.json files with flat numeric metrics
 * plus entity identifiers — ~92% smaller than raw API output.
 *
 * Async signature for forward compatibility with pull.ts (PR 4).
 */
export async function summarize(dir: string): Promise<void> {
  const objectives = buildObjectiveLookup(dir);

  // Summarize campaigns
  const campaignsPath = path.join(dir, 'campaigns.json');
  if (fs.existsSync(campaignsPath)) {
    const raw = JSON.parse(fs.readFileSync(campaignsPath, 'utf-8'));
    const rows = unwrapData(raw);
    const result: CampaignSummary[] = rows.map((row) => ({
      ...addDerived(extractMetrics(row as InsightsRow)),
      campaign_id: String(row.campaign_id ?? ''),
      campaign_name: String(row.campaign_name ?? ''),
      objective: objectives[String(row.campaign_id ?? '')] ?? 'UNKNOWN',
      date_start: String(row.date_start ?? ''),
      date_stop: String(row.date_stop ?? ''),
    }));
    fs.writeFileSync(path.join(dir, 'campaigns-summary.json'), JSON.stringify(result, null, 2));
  }

  // Summarize adsets
  const adsetsPath = path.join(dir, 'adsets.json');
  if (fs.existsSync(adsetsPath)) {
    const raw = JSON.parse(fs.readFileSync(adsetsPath, 'utf-8'));
    const rows = unwrapData(raw);
    const result: AdsetSummary[] = rows.map((row) => ({
      ...addDerived(extractMetrics(row as InsightsRow)),
      adset_id: String(row.adset_id ?? ''),
      adset_name: String(row.adset_name ?? ''),
      campaign_id: String(row.campaign_id ?? ''),
      campaign_name: String(row.campaign_name ?? ''),
      objective: objectives[String(row.campaign_id ?? '')] ?? 'UNKNOWN',
      date_start: String(row.date_start ?? ''),
      date_stop: String(row.date_stop ?? ''),
    }));
    fs.writeFileSync(path.join(dir, 'adsets-summary.json'), JSON.stringify(result, null, 2));
  }

  // Summarize ads
  const adsPath = path.join(dir, 'ads.json');
  if (fs.existsSync(adsPath)) {
    const creatives = buildCreativeLookup(dir);
    const raw = JSON.parse(fs.readFileSync(adsPath, 'utf-8'));
    const rows = unwrapData(raw);
    const result: AdSummary[] = rows.map((row) => {
      const adId = String(row.ad_id ?? '');
      const creative = adId && creatives[adId]
        ? creatives[adId]
        : { creative_body: '', creative_title: '' };
      return {
        ...addDerived(extractMetrics(row as InsightsRow)),
        ad_id: adId,
        ad_name: String(row.ad_name ?? ''),
        adset_id: String(row.adset_id ?? ''),
        campaign_id: String(row.campaign_id ?? ''),
        campaign_name: String(row.campaign_name ?? ''),
        objective: objectives[String(row.campaign_id ?? '')] ?? 'UNKNOWN',
        date_start: String(row.date_start ?? ''),
        date_stop: String(row.date_stop ?? ''),
        creative_body: creative.creative_body,
        creative_title: creative.creative_title,
      };
    });
    fs.writeFileSync(path.join(dir, 'ads-summary.json'), JSON.stringify(result, null, 2));
  }
}
