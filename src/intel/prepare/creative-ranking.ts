import type { AdSummary, IntelConfig, CreativeAnalysis, CreativeAdEntry, CreativeZeroEntry, CreativeMediaEntry, CrossCampaignDuplicate, DiagnosticStatus } from '../types.js';
import { round2 } from '../metrics.js';

interface ObjMeta {
  conv: keyof AdSummary;
  sort: keyof AdSummary;
  dir: 'desc' | 'asc';
  zero_label: string;
}

function objMeta(obj: string): ObjMeta {
  if (obj === 'OUTCOME_SALES') return { conv: 'purchases', sort: 'roas', dir: 'desc', zero_label: 'zero_purchase' };
  if (obj === 'OUTCOME_TRAFFIC') return { conv: 'link_clicks', sort: 'link_click_ctr', dir: 'desc', zero_label: 'zero_clicks' };
  // Note: image-only awareness ads have video_view=0 by definition — they land in
  // zero_conversion but are not necessarily underperforming. Agents should consider this.
  if (obj === 'OUTCOME_AWARENESS') return { conv: 'video_view', sort: 'cpm', dir: 'asc', zero_label: 'zero_views' };
  if (obj === 'OUTCOME_ENGAGEMENT') return { conv: 'post_engagement', sort: 'cpe', dir: 'asc', zero_label: 'zero_engagement' };
  if (obj === 'OUTCOME_LEADS') return { conv: 'lead', sort: 'cpl', dir: 'asc', zero_label: 'zero_leads' };
  if (obj === 'OUTCOME_APP_PROMOTION') return { conv: 'app_install', sort: 'cpi', dir: 'asc', zero_label: 'zero_installs' };
  return { conv: 'purchases', sort: 'spend', dir: 'desc', zero_label: 'zero_conversion' };
}

/**
 * Classify an ad's diagnostic ranking fields into a status category.
 * Implements the SKILL.md decision tree deterministically so the agent reads rather than computes.
 */
function classifyDiagnostic(a: { quality_ranking?: string; engagement_rate_ranking?: string; conversion_rate_ranking?: string; impressions: number }): DiagnosticStatus {
  const rankings = [a.quality_ranking ?? '', a.engagement_rate_ranking ?? '', a.conversion_rate_ranking ?? ''];
  const isUnknownOrEmpty = (r: string) => r === '' || r === 'UNKNOWN';
  const allUnknown = rankings.every(isUnknownOrEmpty);
  const someUnknown = rankings.some(isUnknownOrEmpty);
  const noneUnknown = !someUnknown;

  if (noneUnknown) return 'available';
  if (allUnknown) {
    if (a.impressions < 500) return 'insufficient_data';
    if (a.impressions < 1000) return 'ambiguous';
    return 'placement_ineligible';
  }
  // Some present, others UNKNOWN
  return 'partial';
}

function formatAd(a: AdSummary): CreativeAdEntry {
  return {
    ad_name: a.ad_name,
    campaign_name: a.campaign_name,
    creative_body: a.creative_body,
    creative_title: a.creative_title,
    spend: a.spend,
    roas: a.roas ? round2(a.roas) : 0,
    cpa: a.cpa !== null ? round2(a.cpa) : null,
    cpc: round2(a.cpc),
    ctr: round2(a.ctr),
    cpe: a.cpe !== null ? round2(a.cpe) : null,
    cpl: a.cpl !== null ? round2(a.cpl) : null,
    cpi: a.cpi !== null ? round2(a.cpi) : null,
    impressions: a.impressions,
    cpm: a.impressions > 0 ? round2(a.spend / a.impressions * 1000) : null,
    reach: a.reach,
    video_views: a.video_view ?? 0,
    purchases: a.purchases,
    post_engagement: a.post_engagement,
    lead: a.lead,
    app_install: a.app_install,
    // AdSummary types these as required string, but summaries are read from JSON files
    // without runtime validation — fields may be absent on older/partial data. Keep ?? ''
    // as a safe fallback (also exercised by the test fixtures in prepare.test.ts).
    quality_ranking: a.quality_ranking ?? '',
    engagement_rate_ranking: a.engagement_rate_ranking ?? '',
    conversion_rate_ranking: a.conversion_rate_ranking ?? '',
    diagnostic_status: classifyDiagnostic(a),
  };
}

function formatZero(a: AdSummary): CreativeZeroEntry {
  return {
    ad_name: a.ad_name,
    campaign_name: a.campaign_name,
    creative_body: a.creative_body,
    creative_title: a.creative_title,
    spend: a.spend,
    impressions: a.impressions,
    cpm: a.impressions > 0 ? round2(a.spend / a.impressions * 1000) : null,
    reach: a.reach,
    video_views: a.video_view,
    // Same rationale as formatAd above — keep ?? '' for JSON-deserialized safety.
    quality_ranking: a.quality_ranking ?? '',
    engagement_rate_ranking: a.engagement_rate_ranking ?? '',
    conversion_rate_ranking: a.conversion_rate_ranking ?? '',
    diagnostic_status: classifyDiagnostic(a),
  };
}

interface RankResult {
  withConv: AdSummary[];
  zeroConv: AdSummary[];
  winN: number;
  loseN: number;
  totalAds: number;
}

function rankAds(ads: AdSummary[], obj: string, topN: number, bottomN: number): RankResult {
  const m = objMeta(obj);
  const withConv = ads.filter((a) => (a[m.conv] as number) > 0);
  const zeroConv = ads.filter((a) => (a[m.conv] as number) === 0).sort((a, b) => b.spend - a.spend);

  // Sort by sort metric
  if (m.dir === 'desc') {
    withConv.sort((a, b) => ((b[m.sort] as number) ?? 0) - ((a[m.sort] as number) ?? 0));
  } else {
    withConv.sort((a, b) => ((a[m.sort] as number) ?? 0) - ((b[m.sort] as number) ?? 0));
  }

  const total = withConv.length;
  const winN = Math.min(topN, Math.max(1, Math.floor(total / 2)));
  const loseN = Math.min(bottomN, Math.max(0, total - winN));

  return { withConv, zeroConv, winN, loseN, totalAds: ads.length };
}

/**
 * Compute creative ranking (winners/losers/zero-conversion) + media output.
 * Port of prepare-analysis.sh lines 745-873.
 */
export function computeCreativeRanking(
  ads: AdSummary[],
  config: IntelConfig,
  creativeUrls: Record<string, { creative_image_url: string; creative_thumbnail_url: string }>,
): { analysis: CreativeAnalysis; media: CreativeMediaEntry[] } {
  const targets = config.targets ?? {};
  const minSpend = targets.global?.min_spend ?? 0;
  const topN = config.analysis?.top_n ?? 15;
  const bottomN = config.analysis?.bottom_n ?? 10;
  const zeroN = config.analysis?.zero_conversion_n ?? config.analysis?.zero_purchase_n ?? 10;
  const objectives = [...new Set(ads.map((a) => a.objective))].sort();

  const analysis: CreativeAnalysis = { objectives_present: objectives, cross_campaign_names: [] };
  const media: CreativeMediaEntry[] = [];

  for (const obj of objectives) {
    // M5 fallback: if min_spend filters out all, include all
    const allObj = ads.filter((a) => a.objective === obj).sort((a, b) => b.spend - a.spend);
    const filtered = allObj.filter((a) => a.spend >= minSpend);
    const working = filtered.length === 0 && allObj.length > 0 ? allObj : filtered;

    const r = rankAds(working, obj, topN, bottomN);
    const m = objMeta(obj);

    const winners = r.withConv.slice(0, r.winN);
    const losers = r.loseN > 0 ? r.withConv.slice(-r.loseN) : [];
    const zeroCapped = r.zeroConv.slice(0, zeroN);

    const winnerStats = {
      total: winners.length,
      empty_body: winners.filter((a) => a.creative_body === '').length,
      video: winners.filter((a) => (a.video_view ?? 0) > 0).length,
      image_only: winners.filter((a) => (a.video_view ?? 0) === 0).length,
    };

    const formattedWinners = winners.map(formatAd);
    const formattedLosers = losers.map(formatAd);
    const formattedZero = zeroCapped.map(formatZero);

    // Compute diagnostic coverage across all formatted entries
    const allEntries = [...formattedWinners, ...formattedLosers, ...formattedZero];
    const diagAvailable = allEntries.filter((e) => e.diagnostic_status === 'available' || e.diagnostic_status === 'partial').length;
    const allIneligible = allEntries.length > 0 && allEntries.every((e) => e.diagnostic_status === 'insufficient_data' || e.diagnostic_status === 'ambiguous' || e.diagnostic_status === 'placement_ineligible');

    analysis[obj] = {
      overview: {
        total_ads: r.totalAds,
        with_conversions: r.withConv.length,
        zero_conversion_count: r.zeroConv.length,
        zero_conversion_total_spend: r.zeroConv.reduce((s, a) => s + a.spend, 0),
        winner_stats: winnerStats,
        diagnostic_coverage: {
          available: diagAvailable,
          total: allEntries.length,
          pct: allEntries.length > 0 ? Math.round(diagAvailable / allEntries.length * 100) : 0,
          account_ineligible: allIneligible,
        },
      },
      winners: formattedWinners,
      losers: formattedLosers,
      zero_conversion: formattedZero,
    };

    // Build media entries
    for (const a of winners) {
      const adId = a.ad_id != null ? String(a.ad_id) : '';
      const urls = creativeUrls[adId] ?? { creative_image_url: '', creative_thumbnail_url: '' };
      media.push({
        ad_id: a.ad_id,
        ad_name: a.ad_name,
        objective: a.objective,
        rank: 'winner',
        primary_metric_name: m.sort as string,
        primary_metric_value: round2((a[m.sort] as number) ?? 0),
        spend: a.spend,
        creative_image_url: urls.creative_image_url,
        creative_thumbnail_url: urls.creative_thumbnail_url,
      });
    }
    for (const a of losers) {
      const adId = a.ad_id != null ? String(a.ad_id) : '';
      const urls = creativeUrls[adId] ?? { creative_image_url: '', creative_thumbnail_url: '' };
      media.push({
        ad_id: a.ad_id,
        ad_name: a.ad_name,
        objective: a.objective,
        rank: 'loser',
        primary_metric_name: m.sort as string,
        primary_metric_value: round2((a[m.sort] as number) ?? 0),
        spend: a.spend,
        creative_image_url: urls.creative_image_url,
        creative_thumbnail_url: urls.creative_thumbnail_url,
      });
    }
    for (const a of zeroCapped) {
      const adId = a.ad_id != null ? String(a.ad_id) : '';
      const urls = creativeUrls[adId] ?? { creative_image_url: '', creative_thumbnail_url: '' };
      media.push({
        ad_id: a.ad_id,
        ad_name: a.ad_name,
        objective: a.objective,
        rank: 'zero_conversion',
        primary_metric_name: m.sort as string,
        primary_metric_value: round2((a[m.sort] as number) ?? 0),
        spend: a.spend,
        creative_image_url: urls.creative_image_url,
        creative_thumbnail_url: urls.creative_thumbnail_url,
      });
    }
  }

  // Cross-campaign duplicate detection: find ad names that appear as winner
  // in one objective/campaign and loser in another
  const winnerMap = new Map<string, { campaign: string; objective: string; metric_value: number }>();
  const loserMap = new Map<string, { campaign: string; objective: string; metric_value: number }>();
  for (const obj of objectives) {
    const group = analysis[obj] as { winners: CreativeAdEntry[]; losers: CreativeAdEntry[] } | undefined;
    if (!group) continue;
    const m = objMeta(obj);
    for (const w of group.winners) {
      const name = w.ad_name ?? '';
      if (name) {
        winnerMap.set(`${name}::${obj}`, {
          campaign: w.campaign_name ?? '',
          objective: obj,
          metric_value: (w as unknown as Record<string, number>)[m.sort as string] ?? 0,
        });
      }
    }
    for (const l of group.losers) {
      const name = l.ad_name ?? '';
      if (name) {
        loserMap.set(`${name}::${obj}`, {
          campaign: l.campaign_name ?? '',
          objective: obj,
          metric_value: (l as unknown as Record<string, number>)[m.sort as string] ?? 0,
        });
      }
    }
  }

  const crossCampaign: CrossCampaignDuplicate[] = [];
  for (const [winKey, winInfo] of winnerMap) {
    const adName = winKey.split('::')[0];
    for (const [loseKey, loseInfo] of loserMap) {
      const loseName = loseKey.split('::')[0];
      if (adName === loseName && winInfo.campaign !== loseInfo.campaign) {
        crossCampaign.push({
          ad_name: adName,
          winner_in: winInfo,
          loser_in: loseInfo,
        });
      }
    }
  }
  analysis.cross_campaign_names = crossCampaign;

  return { analysis, media };
}
