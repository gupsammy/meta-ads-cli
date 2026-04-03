import type { DailyAdMetric, FatigueEntry, FatigueData, IntelConfig } from '../types.js';
import { round2 } from '../metrics.js';

export function computeFatigue(dailyAds: DailyAdMetric[], config: IntelConfig): FatigueData {
  const maxFreqThreshold = config.targets?.global?.max_frequency ?? 5;
  const freqHigh = Math.min(maxFreqThreshold, 3.5);

  // Group by ad_id
  const byAd = new Map<string, DailyAdMetric[]>();
  for (const row of dailyAds) {
    const id = row.ad_id ?? '';
    if (!id) continue;
    const existing = byAd.get(id);
    if (existing) existing.push(row);
    else byAd.set(id, [row]);
  }

  const objectives = [...new Set(dailyAds.map((d) => d.objective))].sort();
  const rotate: FatigueEntry[] = [];
  const watch: FatigueEntry[] = [];
  let healthy = 0;

  for (const [adId, rows] of byAd) {
    // Sort by date ascending
    rows.sort((a, b) => a.date.localeCompare(b.date));

    if (rows.length < 3) {
      healthy++;
      continue;
    }

    const first = rows[0];
    const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
    const latest = rows[rows.length - 1];

    // CTR day-over-day analysis
    const ctrs = rows.map((r) => r.ctr);
    const peakCtr = Math.max(...ctrs);
    let consecutiveDeclines = 0;
    let maxConsecutiveDeclines = 0;
    for (let i = 1; i < ctrs.length; i++) {
      if (ctrs[i] < ctrs[i - 1]) {
        consecutiveDeclines++;
        maxConsecutiveDeclines = Math.max(maxConsecutiveDeclines, consecutiveDeclines);
      } else {
        consecutiveDeclines = 0;
      }
    }
    const ctrDeclinePct = peakCtr > 0 ? round2((peakCtr - latest.ctr) / peakCtr * 100) : 0;
    const ctrDeclining = maxConsecutiveDeclines >= 3 && ctrDeclinePct > 20;

    // CPC day-over-day analysis
    const cpcs = rows.map((r) => r.cpc);
    const positiveCpcs = cpcs.filter((c) => c > 0);
    const minCpc = positiveCpcs.length > 0 ? Math.min(...positiveCpcs) : 0;
    let cpcConsecutiveRises = 0;
    let maxCpcRises = 0;
    for (let i = 1; i < cpcs.length; i++) {
      if (cpcs[i] > cpcs[i - 1] && cpcs[i - 1] > 0) {
        cpcConsecutiveRises++;
        maxCpcRises = Math.max(maxCpcRises, cpcConsecutiveRises);
      } else {
        cpcConsecutiveRises = 0;
      }
    }
    const cpcRisePct = minCpc > 0 ? round2((latest.cpc - minCpc) / minCpc * 100) : 0;
    const cpcRising = maxCpcRises >= 3 && cpcRisePct > 15;

    // Frequency check
    const frequencyHigh = latest.frequency > freqHigh;

    // Build signals
    const signals: string[] = [];
    if (ctrDeclining) signals.push('ctr_declining');
    if (cpcRising) signals.push('cpc_rising');
    if (frequencyHigh) signals.push('frequency_high');

    const entry: FatigueEntry = {
      ad_id: adId,
      ad_name: first.ad_name,
      campaign_name: first.campaign_name,
      objective: first.objective,
      signals,
      recommendation: '',
      peak_ctr: round2(peakCtr),
      latest_ctr: round2(latest.ctr),
      ctr_decline_pct: ctrDeclinePct,
      latest_frequency: round2(latest.frequency),
      latest_cpc: round2(latest.cpc),
      spend: round2(totalSpend),
      days_tracked: rows.length,
    };

    if (ctrDeclining && frequencyHigh) {
      entry.recommendation = 'Creative fatigued. Rotate immediately.';
      rotate.push(entry);
    } else if (ctrDeclining && latest.frequency < 2.5) {
      entry.recommendation = 'CTR dipping but frequency low. Monitor 48h.';
      watch.push(entry);
    } else if (signals.length === 0) {
      healthy++;
    } else if (signals.length === 1) {
      entry.recommendation = `Monitor — early ${signals[0].replace('_', ' ')} signal.`;
      watch.push(entry);
    } else {
      entry.recommendation = 'Monitor — mixed signals detected.';
      watch.push(entry);
    }
  }

  // Group counts by campaign_name
  const byCampaign: Record<string, { rotate: number; watch: number; healthy: number }> = {};
  const ensureCampaign = (name: string) => {
    if (!byCampaign[name]) byCampaign[name] = { rotate: 0, watch: 0, healthy: 0 };
  };
  for (const e of rotate) {
    const cn = e.campaign_name ?? 'Unknown';
    ensureCampaign(cn);
    byCampaign[cn].rotate++;
  }
  for (const e of watch) {
    const cn = e.campaign_name ?? 'Unknown';
    ensureCampaign(cn);
    byCampaign[cn].watch++;
  }
  // Healthy ads: count from byAd entries that didn't land in rotate/watch
  const fatiguedAdIds = new Set([...rotate.map((e) => e.ad_id), ...watch.map((e) => e.ad_id)]);
  for (const [adId, rows] of byAd) {
    if (!fatiguedAdIds.has(adId)) {
      const cn = rows[0].campaign_name ?? 'Unknown';
      ensureCampaign(cn);
      byCampaign[cn].healthy++;
    }
  }

  return {
    objectives_present: objectives,
    summary: {
      total_ads: byAd.size,
      rotate: rotate.length,
      watch: watch.length,
      healthy,
      by_campaign: byCampaign,
    },
    rotate,
    watch,
  };
}
