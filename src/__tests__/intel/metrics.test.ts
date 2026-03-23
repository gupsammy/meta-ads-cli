import { describe, it, expect } from 'vitest';
import { attrGuard, omniFirst, extractMetrics, addDerived, round2 } from '../../intel/metrics.js';
import type { ActionEntry, InsightsRow, ExtractedMetrics } from '../../intel/types.js';

describe('round2', () => {
  it('rounds to 2 decimal places', () => {
    expect(round2(1.005)).toBe(1);
    expect(round2(0.015)).toBe(0.02);
    expect(round2(99.995)).toBe(100);
    expect(round2(3.14159)).toBe(3.14);
    expect(round2(0)).toBe(0);
  });
});

describe('attrGuard', () => {
  it('returns [] for null input', () => {
    expect(attrGuard(null)).toEqual([]);
  });

  it('returns [] for undefined input', () => {
    expect(attrGuard(undefined)).toEqual([]);
  });

  it('returns [] for empty array', () => {
    expect(attrGuard([])).toEqual([]);
  });

  it('filters entries with action_attribution_window', () => {
    const actions: ActionEntry[] = [
      { action_type: 'purchase', value: '5' },
      { action_type: 'purchase', value: '3', action_attribution_window: '7d_click' },
      { action_type: 'link_click', value: '10' },
    ];
    const result = attrGuard(actions);
    expect(result).toEqual([
      { action_type: 'purchase', value: '5' },
      { action_type: 'link_click', value: '10' },
    ]);
  });

  it('falls back to original when all entries have attribution windows', () => {
    const actions: ActionEntry[] = [
      { action_type: 'purchase', value: '5', action_attribution_window: '7d_click' },
      { action_type: 'purchase', value: '3', action_attribution_window: '1d_view' },
    ];
    const result = attrGuard(actions);
    expect(result).toEqual(actions);
  });

  it('preserves entries without attribution windows', () => {
    const actions: ActionEntry[] = [
      { action_type: 'purchase', value: '5' },
      { action_type: 'link_click', value: '10' },
    ];
    expect(attrGuard(actions)).toEqual(actions);
  });
});

describe('omniFirst', () => {
  it('returns 0 for empty array', () => {
    expect(omniFirst([], ['purchase'])).toBe(0);
  });

  it('returns 0 when no matching types', () => {
    const actions: ActionEntry[] = [
      { action_type: 'link_click', value: '10' },
    ];
    expect(omniFirst(actions, ['purchase'])).toBe(0);
  });

  it('picks first priority match (omni_purchase over purchase)', () => {
    const actions: ActionEntry[] = [
      { action_type: 'purchase', value: '3' },
      { action_type: 'omni_purchase', value: '5' },
    ];
    expect(omniFirst(actions, ['omni_purchase', 'purchase'])).toBe(5);
  });

  it('handles string values via parseFloat', () => {
    const actions: ActionEntry[] = [
      { action_type: 'purchase', value: '12.50' },
    ];
    expect(omniFirst(actions, ['purchase'])).toBe(12.5);
  });

  it('returns 0 for non-numeric value', () => {
    const actions: ActionEntry[] = [
      { action_type: 'purchase', value: 'abc' },
    ];
    expect(omniFirst(actions, ['purchase'])).toBe(0);
  });

  it('handles single-element priority list', () => {
    const actions: ActionEntry[] = [
      { action_type: 'link_click', value: '42' },
      { action_type: 'purchase', value: '3' },
    ];
    expect(omniFirst(actions, ['link_click'])).toBe(42);
  });

  it('picks highest priority when all present', () => {
    const actions: ActionEntry[] = [
      { action_type: 'app_install', value: '1' },
      { action_type: 'omni_app_install', value: '3' },
      { action_type: 'mobile_app_install', value: '2' },
    ];
    expect(omniFirst(actions, ['omni_app_install', 'mobile_app_install', 'app_install'])).toBe(3);
  });

  it('falls back to lower priority if higher is missing', () => {
    const actions: ActionEntry[] = [
      { action_type: 'purchase', value: '7' },
    ];
    expect(omniFirst(actions, ['omni_purchase', 'purchase'])).toBe(7);
  });

  it('handles numeric value type', () => {
    const actions: ActionEntry[] = [
      { action_type: 'purchase', value: 9 },
    ];
    expect(omniFirst(actions, ['purchase'])).toBe(9);
  });
});

describe('extractMetrics', () => {
  it('extracts full insights row with all fields', () => {
    const row: InsightsRow = {
      spend: '100.50',
      impressions: '5000',
      clicks: '150',
      cpc: '0.67',
      ctr: '3.0',
      cpm: '20.10',
      frequency: '1.5',
      reach: '3333',
      actions: [
        { action_type: 'omni_purchase', value: '10' },
        { action_type: 'purchase', value: '8' },
        { action_type: 'omni_add_to_cart', value: '25' },
        { action_type: 'omni_initiated_checkout', value: '15' },
        { action_type: 'omni_view_content', value: '200' },
        { action_type: 'link_click', value: '120' },
        { action_type: 'landing_page_view', value: '100' },
        { action_type: 'post_engagement', value: '50' },
        { action_type: 'page_engagement', value: '45' },
        { action_type: 'onsite_conversion.lead_grouped', value: '5' },
        { action_type: 'omni_app_install', value: '2' },
        { action_type: 'video_view', value: '300' },
      ],
      action_values: [
        { action_type: 'omni_purchase', value: '500.00' },
      ],
      purchase_roas: [
        { action_type: 'omni_purchase', value: '4.97' },
      ],
    };

    const result = extractMetrics(row);

    expect(result.spend).toBe(100.5);
    expect(result.impressions).toBe(5000);
    expect(result.clicks).toBe(150);
    expect(result.cpc).toBe(0.67);
    expect(result.ctr).toBe(3.0);
    expect(result.cpm).toBe(20.1);
    expect(result.frequency).toBe(1.5);
    expect(result.reach).toBe(3333);
    expect(result.purchases).toBe(10);
    expect(result.revenue).toBe(500);
    expect(result.roas).toBe(4.97);
    expect(result.add_to_cart).toBe(25);
    expect(result.initiate_checkout).toBe(15);
    expect(result.view_content).toBe(200);
    expect(result.link_clicks).toBe(120);
    expect(result.landing_page_views).toBe(100);
    expect(result.post_engagement).toBe(50);
    expect(result.page_engagement).toBe(45);
    expect(result.lead).toBe(5);
    expect(result.app_install).toBe(2);
    expect(result.video_view).toBe(300);
  });

  it('defaults missing fields to 0', () => {
    const row: InsightsRow = {};
    const result = extractMetrics(row);

    expect(result.spend).toBe(0);
    expect(result.impressions).toBe(0);
    expect(result.purchases).toBe(0);
    expect(result.revenue).toBe(0);
    expect(result.roas).toBe(0);
    expect(result.link_clicks).toBe(0);
    expect(result.video_view).toBe(0);
  });

  it('filters attribution-window duplicates correctly', () => {
    const row: InsightsRow = {
      spend: '50',
      impressions: '1000',
      actions: [
        { action_type: 'purchase', value: '5' },
        { action_type: 'purchase', value: '3', action_attribution_window: '7d_click' },
        { action_type: 'purchase', value: '2', action_attribution_window: '1d_view' },
      ],
    };
    const result = extractMetrics(row);
    expect(result.purchases).toBe(5);
  });

  it('picks omni_purchase over purchase', () => {
    const row: InsightsRow = {
      actions: [
        { action_type: 'purchase', value: '3' },
        { action_type: 'omni_purchase', value: '5' },
      ],
    };
    expect(extractMetrics(row).purchases).toBe(5);
  });

  it('falls back to purchase when omni_purchase missing', () => {
    const row: InsightsRow = {
      actions: [
        { action_type: 'purchase', value: '7' },
      ],
    };
    expect(extractMetrics(row).purchases).toBe(7);
  });

  it('handles row with no actions array', () => {
    const row: InsightsRow = {
      spend: '200',
      impressions: '10000',
    };
    const result = extractMetrics(row);
    expect(result.spend).toBe(200);
    expect(result.impressions).toBe(10000);
    expect(result.purchases).toBe(0);
    expect(result.link_clicks).toBe(0);
    expect(result.revenue).toBe(0);
  });
});

describe('addDerived', () => {
  const base: ExtractedMetrics = {
    spend: 100, impressions: 10000, clicks: 200,
    cpc: 0.5, ctr: 2.0, cpm: 10, frequency: 1.2, reach: 8333,
    purchases: 5, revenue: 250, roas: 2.5,
    add_to_cart: 20, initiate_checkout: 10, view_content: 100,
    link_clicks: 80, landing_page_views: 60, post_engagement: 40,
    page_engagement: 35, lead: 3, app_install: 2, video_view: 150,
  };

  it('computes all derived fields when divisors > 0', () => {
    const result = addDerived(base);
    expect(result.cpa).toBe(20);
    expect(result.cpe).toBe(2.5);
    expect(result.cpl).toBeCloseTo(33.33, 1);
    expect(result.cpi).toBe(50);
    expect(result.link_click_ctr).toBe(0.8);
    expect(result.link_click_cpc).toBe(1.25);
  });

  it('returns null cpa when purchases is 0', () => {
    const result = addDerived({ ...base, purchases: 0 });
    expect(result.cpa).toBeNull();
    expect(result.cpe).toBe(2.5);
  });

  it('returns 0 link_click_ctr when impressions is 0', () => {
    const result = addDerived({ ...base, impressions: 0 });
    expect(result.link_click_ctr).toBe(0);
  });

  it('returns null link_click_cpc when link_clicks is 0', () => {
    const result = addDerived({ ...base, link_clicks: 0 });
    expect(result.link_click_cpc).toBeNull();
  });

  it('returns null cpe when post_engagement is 0', () => {
    const result = addDerived({ ...base, post_engagement: 0 });
    expect(result.cpe).toBeNull();
  });

  it('returns null cpl when lead is 0', () => {
    const result = addDerived({ ...base, lead: 0 });
    expect(result.cpl).toBeNull();
  });

  it('returns null cpi when app_install is 0', () => {
    const result = addDerived({ ...base, app_install: 0 });
    expect(result.cpi).toBeNull();
  });

  it('preserves all base ExtractedMetrics fields', () => {
    const result = addDerived(base);
    expect(result.spend).toBe(100);
    expect(result.purchases).toBe(5);
    expect(result.video_view).toBe(150);
  });
});
