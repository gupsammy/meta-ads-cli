import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creativeScan } from '../../intel/scan.js';

vi.mock('../../lib/http.js', () => ({
  graphRequestWithRetry: vi.fn(),
  paginateAll: vi.fn(),
}));

import { graphRequestWithRetry, paginateAll } from '../../lib/http.js';

const mockGraphRequest = vi.mocked(graphRequestWithRetry);
const mockPaginate = vi.mocked(paginateAll);

function makeAd(id: string, creative?: { title?: string; body?: string; image_url?: string; thumbnail_url?: string }) {
  return { id, name: `Ad ${id}`, creative };
}

function makeCampaign(id: string, objective: string) {
  return { id, objective };
}

function makeInsightsRow(overrides: Record<string, unknown> = {}) {
  return {
    ad_id: '1',
    ad_name: 'Test Ad',
    campaign_id: 'c1',
    campaign_name: 'Test Campaign',
    spend: '100',
    impressions: '5000',
    reach: '3000',
    cpc: '0.67',
    ctr: '3.0',
    cpm: '20',
    actions: [],
    action_values: [],
    purchase_roas: [],
    ...overrides,
  };
}

function setupMocks(
  insights: Record<string, unknown>[],
  ads: { id: string; name?: string; creative?: Record<string, string> }[],
  campaigns: { id: string; objective: string }[],
) {
  mockGraphRequest.mockResolvedValue({ data: insights });
  // paginateAll is called twice: first for ads, then for campaigns
  mockPaginate
    .mockResolvedValueOnce({ data: ads, has_more: false })
    .mockResolvedValueOnce({ data: campaigns, has_more: false });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('creativeScan', () => {
  it('ranks OUTCOME_SALES ads by roas', async () => {
    setupMocks(
      [
        makeInsightsRow({ ad_id: '1', spend: '100', actions: [{ action_type: 'omni_purchase', value: '2' }], purchase_roas: [{ action_type: 'omni_purchase', value: '3.0' }] }),
        makeInsightsRow({ ad_id: '2', ad_name: 'Ad 2', spend: '100', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '5.0' }] }),
      ],
      [makeAd('1', { image_url: 'http://img1' }), makeAd('2', { image_url: 'http://img2' })],
      [makeCampaign('c1', 'CONVERSIONS')],
    );
    const result = await creativeScan('123', 'token');
    const sales = result.by_objective['OUTCOME_SALES'];
    expect(sales.winners[0].roas).toBe(5.0); // Ad 2 has higher roas
    expect(sales.winners.length).toBe(1);
    expect(sales.losers[0].roas).toBe(3.0);
    expect(sales.ads_with_conversions).toBe(2);
  });

  it('ranks OUTCOME_TRAFFIC ads by link_click_ctr', async () => {
    setupMocks(
      [
        makeInsightsRow({ ad_id: '1', impressions: '10000', actions: [{ action_type: 'link_click', value: '500' }] }),
        makeInsightsRow({ ad_id: '2', ad_name: 'Ad 2', impressions: '10000', actions: [{ action_type: 'link_click', value: '200' }] }),
      ],
      [makeAd('1'), makeAd('2')],
      [makeCampaign('c1', 'LINK_CLICKS')],
    );
    const result = await creativeScan('123', 'token');
    const traffic = result.by_objective['OUTCOME_TRAFFIC'];
    expect(traffic.winners[0].link_click_ctr).toBe(5); // 500/10000*100
    expect(traffic.losers[0].link_click_ctr).toBe(2); // 200/10000*100
  });

  it('ranks OUTCOME_ENGAGEMENT ads by 1/cpe', async () => {
    setupMocks(
      [
        makeInsightsRow({ ad_id: '1', spend: '100', actions: [{ action_type: 'post_engagement', value: '200' }] }),
        makeInsightsRow({ ad_id: '2', ad_name: 'Ad 2', spend: '100', actions: [{ action_type: 'post_engagement', value: '50' }] }),
      ],
      [makeAd('1'), makeAd('2')],
      [makeCampaign('c1', 'POST_ENGAGEMENT')],
    );
    const result = await creativeScan('123', 'token');
    const eng = result.by_objective['OUTCOME_ENGAGEMENT'];
    // Ad 1: cpe=0.5, 1/cpe=2. Ad 2: cpe=2, 1/cpe=0.5
    expect(eng.winners[0].cpe).toBe(0.5);
    expect(eng.losers[0].cpe).toBe(2);
  });

  it('ranks OUTCOME_LEADS ads by 1/cpl', async () => {
    setupMocks(
      [
        makeInsightsRow({ ad_id: '1', spend: '100', actions: [{ action_type: 'lead', value: '10' }] }),
        makeInsightsRow({ ad_id: '2', ad_name: 'Ad 2', spend: '100', actions: [{ action_type: 'lead', value: '2' }] }),
      ],
      [makeAd('1'), makeAd('2')],
      [makeCampaign('c1', 'LEAD_GENERATION')],
    );
    const result = await creativeScan('123', 'token');
    const leads = result.by_objective['OUTCOME_LEADS'];
    expect(leads.winners[0].cpl).toBe(10); // 100/10 — cheaper cost per lead wins
    expect(leads.losers[0].cpl).toBe(50);
  });

  it('ranks OUTCOME_APP_PROMOTION ads by 1/cpi', async () => {
    setupMocks(
      [
        makeInsightsRow({ ad_id: '1', spend: '100', actions: [{ action_type: 'app_install', value: '20' }] }),
        makeInsightsRow({ ad_id: '2', ad_name: 'Ad 2', spend: '100', actions: [{ action_type: 'app_install', value: '5' }] }),
      ],
      [makeAd('1'), makeAd('2')],
      [makeCampaign('c1', 'APP_INSTALLS')],
    );
    const result = await creativeScan('123', 'token');
    const app = result.by_objective['OUTCOME_APP_PROMOTION'];
    expect(app.winners[0].cpi).toBe(5); // 100/20
    expect(app.losers[0].cpi).toBe(20); // 100/5
  });

  it('ranks OUTCOME_AWARENESS ads by 1/cpm', async () => {
    setupMocks(
      [
        makeInsightsRow({ ad_id: '1', spend: '100', impressions: '10000', reach: '5000', cpm: '10' }),
        makeInsightsRow({ ad_id: '2', ad_name: 'Ad 2', spend: '100', impressions: '5000', reach: '2000', cpm: '20' }),
      ],
      [makeAd('1'), makeAd('2')],
      [makeCampaign('c1', 'REACH')],
    );
    const result = await creativeScan('123', 'token');
    const awareness = result.by_objective['OUTCOME_AWARENESS'];
    // Ad 1: 1/10 = 0.1, Ad 2: 1/20 = 0.05 → Ad 1 wins (lower CPM is better)
    expect(awareness.winners.length).toBe(1);
    expect(awareness.losers.length).toBe(1);
  });

  it('adaptive ranking: 1 ad → 1 winner, 0 losers', async () => {
    setupMocks(
      [makeInsightsRow({ ad_id: '1', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '2' }] })],
      [makeAd('1')],
      [makeCampaign('c1', 'CONVERSIONS')],
    );
    const result = await creativeScan('123', 'token');
    const sales = result.by_objective['OUTCOME_SALES'];
    expect(sales.winners.length).toBe(1);
    expect(sales.losers.length).toBe(0);
  });

  it('adaptive ranking: 3 ads → 1 winner, 2 losers', async () => {
    setupMocks(
      [
        makeInsightsRow({ ad_id: '1', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '3' }] }),
        makeInsightsRow({ ad_id: '2', ad_name: 'Ad 2', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '2' }] }),
        makeInsightsRow({ ad_id: '3', ad_name: 'Ad 3', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '1' }] }),
      ],
      [makeAd('1'), makeAd('2'), makeAd('3')],
      [makeCampaign('c1', 'CONVERSIONS')],
    );
    const result = await creativeScan('123', 'token');
    const sales = result.by_objective['OUTCOME_SALES'];
    expect(sales.winners.length).toBe(1); // floor(3/2)=1
    expect(sales.losers.length).toBe(2); // min(5, 3-1)=2
  });

  it('adaptive ranking: 10 ads → 5 winners, 5 losers', async () => {
    const insights = Array.from({ length: 10 }, (_, i) =>
      makeInsightsRow({
        ad_id: String(i + 1),
        ad_name: `Ad ${i + 1}`,
        actions: [{ action_type: 'omni_purchase', value: '1' }],
        purchase_roas: [{ action_type: 'omni_purchase', value: String(10 - i) }],
      }),
    );
    const ads = Array.from({ length: 10 }, (_, i) => makeAd(String(i + 1)));
    setupMocks(insights, ads, [makeCampaign('c1', 'CONVERSIONS')]);
    const result = await creativeScan('123', 'token');
    const sales = result.by_objective['OUTCOME_SALES'];
    expect(sales.winners.length).toBe(5);
    expect(sales.losers.length).toBe(5);
  });

  it('detects video format from thumbnail_url', async () => {
    setupMocks(
      [makeInsightsRow({ ad_id: '1', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '2' }] })],
      [makeAd('1', { thumbnail_url: 'http://thumb.jpg', image_url: 'http://img.jpg' })],
      [makeCampaign('c1', 'CONVERSIONS')],
    );
    const result = await creativeScan('123', 'token');
    expect(result.by_objective['OUTCOME_SALES'].winners[0].format).toBe('video');
  });

  it('detects image format from image_url only', async () => {
    setupMocks(
      [makeInsightsRow({ ad_id: '1', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '2' }] })],
      [makeAd('1', { image_url: 'http://img.jpg' })],
      [makeCampaign('c1', 'CONVERSIONS')],
    );
    const result = await creativeScan('123', 'token');
    expect(result.by_objective['OUTCOME_SALES'].winners[0].format).toBe('image');
  });

  it('detects unknown format when no URLs', async () => {
    setupMocks(
      [makeInsightsRow({ ad_id: '1', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '2' }] })],
      [makeAd('1')],
      [makeCampaign('c1', 'CONVERSIONS')],
    );
    const result = await creativeScan('123', 'token');
    expect(result.by_objective['OUTCOME_SALES'].winners[0].format).toBe('unknown');
    expect(result.format_breakdown.unknown).toBe(1);
    expect(result.format_breakdown.confidence).toBe('low'); // 1/1 > 0.3
  });

  it('format confidence is high when unknown < 30%', async () => {
    setupMocks(
      [
        makeInsightsRow({ ad_id: '1', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '3' }] }),
        makeInsightsRow({ ad_id: '2', ad_name: 'Ad 2', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '2' }] }),
        makeInsightsRow({ ad_id: '3', ad_name: 'Ad 3', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '1' }] }),
        makeInsightsRow({ ad_id: '4', ad_name: 'Ad 4', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '0.5' }] }),
      ],
      [
        makeAd('1', { image_url: 'http://img1' }),
        makeAd('2', { thumbnail_url: 'http://thumb2' }),
        makeAd('3', { image_url: 'http://img3' }),
        makeAd('4'), // unknown
      ],
      [makeCampaign('c1', 'CONVERSIONS')],
    );
    const result = await creativeScan('123', 'token');
    expect(result.format_breakdown.confidence).toBe('high'); // 1/4 = 25% < 30%
  });

  it('populates creative fields from ads lookup', async () => {
    setupMocks(
      [makeInsightsRow({ ad_id: '1', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '2' }] })],
      [makeAd('1', { title: 'Great Ad', body: 'Buy now!', image_url: 'http://img.jpg' })],
      [makeCampaign('c1', 'CONVERSIONS')],
    );
    const result = await creativeScan('123', 'token');
    const winner = result.by_objective['OUTCOME_SALES'].winners[0];
    expect(winner.creative_title).toBe('Great Ad');
    expect(winner.creative_body).toBe('Buy now!');
  });

  it('defaults creative fields to empty string when ad not in lookup', async () => {
    setupMocks(
      [makeInsightsRow({ ad_id: '999', actions: [{ action_type: 'omni_purchase', value: '1' }], purchase_roas: [{ action_type: 'omni_purchase', value: '2' }] })],
      [], // no ads in lookup
      [makeCampaign('c1', 'CONVERSIONS')],
    );
    const result = await creativeScan('123', 'token');
    const winner = result.by_objective['OUTCOME_SALES'].winners[0];
    expect(winner.creative_title).toBe('');
    expect(winner.creative_body).toBe('');
  });

  it('handles empty insights', async () => {
    setupMocks([], [makeAd('1')], [makeCampaign('c1', 'CONVERSIONS')]);
    const result = await creativeScan('123', 'token');
    expect(result.by_objective).toEqual({});
    expect(result.total_ads).toBe(0);
    expect(result.format_breakdown.confidence).toBe('n/a');
  });
});
