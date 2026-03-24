import type { CampaignSummary, IntelConfig, FunnelData, Bottleneck } from '../types.js';
import { round2 } from '../metrics.js';

interface BottleneckCandidate {
  stage: string;
  label: string;
  rate: number | null;
  expected: number;
}

function detectBottleneck(candidates: BottleneckCandidate[]): Bottleneck | null {
  const valid = candidates.filter((c) => c.rate !== null) as (BottleneckCandidate & { rate: number })[];
  if (valid.length === 0) return null;

  const withGap = valid.map((c) => ({
    ...c,
    gap: c.expected > 0 ? (c.expected - c.rate) / c.expected : 0,
  }));

  withGap.sort((a, b) => b.gap - a.gap);
  const top = withGap[0];
  return { stage: top.stage, label: top.label, rate: top.rate };
}

function sum(items: CampaignSummary[], field: keyof CampaignSummary): number {
  return items.reduce((s, c) => s + (c[field] as number), 0);
}

/**
 * Compute per-objective conversion funnels with bottleneck detection.
 * Port of prepare-analysis.sh lines 400-587.
 */
export function computeFunnel(campaigns: CampaignSummary[], config: IntelConfig): FunnelData {
  const funnelRates = config.funnel_expected_rates ?? {};
  const objectives = [...new Set(campaigns.map((c) => c.objective))].sort();

  const result: FunnelData = { objectives_present: objectives };

  for (const obj of objectives) {
    const group = campaigns.filter((c) => c.objective === obj);
    const objRates = funnelRates[obj] ?? {};

    if (obj === 'OUTCOME_SALES') {
      const imp = sum(group, 'impressions');
      const lc = sum(group, 'link_clicks');
      const lpv = sum(group, 'landing_page_views');
      const vc = sum(group, 'view_content');
      const atc = sum(group, 'add_to_cart');
      const ic = sum(group, 'initiate_checkout');
      const p = sum(group, 'purchases');

      const clickRate = imp > 0 ? round2(lc / imp * 100) : null;
      const landingRate = lc > 0 ? round2(lpv / lc * 100) : null;
      const addToCartRate = lpv > 0 ? round2(atc / lpv * 100) : null;
      const cartToCheckout = atc > 0 ? round2(ic / atc * 100) : null;
      const checkoutToPurchase = ic > 0 ? round2(p / ic * 100) : null;

      result[obj] = {
        type: 'funnel',
        stages: ['impressions', 'link_clicks', 'landing_page_views', 'view_content', 'add_to_cart', 'initiate_checkout', 'purchases'],
        impressions: imp,
        link_clicks: lc,
        landing_page_views: lpv,
        view_content: vc,
        add_to_cart: atc,
        initiate_checkout: ic,
        purchases: p,
        rates: {
          click_rate: clickRate,
          landing_rate: landingRate,
          add_to_cart_rate: addToCartRate,
          cart_to_checkout: cartToCheckout,
          checkout_to_purchase: checkoutToPurchase,
        },
        engagement: {
          view_content: vc,
          browse_depth: lpv > 0 ? round2(vc / lpv) : null,
        },
        bottleneck: detectBottleneck([
          { stage: 'TOFU_click', label: 'impression → click', rate: clickRate, expected: objRates.click_rate ?? 3.0 },
          { stage: 'TOFU_landing', label: 'click → landing page', rate: landingRate, expected: objRates.landing_rate ?? 70.0 },
          { stage: 'MOFU_landing_to_cart', label: 'landing page → add to cart', rate: addToCartRate, expected: objRates.add_to_cart_rate ?? 8.0 },
          { stage: 'BOFU_cart_to_checkout', label: 'add to cart → checkout', rate: cartToCheckout, expected: objRates.cart_to_checkout ?? 50.0 },
          { stage: 'BOFU_checkout_to_purchase', label: 'checkout → purchase', rate: checkoutToPurchase, expected: objRates.checkout_to_purchase ?? 60.0 },
        ]),
      };
    } else if (obj === 'OUTCOME_TRAFFIC') {
      const imp = sum(group, 'impressions');
      const lc = sum(group, 'link_clicks');
      const lpv = sum(group, 'landing_page_views');

      const clickRate = imp > 0 ? round2(lc / imp * 100) : null;
      const landingRate = lc > 0 ? round2(lpv / lc * 100) : null;

      result[obj] = {
        type: 'funnel',
        stages: ['impressions', 'link_clicks', 'landing_page_views'],
        impressions: imp,
        link_clicks: lc,
        landing_page_views: lpv,
        rates: { click_rate: clickRate, landing_rate: landingRate },
        bottleneck: detectBottleneck([
          { stage: 'click_rate', label: 'impression → click', rate: clickRate, expected: objRates.click_rate ?? 1.5 },
          { stage: 'landing_rate', label: 'click → landing page', rate: landingRate, expected: objRates.landing_rate ?? 70.0 },
        ]),
      };
    } else if (obj === 'OUTCOME_AWARENESS') {
      const imp = sum(group, 'impressions');
      const rch = sum(group, 'reach');
      const spend = sum(group, 'spend');
      const vv = sum(group, 'video_view');

      result[obj] = {
        type: 'reach_efficiency',
        total_reach: rch,
        total_impressions: imp,
        total_spend: spend,
        video_views: vv,
        cpm: imp > 0 ? round2(spend / imp * 1000) : null,
        cost_per_view: vv > 0 ? round2(spend / vv) : null,
        avg_frequency: rch > 0 ? round2(imp / rch) : null,
        reach_rate: imp > 0 ? round2(rch / imp * 100) : null,
        note: 'No conversion funnel for awareness — showing reach efficiency metrics',
      };
    } else if (obj === 'OUTCOME_ENGAGEMENT') {
      const imp = sum(group, 'impressions');
      const pe = sum(group, 'post_engagement');
      const pge = sum(group, 'page_engagement');

      const engRate = imp > 0 ? round2(pe / imp * 100) : null;
      const deepEngRate = pe > 0 ? round2(pge / pe * 100) : null;

      result[obj] = {
        type: 'funnel',
        stages: ['impressions', 'post_engagement', 'page_engagement'],
        impressions: imp,
        post_engagement: pe,
        page_engagement: pge,
        rates: { engagement_rate: engRate, deep_engagement_rate: deepEngRate },
        bottleneck: detectBottleneck([
          { stage: 'engagement_rate', label: 'impression → engagement', rate: engRate, expected: objRates.engagement_rate ?? 2.0 },
          { stage: 'deep_engagement_rate', label: 'engagement → page engagement', rate: deepEngRate, expected: objRates.deep_engagement_rate ?? 15.0 },
        ]),
      };
    } else if (obj === 'OUTCOME_LEADS') {
      const imp = sum(group, 'impressions');
      const lc = sum(group, 'link_clicks');
      const lpv = sum(group, 'landing_page_views');
      const ld = sum(group, 'lead');

      const clickRate = imp > 0 ? round2(lc / imp * 100) : null;
      const landingRate = lc > 0 ? round2(lpv / lc * 100) : null;
      const leadConvRate = lpv > 0 ? round2(ld / lpv * 100) : null;

      result[obj] = {
        type: 'funnel',
        stages: ['impressions', 'link_clicks', 'landing_page_views', 'leads'],
        impressions: imp,
        link_clicks: lc,
        landing_page_views: lpv,
        leads: ld,
        rates: { click_rate: clickRate, landing_rate: landingRate, lead_conversion_rate: leadConvRate },
        bottleneck: detectBottleneck([
          { stage: 'click_rate', label: 'impression → click', rate: clickRate, expected: objRates.click_rate ?? 2.0 },
          { stage: 'landing_rate', label: 'click → landing page', rate: landingRate, expected: objRates.landing_rate ?? 60.0 },
          { stage: 'lead_conversion', label: 'landing page → lead', rate: leadConvRate, expected: objRates.lead_conversion_rate ?? 5.0 },
        ]),
      };
    } else if (obj === 'OUTCOME_APP_PROMOTION') {
      const imp = sum(group, 'impressions');
      const lc = sum(group, 'link_clicks');
      const ai = sum(group, 'app_install');

      const clickRate = imp > 0 ? round2(lc / imp * 100) : null;
      const installRate = lc > 0 ? round2(ai / lc * 100) : null;

      result[obj] = {
        type: 'funnel',
        stages: ['impressions', 'link_clicks', 'app_installs'],
        impressions: imp,
        link_clicks: lc,
        app_installs: ai,
        rates: { click_rate: clickRate, install_rate: installRate },
        bottleneck: detectBottleneck([
          { stage: 'click_rate', label: 'impression → click', rate: clickRate, expected: objRates.click_rate ?? 1.5 },
          { stage: 'install_rate', label: 'click → install', rate: installRate, expected: objRates.install_rate ?? 5.0 },
        ]),
      };
    } else {
      result[obj] = {
        type: 'unknown',
        note: `No funnel defined for objective ${obj}`,
      };
    }
  }

  return result;
}
