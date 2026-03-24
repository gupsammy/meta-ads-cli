import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeDefaults } from '../../intel/defaults.js';

// Mock the HTTP layer
vi.mock('../../lib/http.js', () => ({
  graphRequestWithRetry: vi.fn(),
  paginateAll: vi.fn(),
}));

import { graphRequestWithRetry, paginateAll } from '../../lib/http.js';

const mockGraphRequest = vi.mocked(graphRequestWithRetry);
const mockPaginate = vi.mocked(paginateAll);

function makeCampaign(id: string, objective: string) {
  return { id, objective };
}

function makeInsightsRow(overrides: Record<string, unknown> = {}) {
  return {
    campaign_id: '1',
    spend: '1000',
    impressions: '50000',
    clicks: '1500',
    cpc: '0.67',
    ctr: '3.0',
    cpm: '20',
    reach: '30000',
    frequency: '1.67',
    actions: [],
    action_values: [],
    purchase_roas: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

function setupMocks(campaigns: { id: string; objective: string }[], insights: Record<string, unknown>[]) {
  mockPaginate.mockResolvedValue({ data: campaigns, has_more: false });
  mockGraphRequest.mockResolvedValue({ data: insights });
}

describe('computeDefaults', () => {
  it('computes OUTCOME_SALES KPIs', async () => {
    setupMocks(
      [makeCampaign('1', 'CONVERSIONS')],
      [makeInsightsRow({
        actions: [{ action_type: 'omni_purchase', value: '10' }],
        action_values: [{ action_type: 'omni_purchase', value: '500' }],
        purchase_roas: [{ action_type: 'omni_purchase', value: '0.5' }],
      })],
    );
    const result = await computeDefaults('123', 'token');
    expect(result.objectives['OUTCOME_SALES']).toEqual({
      campaign_count: 1,
      spend: 1000,
      purchases: 10,
      revenue: 500,
      current_cpa: 100,
      current_roas: 0.5,
    });
    expect(result.total_spend).toBe(1000);
    expect(result.objectives_detected).toEqual(['OUTCOME_SALES']);
  });

  it('computes OUTCOME_TRAFFIC KPIs', async () => {
    setupMocks(
      [makeCampaign('1', 'LINK_CLICKS')],
      [makeInsightsRow({
        actions: [{ action_type: 'link_click', value: '200' }, { action_type: 'landing_page_view', value: '150' }],
      })],
    );
    const result = await computeDefaults('123', 'token');
    const traffic = result.objectives['OUTCOME_TRAFFIC'];
    expect(traffic.link_clicks).toBe(200);
    expect(traffic.landing_page_views).toBe(150);
    expect(traffic.current_cpc).toBe(5); // 1000/200
    expect(traffic.current_link_ctr).toBe(0.4); // 200/50000*100
  });

  it('computes OUTCOME_AWARENESS KPIs', async () => {
    setupMocks(
      [makeCampaign('1', 'BRAND_AWARENESS')],
      [makeInsightsRow({
        actions: [{ action_type: 'video_view', value: '5000' }],
      })],
    );
    const result = await computeDefaults('123', 'token');
    const awareness = result.objectives['OUTCOME_AWARENESS'];
    expect(awareness.impressions).toBe(50000);
    expect(awareness.reach).toBe(30000);
    expect(awareness.video_views).toBe(5000);
    expect(awareness.current_cpm).toBe(20); // 1000/50000*1000
    expect(awareness.current_cpv).toBe(0.2); // 1000/5000
    expect(awareness.avg_frequency).toBe(1.67); // 50000/30000
  });

  it('computes OUTCOME_ENGAGEMENT KPIs', async () => {
    setupMocks(
      [makeCampaign('1', 'POST_ENGAGEMENT')],
      [makeInsightsRow({
        actions: [{ action_type: 'post_engagement', value: '2000' }],
      })],
    );
    const result = await computeDefaults('123', 'token');
    const eng = result.objectives['OUTCOME_ENGAGEMENT'];
    expect(eng.post_engagement).toBe(2000);
    expect(eng.current_cpe).toBe(0.5); // 1000/2000
    expect(eng.engagement_rate).toBe(4); // 2000/50000*100
  });

  it('computes OUTCOME_LEADS KPIs', async () => {
    setupMocks(
      [makeCampaign('1', 'LEAD_GENERATION')],
      [makeInsightsRow({
        actions: [{ action_type: 'lead', value: '20' }],
      })],
    );
    const result = await computeDefaults('123', 'token');
    const leads = result.objectives['OUTCOME_LEADS'];
    expect(leads.leads).toBe(20);
    expect(leads.current_cpl).toBe(50); // 1000/20
  });

  it('computes OUTCOME_APP_PROMOTION KPIs', async () => {
    setupMocks(
      [makeCampaign('1', 'APP_INSTALLS')],
      [makeInsightsRow({
        actions: [{ action_type: 'app_install', value: '100' }],
      })],
    );
    const result = await computeDefaults('123', 'token');
    const app = result.objectives['OUTCOME_APP_PROMOTION'];
    expect(app.app_installs).toBe(100);
    expect(app.current_cpi).toBe(10); // 1000/100
  });

  it('handles multiple objectives', async () => {
    setupMocks(
      [makeCampaign('1', 'CONVERSIONS'), makeCampaign('2', 'LINK_CLICKS')],
      [
        makeInsightsRow({
          campaign_id: '1',
          spend: '500',
          actions: [{ action_type: 'omni_purchase', value: '5' }],
          action_values: [{ action_type: 'omni_purchase', value: '250' }],
        }),
        makeInsightsRow({
          campaign_id: '2',
          spend: '500',
          actions: [{ action_type: 'link_click', value: '100' }],
        }),
      ],
    );
    const result = await computeDefaults('123', 'token');
    expect(result.objectives_detected).toEqual(['OUTCOME_SALES', 'OUTCOME_TRAFFIC']);
    expect(result.total_spend).toBe(1000);
    expect(result.objectives['OUTCOME_SALES'].campaign_count).toBe(1);
    expect(result.objectives['OUTCOME_TRAFFIC'].campaign_count).toBe(1);
  });

  it('returns empty KPIs for unknown objectives', async () => {
    setupMocks(
      [makeCampaign('1', 'SOME_FUTURE_OBJECTIVE')],
      [makeInsightsRow()],
    );
    const result = await computeDefaults('123', 'token');
    expect(result.objectives['SOME_FUTURE_OBJECTIVE']).toEqual({
      campaign_count: 1,
      spend: 1000,
    });
  });

  it('returns null KPIs when zero conversions', async () => {
    setupMocks(
      [makeCampaign('1', 'CONVERSIONS')],
      [makeInsightsRow({ actions: [], action_values: [], purchase_roas: [] })],
    );
    const result = await computeDefaults('123', 'token');
    const sales = result.objectives['OUTCOME_SALES'];
    expect(sales.purchases).toBe(0);
    expect(sales.current_cpa).toBeNull();
    expect(sales.current_roas).toBe(0); // revenue=0, 0/1000=0
  });

  it('handles empty insights', async () => {
    setupMocks([makeCampaign('1', 'CONVERSIONS')], []);
    const result = await computeDefaults('123', 'token');
    expect(result.objectives).toEqual({});
    expect(result.total_spend).toBe(0);
    expect(result.objectives_detected).toEqual([]);
  });

  it('stringifies numeric campaign IDs', async () => {
    setupMocks(
      [makeCampaign('12345', 'CONVERSIONS')],
      [makeInsightsRow({
        campaign_id: 12345,
        actions: [{ action_type: 'purchase', value: '2' }],
        action_values: [{ action_type: 'purchase', value: '100' }],
      })],
    );
    const result = await computeDefaults('123', 'token');
    expect(result.objectives['OUTCOME_SALES']).toBeDefined();
    expect(result.objectives['OUTCOME_SALES'].campaign_count).toBe(1);
  });

  it('rounds KPIs to 2 decimal places', async () => {
    setupMocks(
      [makeCampaign('1', 'CONVERSIONS')],
      [makeInsightsRow({
        spend: '333',
        actions: [{ action_type: 'omni_purchase', value: '7' }],
        action_values: [{ action_type: 'omni_purchase', value: '123' }],
      })],
    );
    const result = await computeDefaults('123', 'token');
    const sales = result.objectives['OUTCOME_SALES'];
    expect(sales.current_cpa).toBe(47.57); // 333/7 = 47.5714... → 47.57
    expect(sales.current_roas).toBe(0.37); // 123/333 = 0.3693... → 0.37
  });

  it('strips act_ prefix from accountId in API paths', async () => {
    setupMocks([makeCampaign('1', 'CONVERSIONS')], [makeInsightsRow()]);
    await computeDefaults('903322579535495', 'token');
    expect(mockPaginate).toHaveBeenCalledWith(
      '/act_903322579535495/campaigns',
      'token',
      expect.any(Object),
    );
    expect(mockGraphRequest).toHaveBeenCalledWith(
      '/act_903322579535495/insights',
      'token',
      expect.any(Object),
    );
  });
});
