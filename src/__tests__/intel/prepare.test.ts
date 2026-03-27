import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepare } from '../../intel/prepare/index.js';

let tmpDir: string;
let configPath: string;

/** Minimal config v2 with SALES + TRAFFIC targets */
function makeConfig(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    account_id: 'act_123',
    account_name: 'Test Account',
    currency: 'USD',
    config_version: 2,
    objectives_detected: ['OUTCOME_SALES', 'OUTCOME_TRAFFIC'],
    primary_objective: 'OUTCOME_SALES',
    targets: {
      OUTCOME_SALES: { cpa: 50, roas: 2.0 },
      OUTCOME_TRAFFIC: { cpc: 1.0, ctr: 2.0 },
      OUTCOME_AWARENESS: { cpm: 10, cpv: 0.05 },
      OUTCOME_ENGAGEMENT: { cpe: 0.5 },
      OUTCOME_LEADS: { cpl: 20 },
      OUTCOME_APP_PROMOTION: { cpi: 3 },
      global: { max_frequency: 5.0, min_spend: 0 },
    },
    analysis: { top_n: 15, bottom_n: 10, zero_conversion_n: 10 },
    funnel_expected_rates: {
      OUTCOME_SALES: { click_rate: 3.0, landing_rate: 70.0, add_to_cart_rate: 8.0, cart_to_checkout: 50.0, checkout_to_purchase: 60.0 },
      OUTCOME_TRAFFIC: { click_rate: 1.5, landing_rate: 70.0 },
    },
    ...overrides,
  };
}

/** Minimal campaign summary row */
function makeCampaign(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    campaign_id: 'c1',
    campaign_name: 'Campaign 1',
    objective: 'OUTCOME_SALES',
    date_start: '2026-03-01',
    date_stop: '2026-03-14',
    spend: 1000,
    impressions: 50000,
    clicks: 1500,
    cpc: 0.67,
    ctr: 3.0,
    cpm: 20.0,
    frequency: 1.5,
    reach: 33000,
    purchases: 20,
    revenue: 3000,
    roas: 3.0,
    add_to_cart: 100,
    initiate_checkout: 50,
    view_content: 200,
    link_clicks: 800,
    landing_page_views: 600,
    post_engagement: 500,
    page_engagement: 50,
    lead: 0,
    app_install: 0,
    video_view: 0,
    cpa: 50,
    cpe: 2,
    cpl: null,
    cpi: null,
    link_click_ctr: 1.6,
    link_click_cpc: 1.25,
    ...overrides,
  };
}

/** Minimal adset summary row */
function makeAdset(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    adset_id: 'as1',
    adset_name: 'Adset 1',
    campaign_id: 'c1',
    campaign_name: 'Campaign 1',
    objective: 'OUTCOME_SALES',
    date_start: '2026-03-01',
    date_stop: '2026-03-14',
    spend: 500,
    impressions: 25000,
    clicks: 750,
    cpc: 0.67,
    ctr: 3.0,
    cpm: 20.0,
    frequency: 1.5,
    reach: 16500,
    purchases: 10,
    revenue: 1500,
    roas: 3.0,
    add_to_cart: 50,
    initiate_checkout: 25,
    view_content: 100,
    link_clicks: 400,
    landing_page_views: 300,
    post_engagement: 250,
    page_engagement: 25,
    lead: 0,
    app_install: 0,
    video_view: 0,
    cpa: 50,
    cpe: 2,
    cpl: null,
    cpi: null,
    link_click_ctr: 1.6,
    link_click_cpc: 1.25,
    ...overrides,
  };
}

/** Minimal ad summary row */
function makeAd(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ad_id: 'a1',
    ad_name: 'Ad 1',
    adset_id: 'as1',
    campaign_id: 'c1',
    campaign_name: 'Campaign 1',
    objective: 'OUTCOME_SALES',
    date_start: '2026-03-01',
    date_stop: '2026-03-14',
    spend: 250,
    impressions: 12500,
    clicks: 375,
    cpc: 0.67,
    ctr: 3.0,
    cpm: 20.0,
    frequency: 1.5,
    reach: 8250,
    purchases: 5,
    revenue: 750,
    roas: 3.0,
    add_to_cart: 25,
    initiate_checkout: 12,
    view_content: 50,
    link_clicks: 200,
    landing_page_views: 150,
    post_engagement: 125,
    page_engagement: 12,
    lead: 0,
    app_install: 0,
    video_view: 0,
    cpa: 50,
    cpe: 2,
    cpl: null,
    cpi: null,
    link_click_ctr: 1.6,
    link_click_cpc: 1.25,
    creative_body: 'Buy now!',
    creative_title: 'Sale',
    ...overrides,
  };
}

function writeJson(relativePath: string, data: unknown): void {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2));
}

function readOutput(filename: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, filename), 'utf-8'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-test-'));
  configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(makeConfig()));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Pipeline status ──────────────────────────────────────────────

describe('pipeline status', () => {
  it('produces complete status when all input files present', async () => {
    writeJson('_summaries/campaigns-summary.json', [makeCampaign()]);
    writeJson('_summaries/adsets-summary.json', [makeAdset()]);
    writeJson('_summaries/ads-summary.json', [makeAd()]);

    const status = await prepare(tmpDir, configPath);
    expect(status.status).toBe('complete');
    expect(status.files_produced).toContain('account-health.json');
    expect(status.files_produced).toContain('budget-actions.json');
    expect(status.files_produced).toContain('funnel.json');
    expect(status.files_produced).toContain('trends.json');
    expect(status.files_produced).toContain('creative-analysis.json');
    expect(status.files_produced).toContain('creative-media.json');
    expect(status.files_skipped).toEqual([]);
    expect(status.warnings).toEqual([]);
  });

  it('produces partial status when only campaigns present', async () => {
    writeJson('_summaries/campaigns-summary.json', [makeCampaign()]);

    const status = await prepare(tmpDir, configPath);
    expect(status.status).toBe('partial');
    expect(status.files_skipped).toContain('budget-actions.json');
    expect(status.files_skipped).toContain('creative-analysis.json');
  });

  it('files_skipped is empty array not [""] when all present', async () => {
    writeJson('_summaries/campaigns-summary.json', [makeCampaign()]);
    writeJson('_summaries/adsets-summary.json', [makeAdset()]);
    writeJson('_summaries/ads-summary.json', [makeAd()]);

    const status = await prepare(tmpDir, configPath);
    expect(status.files_skipped).toEqual([]);
    expect(status.files_skipped).not.toContain('');
  });

  it('merges pull-warnings.json into pipeline status', async () => {
    writeJson('_summaries/campaigns-summary.json', [makeCampaign()]);
    writeJson('_pull-warnings.json', ['rate limit hit on page 3']);

    await prepare(tmpDir, configPath);
    const status = readOutput('pipeline-status.json') as Record<string, unknown>;
    expect(status.warnings).toEqual(['rate limit hit on page 3']);
    // _pull-warnings.json should be deleted
    expect(fs.existsSync(path.join(tmpDir, '_pull-warnings.json'))).toBe(false);
  });

  it('throws on v1 config', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ ...makeConfig(), config_version: 1 }));
    writeJson('_summaries/campaigns-summary.json', [makeCampaign()]);

    expect(() => prepare(tmpDir, configPath)).toThrow('v1 format');
  });

  it('throws on missing config', async () => {
    fs.unlinkSync(configPath);
    writeJson('_summaries/campaigns-summary.json', [makeCampaign()]);

    expect(() => prepare(tmpDir, path.join(tmpDir, 'nonexistent.json'))).toThrow('not found');
  });
});

// ─── Account health ───────────────────────────────────────────────

describe('account health', () => {
  it('computes OUTCOME_SALES KPIs with vs_target percentages', async () => {
    writeJson('_summaries/campaigns-summary.json', [makeCampaign({ purchases: 20, revenue: 3000, spend: 1000 })]);

    await prepare(tmpDir, configPath);
    const health = readOutput('account-health.json') as Record<string, unknown>;
    const sales = health.OUTCOME_SALES as Record<string, unknown>;

    expect(sales.purchases).toBe(20);
    expect(sales.revenue).toBe(3000);
    expect(sales.cpa).toBe(50); // 1000 / 20
    expect(sales.roas).toBe(3.0); // 3000 / 1000
    expect(sales.target_cpa).toBe(50);
    expect(sales.target_roas).toBe(2.0);
    expect(sales.cpa_vs_target).toBe(0); // (50-50)/50*100 = 0
    expect(sales.roas_vs_target).toBe(50); // (3.0-2.0)/2.0*100 = 50
  });

  it('computes OUTCOME_TRAFFIC KPIs', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'OUTCOME_TRAFFIC', link_clicks: 500, landing_page_views: 300, spend: 500, impressions: 10000 }),
    ]);

    await prepare(tmpDir, configPath);
    const health = readOutput('account-health.json') as Record<string, unknown>;
    const traffic = health.OUTCOME_TRAFFIC as Record<string, unknown>;

    expect(traffic.link_clicks).toBe(500);
    expect(traffic.landing_page_views).toBe(300);
    expect(traffic.cpc).toBe(1.0); // 500/500
    expect(traffic.ctr).toBe(5.0); // 500/10000*100
  });

  it('computes OUTCOME_AWARENESS KPIs', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'OUTCOME_AWARENESS', impressions: 100000, reach: 80000, video_view: 5000, spend: 500 }),
    ]);

    await prepare(tmpDir, configPath);
    const health = readOutput('account-health.json') as Record<string, unknown>;
    const awareness = health.OUTCOME_AWARENESS as Record<string, unknown>;

    expect(awareness.cpm).toBe(5.0); // 500/100000*1000
    expect(awareness.avg_frequency).toBe(1.25); // 100000/80000
    expect(awareness.video_views).toBe(5000);
    expect(awareness.cpv).toBe(0.1); // 500/5000
  });

  it('falls back to highest-spend objective when primary not in data', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'OUTCOME_TRAFFIC', spend: 1000 }),
    ]);

    await prepare(tmpDir, configPath);
    const health = readOutput('account-health.json') as Record<string, unknown>;
    expect(health.primary_objective).toBe('OUTCOME_TRAFFIC');
  });

  it('handles multiple objectives', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', objective: 'OUTCOME_SALES', spend: 1000, purchases: 20, revenue: 3000 }),
      makeCampaign({ campaign_id: 'c2', objective: 'OUTCOME_TRAFFIC', spend: 500, link_clicks: 500, impressions: 10000 }),
    ]);

    await prepare(tmpDir, configPath);
    const health = readOutput('account-health.json') as Record<string, unknown>;
    expect(health.objectives_present).toEqual(['OUTCOME_SALES', 'OUTCOME_TRAFFIC']);
    expect(health.total_spend).toBe(1500);
    expect(health.OUTCOME_SALES).toBeDefined();
    expect(health.OUTCOME_TRAFFIC).toBeDefined();
  });

  it('returns null KPIs on zero conversions', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ purchases: 0, revenue: 0, spend: 100 }),
    ]);

    await prepare(tmpDir, configPath);
    const health = readOutput('account-health.json') as Record<string, unknown>;
    const sales = health.OUTCOME_SALES as Record<string, unknown>;
    expect(sales.cpa).toBeNull();
    expect(sales.cpa_vs_target).toBeNull();
  });

  it('computes OUTCOME_ENGAGEMENT KPIs', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'OUTCOME_ENGAGEMENT', post_engagement: 1000, page_engagement: 100, spend: 500, impressions: 50000 }),
    ]);

    await prepare(tmpDir, configPath);
    const health = readOutput('account-health.json') as Record<string, unknown>;
    const eng = health.OUTCOME_ENGAGEMENT as Record<string, unknown>;
    expect(eng.cpe).toBe(0.5); // 500/1000
    expect(eng.engagement_rate).toBe(2.0); // 1000/50000*100
  });

  it('computes OUTCOME_LEADS KPIs', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'OUTCOME_LEADS', lead: 25, spend: 500 }),
    ]);

    await prepare(tmpDir, configPath);
    const health = readOutput('account-health.json') as Record<string, unknown>;
    const leads = health.OUTCOME_LEADS as Record<string, unknown>;
    expect(leads.cpl).toBe(20.0); // 500/25
  });

  it('computes OUTCOME_APP_PROMOTION KPIs', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'OUTCOME_APP_PROMOTION', app_install: 100, spend: 300 }),
    ]);

    await prepare(tmpDir, configPath);
    const health = readOutput('account-health.json') as Record<string, unknown>;
    const app = health.OUTCOME_APP_PROMOTION as Record<string, unknown>;
    expect(app.cpi).toBe(3.0); // 300/100
  });
});

// ─── Budget actions ───────────────────────────────────────────────

describe('budget actions', () => {
  it('classifies SALES adset as scale when above targets', async () => {
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ roas: 3.0, cpa: 30, purchases: 10, spend: 300 }), // roas > 2.0*1.2=2.4, cpa < 50*0.8=40
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const sales = actions.OUTCOME_SALES as Record<string, unknown>;
    expect((sales.scale as unknown[]).length).toBe(1);
  });

  it('classifies SALES adset as reduce when below threshold', async () => {
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ roas: 1.0, cpa: 100, purchases: 5, spend: 500 }), // roas < 2.0*0.8=1.6
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const sales = actions.OUTCOME_SALES as Record<string, unknown>;
    expect((sales.reduce as unknown[]).length).toBe(1);
  });

  it('classifies as pause on zero conversions', async () => {
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ purchases: 0, roas: 0, spend: 500 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const sales = actions.OUTCOME_SALES as Record<string, unknown>;
    expect((sales.pause as unknown[]).length).toBe(1);
  });

  it('classifies as refresh when frequency exceeds ceiling', async () => {
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ frequency: 6.0, purchases: 10, roas: 3.0 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const sales = actions.OUTCOME_SALES as Record<string, unknown>;
    expect((sales.refresh as unknown[]).length).toBe(1);
  });

  it('classifies as maintain when no targets set', async () => {
    fs.writeFileSync(configPath, JSON.stringify(makeConfig({
      targets: { OUTCOME_SALES: {}, global: { max_frequency: 5.0, min_spend: 0 } },
    })));
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ purchases: 10, roas: 3.0 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const sales = actions.OUTCOME_SALES as Record<string, unknown>;
    const maintain = sales.maintain as Record<string, unknown>;
    expect(maintain.count).toBe(1);
    const topBySpend = maintain.top_by_spend as Record<string, unknown>[];
    expect(topBySpend[0].reason).toBe('no targets set');
  });

  it('includes ALL maintain adsets in top_by_spend (bug fix from shell [:5])', async () => {
    const adsets = Array.from({ length: 8 }, (_, i) =>
      makeAdset({ adset_id: `as${i}`, adset_name: `Adset ${i}`, purchases: 10, roas: 2.2, cpa: 45, spend: 500 - i * 10 }),
    );
    writeJson('_summaries/adsets-summary.json', adsets);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const sales = actions.OUTCOME_SALES as Record<string, unknown>;
    const maintain = sales.maintain as Record<string, unknown>;
    expect((maintain.top_by_spend as unknown[]).length).toBe(8);
  });

  it('applies M5 fallback when min_spend filters out all adsets', async () => {
    fs.writeFileSync(configPath, JSON.stringify(makeConfig({
      targets: { OUTCOME_SALES: { cpa: 50, roas: 2.0 }, global: { max_frequency: 5.0, min_spend: 1000 } },
    })));
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ spend: 100, purchases: 10, roas: 3.0, cpa: 10 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const sales = actions.OUTCOME_SALES as Record<string, unknown>;
    expect((sales.summary as Record<string, unknown>).total_evaluated).toBe(1);
  });

  it('rounds output KPIs with round2', async () => {
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ roas: 2.567, cpa: 33.333, frequency: 1.567 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const sales = actions.OUTCOME_SALES as Record<string, unknown>;
    const scaled = (sales.scale as Record<string, unknown>[])[0];
    expect(scaled.roas).toBe(2.57);
    expect(scaled.cpa).toBe(33.33);
    expect(scaled.frequency).toBe(1.57);
  });

  it('classifies TRAFFIC adset correctly', async () => {
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ objective: 'OUTCOME_TRAFFIC', link_clicks: 500, link_click_cpc: 0.5, link_click_ctr: 3.0 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const traffic = actions.OUTCOME_TRAFFIC as Record<string, unknown>;
    // CPC 0.5 < 1.0*0.8=0.8 AND CTR 3.0 > 2.0*1.2=2.4 → scale
    expect((traffic.scale as unknown[]).length).toBe(1);
  });

  it('includes summary counts per objective', async () => {
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ adset_id: 'as1', roas: 3.0, cpa: 30, purchases: 10, spend: 300 }),
      makeAdset({ adset_id: 'as2', roas: 1.0, cpa: 100, purchases: 5, spend: 500 }),
      makeAdset({ adset_id: 'as3', purchases: 0, roas: 0, spend: 200 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const sales = actions.OUTCOME_SALES as Record<string, unknown>;
    const summary = sales.summary as Record<string, unknown>;
    expect(summary.total_evaluated).toBe(3);
    expect(summary.scale).toBe(1);
    expect(summary.reduce).toBe(1);
    expect(summary.pause).toBe(1);
  });
});

// ─── Funnel ───────────────────────────────────────────────────────

describe('funnel', () => {
  it('computes SALES 7-stage funnel with bottleneck', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({
        impressions: 100000, link_clicks: 3000, landing_page_views: 2100,
        view_content: 400, add_to_cart: 168, initiate_checkout: 84, purchases: 50,
      }),
    ]);

    await prepare(tmpDir, configPath);
    const funnel = readOutput('funnel.json') as Record<string, unknown>;
    const sales = funnel.OUTCOME_SALES as Record<string, unknown>;

    expect(sales.type).toBe('funnel');
    expect(sales.stages).toEqual(['impressions', 'link_clicks', 'landing_page_views', 'view_content', 'add_to_cart', 'initiate_checkout', 'purchases']);
    expect(sales.impressions).toBe(100000);
    expect(sales.purchases).toBe(50);

    const rates = sales.rates as Record<string, number | null>;
    expect(rates.click_rate).toBe(3.0); // 3000/100000*100
    expect(rates.landing_rate).toBe(70.0); // 2100/3000*100

    expect(sales.bottleneck).toBeDefined();
  });

  it('computes TRAFFIC 3-stage funnel', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'OUTCOME_TRAFFIC', impressions: 50000, link_clicks: 1000, landing_page_views: 700 }),
    ]);

    await prepare(tmpDir, configPath);
    const funnel = readOutput('funnel.json') as Record<string, unknown>;
    const traffic = funnel.OUTCOME_TRAFFIC as Record<string, unknown>;

    expect(traffic.type).toBe('funnel');
    expect(traffic.stages).toEqual(['impressions', 'link_clicks', 'landing_page_views']);
    expect((traffic.rates as Record<string, number>).click_rate).toBe(2.0);
  });

  it('computes AWARENESS reach_efficiency (no funnel)', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'OUTCOME_AWARENESS', impressions: 100000, reach: 80000, video_view: 5000, spend: 500 }),
    ]);

    await prepare(tmpDir, configPath);
    const funnel = readOutput('funnel.json') as Record<string, unknown>;
    const awareness = funnel.OUTCOME_AWARENESS as Record<string, unknown>;

    expect(awareness.type).toBe('reach_efficiency');
    expect(awareness.cpm).toBe(5.0);
    expect(awareness.cost_per_view).toBe(0.1);
  });

  it('computes ENGAGEMENT funnel', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'OUTCOME_ENGAGEMENT', impressions: 100000, post_engagement: 2000, page_engagement: 300 }),
    ]);

    await prepare(tmpDir, configPath);
    const funnel = readOutput('funnel.json') as Record<string, unknown>;
    const eng = funnel.OUTCOME_ENGAGEMENT as Record<string, unknown>;

    expect(eng.type).toBe('funnel');
    expect((eng.rates as Record<string, number>).engagement_rate).toBe(2.0);
    expect((eng.rates as Record<string, number>).deep_engagement_rate).toBe(15.0);
  });

  it('computes LEADS 4-stage funnel', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'OUTCOME_LEADS', impressions: 50000, link_clicks: 1000, landing_page_views: 600, lead: 30 }),
    ]);

    await prepare(tmpDir, configPath);
    const funnel = readOutput('funnel.json') as Record<string, unknown>;
    const leads = funnel.OUTCOME_LEADS as Record<string, unknown>;

    expect(leads.type).toBe('funnel');
    expect(leads.stages).toEqual(['impressions', 'link_clicks', 'landing_page_views', 'leads']);
    expect((leads.rates as Record<string, number>).lead_conversion_rate).toBe(5.0);
  });

  it('computes APP_PROMOTION 3-stage funnel', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'OUTCOME_APP_PROMOTION', impressions: 50000, link_clicks: 750, app_install: 37 }),
    ]);

    await prepare(tmpDir, configPath);
    const funnel = readOutput('funnel.json') as Record<string, unknown>;
    const app = funnel.OUTCOME_APP_PROMOTION as Record<string, unknown>;

    expect(app.type).toBe('funnel');
    expect(app.stages).toEqual(['impressions', 'link_clicks', 'app_installs']);
    expect((app.rates as Record<string, number>).install_rate).toBe(4.93); // 37/750*100
  });

  it('returns null bottleneck when all rates are null', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'OUTCOME_TRAFFIC', impressions: 0, link_clicks: 0, landing_page_views: 0 }),
    ]);

    await prepare(tmpDir, configPath);
    const funnel = readOutput('funnel.json') as Record<string, unknown>;
    const traffic = funnel.OUTCOME_TRAFFIC as Record<string, unknown>;
    expect(traffic.bottleneck).toBeNull();
  });
});

// ─── Trends ───────────────────────────────────────────────────────

describe('trends', () => {
  it('returns available:false when no recent data', async () => {
    writeJson('_summaries/campaigns-summary.json', [makeCampaign()]);

    await prepare(tmpDir, configPath);
    const trends = readOutput('trends.json') as Record<string, unknown>;
    expect(trends.available).toBe(false);
    expect(trends.reason).toBe('no recent window data');
  });

  it('returns available:false when period equals recent', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ date_start: '2026-03-08', date_stop: '2026-03-14' }),
    ]);
    writeJson('_recent/campaigns-summary.json', [
      makeCampaign({ date_start: '2026-03-08', date_stop: '2026-03-14', spend: 500 }),
    ]);

    await prepare(tmpDir, configPath);
    const trends = readOutput('trends.json') as Record<string, unknown>;
    expect(trends.available).toBe(false);
  });

  it('computes prior/recent deltas with flags for SALES', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', spend: 1000, purchases: 20, revenue: 3000, roas: 3.0, cpa: 50, date_start: '2026-03-01' }),
    ]);
    writeJson('_recent/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', spend: 400, purchases: 5, revenue: 600, roas: 1.5, cpa: 80, date_start: '2026-03-08' }),
    ]);

    await prepare(tmpDir, configPath);
    const trends = readOutput('trends.json') as Record<string, unknown>;
    expect(trends.available).toBe(true);

    const campaigns = (trends as Record<string, unknown>).campaigns as Record<string, unknown>[];
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].campaign_id).toBe('c1');
    expect(campaigns[0].prior_spend).toBe(600); // 1000-400
    expect(campaigns[0].recent_spend).toBe(400);
    // Prior: spend=600, purchases=15 → cpa=40. Recent cpa=80 → delta = (80-40)/40*100 = 100%
    expect(campaigns[0].cpa_delta_pct).toBe(100);
    expect(campaigns[0].flags).toContain('cpa_rising');
  });

  it('detects roas_declining flag', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', spend: 1000, purchases: 20, revenue: 2000, roas: 2.0, date_start: '2026-03-01' }),
    ]);
    writeJson('_recent/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', spend: 500, purchases: 5, revenue: 500, roas: 1.0, date_start: '2026-03-08' }),
    ]);

    await prepare(tmpDir, configPath);
    const trends = readOutput('trends.json') as Record<string, unknown>;
    const campaigns = (trends as Record<string, unknown>).campaigns as Record<string, unknown>[];
    // Prior: spend=500, revenue=1500 → roas=3.0. Recent roas=1.0 → delta=(1.0-3.0)/3.0*100=-67
    expect(campaigns[0].flags).toContain('roas_declining');
  });

  it('identifies recently_inactive campaigns', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', campaign_name: 'Active', spend: 1000, date_start: '2026-03-01' }),
      makeCampaign({ campaign_id: 'c2', campaign_name: 'Inactive', spend: 200, date_start: '2026-03-01' }),
    ]);
    writeJson('_recent/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', spend: 400, date_start: '2026-03-08' }),
      // c2 not in recent → recently_inactive
    ]);

    await prepare(tmpDir, configPath);
    const trends = readOutput('trends.json') as Record<string, unknown>;
    const inactive = (trends as Record<string, unknown>).recently_inactive as Record<string, unknown>[];
    expect(inactive).toHaveLength(1);
    expect(inactive[0].campaign_name).toBe('Inactive');
    expect(inactive[0].period_spend).toBe(200);
  });

  it('populates flagged array', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', spend: 1000, purchases: 20, revenue: 2000, roas: 2.0, date_start: '2026-03-01' }),
    ]);
    writeJson('_recent/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', spend: 500, purchases: 5, revenue: 500, roas: 1.0, date_start: '2026-03-08' }),
    ]);

    await prepare(tmpDir, configPath);
    const trends = readOutput('trends.json') as Record<string, unknown>;
    const flagged = (trends as Record<string, unknown>).flagged as Record<string, unknown>[];
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged[0].flags).toBeDefined();
  });

  it('computes TRAFFIC trends with cpc/ctr deltas', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', objective: 'OUTCOME_TRAFFIC', spend: 1000, link_clicks: 500, link_click_cpc: 2.0, link_click_ctr: 5.0, impressions: 10000, date_start: '2026-03-01' }),
    ]);
    writeJson('_recent/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', objective: 'OUTCOME_TRAFFIC', spend: 500, link_clicks: 200, link_click_cpc: 2.5, link_click_ctr: 4.0, impressions: 5000, date_start: '2026-03-08' }),
    ]);

    await prepare(tmpDir, configPath);
    const trends = readOutput('trends.json') as Record<string, unknown>;
    const campaigns = (trends as Record<string, unknown>).campaigns as Record<string, unknown>[];
    expect(campaigns[0].prior_cpc).toBeDefined();
    expect(campaigns[0].recent_cpc).toBeDefined();
    expect(campaigns[0].cpc_delta_pct).toBeDefined();
  });
});

// ─── Creative ranking ─────────────────────────────────────────────

describe('creative ranking', () => {
  it('ranks SALES ads by roas (desc)', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', ad_name: 'High ROAS', roas: 5.0, purchases: 10, spend: 200 }),
      makeAd({ ad_id: 'a2', ad_name: 'Low ROAS', roas: 1.0, purchases: 5, spend: 500 }),
      makeAd({ ad_id: 'a3', ad_name: 'Mid ROAS', roas: 2.5, purchases: 8, spend: 300 }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const sales = analysis.OUTCOME_SALES as Record<string, unknown>;
    const winners = sales.winners as Record<string, unknown>[];
    expect(winners[0].ad_name).toBe('High ROAS');
  });

  it('ranks TRAFFIC ads by link_click_ctr (desc)', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', objective: 'OUTCOME_TRAFFIC', link_clicks: 100, link_click_ctr: 5.0, spend: 100 }),
      makeAd({ ad_id: 'a2', objective: 'OUTCOME_TRAFFIC', link_clicks: 50, link_click_ctr: 2.0, spend: 200 }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const traffic = analysis.OUTCOME_TRAFFIC as Record<string, unknown>;
    const winners = traffic.winners as Record<string, unknown>[];
    expect(winners[0].ad_name).toBe('Ad 1');
  });

  it('ranks AWARENESS ads by cpm (asc — lower is better)', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', objective: 'OUTCOME_AWARENESS', video_view: 100, cpm: 5.0, spend: 100, impressions: 20000 }),
      makeAd({ ad_id: 'a2', objective: 'OUTCOME_AWARENESS', video_view: 50, cpm: 15.0, spend: 300, impressions: 20000 }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const awareness = analysis.OUTCOME_AWARENESS as Record<string, unknown>;
    const winners = awareness.winners as Record<string, unknown>[];
    expect(winners[0].ad_name).toBe('Ad 1'); // lower cpm wins
  });

  it('adaptive sizing: 1 ad → 1 winner, 0 losers', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', purchases: 5, roas: 3.0 }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const sales = analysis.OUTCOME_SALES as Record<string, unknown>;
    expect((sales.winners as unknown[]).length).toBe(1);
    expect((sales.losers as unknown[]).length).toBe(0);
  });

  it('adaptive sizing: 3 ads → 1 winner, 2 losers', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', purchases: 10, roas: 5.0 }),
      makeAd({ ad_id: 'a2', purchases: 5, roas: 2.0 }),
      makeAd({ ad_id: 'a3', purchases: 3, roas: 1.0 }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const sales = analysis.OUTCOME_SALES as Record<string, unknown>;
    expect((sales.winners as unknown[]).length).toBe(1);
    expect((sales.losers as unknown[]).length).toBe(2);
  });

  it('adaptive sizing: 10 ads → 5 winners, 5 losers', async () => {
    const ads = Array.from({ length: 10 }, (_, i) =>
      makeAd({ ad_id: `a${i}`, ad_name: `Ad ${i}`, purchases: 10 - i, roas: 10 - i, spend: 100 }),
    );
    writeJson('_summaries/ads-summary.json', ads);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const sales = analysis.OUTCOME_SALES as Record<string, unknown>;
    expect((sales.winners as unknown[]).length).toBe(5);
    expect((sales.losers as unknown[]).length).toBe(5);
  });

  it('separates zero-conversion ads', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', purchases: 5, roas: 3.0, spend: 200 }),
      makeAd({ ad_id: 'a2', purchases: 0, roas: 0, spend: 300 }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const sales = analysis.OUTCOME_SALES as Record<string, unknown>;
    const overview = sales.overview as Record<string, unknown>;
    expect(overview.with_conversions).toBe(1);
    expect(overview.zero_conversion_count).toBe(1);
    expect(overview.zero_conversion_total_spend).toBe(300);
    expect((sales.zero_conversion as unknown[]).length).toBe(1);
  });

  it('populates creative fields in output', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', purchases: 5, roas: 3.0, creative_body: 'Shop today!', creative_title: 'Big Sale' }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const sales = analysis.OUTCOME_SALES as Record<string, unknown>;
    const winner = (sales.winners as Record<string, unknown>[])[0];
    expect(winner.creative_body).toBe('Shop today!');
    expect(winner.creative_title).toBe('Big Sale');
  });

  it('rounds KPIs in formatted ads', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', purchases: 5, roas: 2.567, cpa: 33.333, cpc: 0.666, ctr: 3.456, spend: 100, impressions: 5000 }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const sales = analysis.OUTCOME_SALES as Record<string, unknown>;
    const winner = (sales.winners as Record<string, unknown>[])[0];
    expect(winner.roas).toBe(2.57);
    expect(winner.cpa).toBe(33.33);
    expect(winner.cpc).toBe(0.67);
    expect(winner.ctr).toBe(3.46);
  });

  it('produces creative-media.json with URLs from _raw/creatives.json', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', purchases: 5, roas: 3.0 }),
    ]);
    writeJson('_raw/creatives.json', { data: [
      { id: 'a1', creative_image_url: 'https://img.example.com/1.jpg', creative_thumbnail_url: 'https://img.example.com/1_thumb.jpg' },
    ]});

    await prepare(tmpDir, configPath);
    const media = readOutput('creative-media.json') as Record<string, unknown>[];
    expect(media.length).toBeGreaterThan(0);
    expect(media[0].ad_id).toBe('a1');
    expect(media[0].rank).toBe('winner');
    expect(media[0].creative_image_url).toBe('https://img.example.com/1.jpg');
    expect(media[0].creative_thumbnail_url).toBe('https://img.example.com/1_thumb.jpg');
  });

  it('uses empty URLs when _raw/creatives.json missing', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', purchases: 5, roas: 3.0 }),
    ]);

    await prepare(tmpDir, configPath);
    const media = readOutput('creative-media.json') as Record<string, unknown>[];
    expect(media[0].creative_image_url).toBe('');
    expect(media[0].creative_thumbnail_url).toBe('');
  });

  it('includes diagnostic ranking fields in winners', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', purchases: 5, roas: 3.0, quality_ranking: 'ABOVE_AVERAGE_20', engagement_rate_ranking: 'AVERAGE', conversion_rate_ranking: 'BELOW_AVERAGE_35' }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const sales = analysis.OUTCOME_SALES as Record<string, unknown>;
    const winner = (sales.winners as Record<string, unknown>[])[0];
    expect(winner.quality_ranking).toBe('ABOVE_AVERAGE_20');
    expect(winner.engagement_rate_ranking).toBe('AVERAGE');
    expect(winner.conversion_rate_ranking).toBe('BELOW_AVERAGE_35');
  });

  it('defaults diagnostic ranking fields to "" in winners when absent', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', purchases: 5, roas: 3.0 }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const sales = analysis.OUTCOME_SALES as Record<string, unknown>;
    const winner = (sales.winners as Record<string, unknown>[])[0];
    expect(winner.quality_ranking).toBe('');
    expect(winner.engagement_rate_ranking).toBe('');
    expect(winner.conversion_rate_ranking).toBe('');
  });

  it('includes diagnostic ranking fields in zero_conversion ads', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', purchases: 5, roas: 3.0 }),
      makeAd({ ad_id: 'a2', ad_name: 'Zero Ad', purchases: 0, roas: 0, spend: 200, quality_ranking: 'BELOW_AVERAGE_10', engagement_rate_ranking: 'BELOW_AVERAGE_35', conversion_rate_ranking: '' }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const sales = analysis.OUTCOME_SALES as Record<string, unknown>;
    const zeroAd = (sales.zero_conversion as Record<string, unknown>[])[0];
    expect(zeroAd.quality_ranking).toBe('BELOW_AVERAGE_10');
    expect(zeroAd.engagement_rate_ranking).toBe('BELOW_AVERAGE_35');
    expect(zeroAd.conversion_rate_ranking).toBe('');
  });
});

// ─── Edge cases ───────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles empty summary files', async () => {
    writeJson('_summaries/campaigns-summary.json', []);
    writeJson('_summaries/adsets-summary.json', []);
    writeJson('_summaries/ads-summary.json', []);

    const status = await prepare(tmpDir, configPath);
    expect(status.status).toBe('complete');
    // Health should still be produced (empty objectives)
    const health = readOutput('account-health.json') as Record<string, unknown>;
    expect(health.total_spend).toBe(0);
    expect(health.objectives_present).toEqual([]);
  });

  it('handles single campaign', async () => {
    writeJson('_summaries/campaigns-summary.json', [makeCampaign()]);

    await prepare(tmpDir, configPath);
    const health = readOutput('account-health.json') as Record<string, unknown>;
    expect(health.primary_objective).toBe('OUTCOME_SALES');
  });

  it('writes empty array for creative-media when no ads', async () => {
    writeJson('_summaries/campaigns-summary.json', [makeCampaign()]);

    await prepare(tmpDir, configPath);
    const media = readOutput('creative-media.json') as unknown[];
    expect(media).toEqual([]);
  });

  it('handles unknown objective with empty KPIs', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'SOME_NEW_OBJECTIVE' }),
    ]);

    await prepare(tmpDir, configPath);
    const health = readOutput('account-health.json') as Record<string, unknown>;
    const unknown = health.SOME_NEW_OBJECTIVE as Record<string, unknown>;
    expect(unknown.campaign_count).toBe(1);
    // No extra KPI fields added for unknown objectives
  });

  it('pipeline-status.json is written to disk', async () => {
    writeJson('_summaries/campaigns-summary.json', [makeCampaign()]);
    writeJson('_summaries/adsets-summary.json', [makeAdset()]);
    writeJson('_summaries/ads-summary.json', [makeAd()]);

    await prepare(tmpDir, configPath);
    const status = readOutput('pipeline-status.json') as Record<string, unknown>;
    expect(status.status).toBe('complete');
    expect(status.files_produced).toBeDefined();
  });

  it('uses zero_purchase_n fallback when zero_conversion_n absent', async () => {
    fs.writeFileSync(configPath, JSON.stringify(makeConfig({
      analysis: { top_n: 15, bottom_n: 10, zero_purchase_n: 3 },
    })));
    const ads = [
      makeAd({ ad_id: 'a1', purchases: 5, roas: 3.0, spend: 200 }),
      ...Array.from({ length: 5 }, (_, i) =>
        makeAd({ ad_id: `z${i}`, ad_name: `Zero ${i}`, purchases: 0, roas: 0, spend: 100 }),
      ),
    ];
    writeJson('_summaries/ads-summary.json', ads);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const sales = analysis.OUTCOME_SALES as Record<string, unknown>;
    // zero_purchase_n=3, so only 3 zero-conversion ads shown
    expect((sales.zero_conversion as unknown[]).length).toBe(3);
  });

  it('funnel returns unknown type for unrecognized objective', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ objective: 'SOME_NEW_OBJECTIVE' }),
    ]);

    await prepare(tmpDir, configPath);
    const funnel = readOutput('funnel.json') as Record<string, unknown>;
    const unknown = funnel.SOME_NEW_OBJECTIVE as Record<string, unknown>;
    expect(unknown.type).toBe('unknown');
  });
});

// ─── Budget actions: remaining objectives ─────────────────────────

describe('budget actions — remaining objectives', () => {
  it('classifies AWARENESS adset: pause on zero impressions', async () => {
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ objective: 'OUTCOME_AWARENESS', impressions: 0, spend: 100 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const awareness = actions.OUTCOME_AWARENESS as Record<string, unknown>;
    expect((awareness.pause as unknown[]).length).toBe(1);
  });

  it('classifies AWARENESS adset: scale when CPM below target', async () => {
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ objective: 'OUTCOME_AWARENESS', impressions: 100000, cpm: 5.0, spend: 500, video_view: 1000 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const awareness = actions.OUTCOME_AWARENESS as Record<string, unknown>;
    // cpm=5.0 < 10*0.8=8 → scale
    expect((awareness.scale as unknown[]).length).toBe(1);
  });

  it('classifies ENGAGEMENT adset: pause on zero engagement', async () => {
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ objective: 'OUTCOME_ENGAGEMENT', post_engagement: 0, spend: 100 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const eng = actions.OUTCOME_ENGAGEMENT as Record<string, unknown>;
    expect((eng.pause as unknown[]).length).toBe(1);
  });

  it('classifies ENGAGEMENT adset: scale when CPE below target', async () => {
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ objective: 'OUTCOME_ENGAGEMENT', post_engagement: 500, cpe: 0.3, spend: 150 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const eng = actions.OUTCOME_ENGAGEMENT as Record<string, unknown>;
    // cpe=0.3 < 0.5*0.8=0.4 → scale
    expect((eng.scale as unknown[]).length).toBe(1);
  });

  it('classifies LEADS adset: pause on zero leads, scale when CPL below target', async () => {
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ adset_id: 'as1', objective: 'OUTCOME_LEADS', lead: 0, spend: 100 }),
      makeAdset({ adset_id: 'as2', objective: 'OUTCOME_LEADS', lead: 10, cpl: 10, spend: 100 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const leads = actions.OUTCOME_LEADS as Record<string, unknown>;
    expect((leads.pause as unknown[]).length).toBe(1);
    // cpl=10 < 20*0.8=16 → scale
    expect((leads.scale as unknown[]).length).toBe(1);
  });

  it('classifies APP_PROMOTION adset: pause on zero installs, scale when CPI below target', async () => {
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ adset_id: 'as1', objective: 'OUTCOME_APP_PROMOTION', app_install: 0, spend: 100 }),
      makeAdset({ adset_id: 'as2', objective: 'OUTCOME_APP_PROMOTION', app_install: 50, cpi: 1.5, spend: 75 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const app = actions.OUTCOME_APP_PROMOTION as Record<string, unknown>;
    expect((app.pause as unknown[]).length).toBe(1);
    // cpi=1.5 < 3*0.8=2.4 → scale
    expect((app.scale as unknown[]).length).toBe(1);
  });

  it('uses awareness-specific max_frequency override', async () => {
    fs.writeFileSync(configPath, JSON.stringify(makeConfig({
      targets: {
        OUTCOME_AWARENESS: { cpm: 10, max_frequency: 3.0 },
        global: { max_frequency: 5.0, min_spend: 0 },
      },
    })));
    writeJson('_summaries/adsets-summary.json', [
      makeAdset({ objective: 'OUTCOME_AWARENESS', frequency: 4.0, impressions: 50000, cpm: 8.0 }),
    ]);

    await prepare(tmpDir, configPath);
    const actions = readOutput('budget-actions.json') as Record<string, unknown>;
    const awareness = actions.OUTCOME_AWARENESS as Record<string, unknown>;
    // frequency 4.0 > awareness max_frequency 3.0 → refresh
    expect((awareness.refresh as unknown[]).length).toBe(1);
  });
});

// ─── Trends: remaining objectives ─────────────────────────────────

describe('trends — remaining objectives', () => {
  it('computes AWARENESS trends with cpm_rising flag', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', objective: 'OUTCOME_AWARENESS', spend: 1000, impressions: 100000, video_view: 5000, cpm: 10, date_start: '2026-03-01' }),
    ]);
    writeJson('_recent/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', objective: 'OUTCOME_AWARENESS', spend: 600, impressions: 40000, video_view: 2000, cpm: 15, date_start: '2026-03-08' }),
    ]);

    await prepare(tmpDir, configPath);
    const trends = readOutput('trends.json') as Record<string, unknown>;
    const campaigns = (trends as Record<string, unknown>).campaigns as Record<string, unknown>[];
    expect(campaigns[0].prior_cpm).toBeDefined();
    expect(campaigns[0].recent_cpm).toBeDefined();
    expect(campaigns[0].cpm_delta_pct).toBeDefined();
    // Prior: spend=400, imp=60000 → cpm=6.67. Recent cpm=15. delta=(15-6.67)/6.67*100≈125 → cpm_rising
    expect(campaigns[0].flags).toContain('cpm_rising');
  });

  it('computes ENGAGEMENT trends with cpe_rising flag', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', objective: 'OUTCOME_ENGAGEMENT', spend: 1000, post_engagement: 2000, cpe: 0.5, date_start: '2026-03-01' }),
    ]);
    writeJson('_recent/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', objective: 'OUTCOME_ENGAGEMENT', spend: 600, post_engagement: 500, cpe: 1.2, date_start: '2026-03-08' }),
    ]);

    await prepare(tmpDir, configPath);
    const trends = readOutput('trends.json') as Record<string, unknown>;
    const campaigns = (trends as Record<string, unknown>).campaigns as Record<string, unknown>[];
    expect(campaigns[0].prior_cpe).toBeDefined();
    expect(campaigns[0].recent_cpe).toBeDefined();
    // Prior: spend=400, post_engagement=1500 → cpe=0.267. Recent cpe=1.2 → delta huge → cpe_rising
    expect(campaigns[0].flags).toContain('cpe_rising');
  });

  it('computes LEADS trends with cpl_rising flag', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', objective: 'OUTCOME_LEADS', spend: 1000, lead: 50, cpl: 20, date_start: '2026-03-01' }),
    ]);
    writeJson('_recent/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', objective: 'OUTCOME_LEADS', spend: 600, lead: 10, cpl: 60, date_start: '2026-03-08' }),
    ]);

    await prepare(tmpDir, configPath);
    const trends = readOutput('trends.json') as Record<string, unknown>;
    const campaigns = (trends as Record<string, unknown>).campaigns as Record<string, unknown>[];
    expect(campaigns[0].prior_cpl).toBeDefined();
    expect(campaigns[0].recent_cpl).toBeDefined();
    // Prior: spend=400, lead=40 → cpl=10. Recent cpl=60 → delta=500% → cpl_rising
    expect(campaigns[0].flags).toContain('cpl_rising');
  });

  it('computes APP_PROMOTION trends with cpi_rising flag', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', objective: 'OUTCOME_APP_PROMOTION', spend: 1000, app_install: 200, cpi: 5, date_start: '2026-03-01' }),
    ]);
    writeJson('_recent/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', objective: 'OUTCOME_APP_PROMOTION', spend: 600, app_install: 30, cpi: 20, date_start: '2026-03-08' }),
    ]);

    await prepare(tmpDir, configPath);
    const trends = readOutput('trends.json') as Record<string, unknown>;
    const campaigns = (trends as Record<string, unknown>).campaigns as Record<string, unknown>[];
    expect(campaigns[0].prior_cpi).toBeDefined();
    expect(campaigns[0].recent_cpi).toBeDefined();
    // Prior: spend=400, app_install=170 → cpi=2.35. Recent cpi=20 → cpi_rising
    expect(campaigns[0].flags).toContain('cpi_rising');
  });

  it('no flags when deltas are within 15% threshold', async () => {
    writeJson('_summaries/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', spend: 1000, purchases: 20, revenue: 2000, roas: 2.0, cpa: 50, date_start: '2026-03-01' }),
    ]);
    writeJson('_recent/campaigns-summary.json', [
      makeCampaign({ campaign_id: 'c1', spend: 500, purchases: 10, revenue: 1000, roas: 2.0, cpa: 50, date_start: '2026-03-08' }),
    ]);

    await prepare(tmpDir, configPath);
    const trends = readOutput('trends.json') as Record<string, unknown>;
    const campaigns = (trends as Record<string, unknown>).campaigns as Record<string, unknown>[];
    expect(campaigns[0].flags).toEqual([]);
  });
});

// ─── Creative ranking: remaining objectives ───────────────────────

describe('creative ranking — remaining objectives', () => {
  it('ranks ENGAGEMENT ads by cpe (asc — lower is better)', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', objective: 'OUTCOME_ENGAGEMENT', post_engagement: 500, cpe: 0.2, spend: 100 }),
      makeAd({ ad_id: 'a2', objective: 'OUTCOME_ENGAGEMENT', post_engagement: 100, cpe: 1.0, spend: 100 }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const eng = analysis.OUTCOME_ENGAGEMENT as Record<string, unknown>;
    const winners = eng.winners as Record<string, unknown>[];
    expect(winners[0].ad_name).toBe('Ad 1'); // lower cpe wins
  });

  it('ranks LEADS ads by cpl (asc — lower is better)', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', objective: 'OUTCOME_LEADS', lead: 20, cpl: 5, spend: 100 }),
      makeAd({ ad_id: 'a2', objective: 'OUTCOME_LEADS', lead: 5, cpl: 20, spend: 100 }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const leads = analysis.OUTCOME_LEADS as Record<string, unknown>;
    const winners = leads.winners as Record<string, unknown>[];
    expect(winners[0].ad_name).toBe('Ad 1'); // lower cpl wins
  });

  it('ranks APP_PROMOTION ads by cpi (asc — lower is better)', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', objective: 'OUTCOME_APP_PROMOTION', app_install: 50, cpi: 2, spend: 100 }),
      makeAd({ ad_id: 'a2', objective: 'OUTCOME_APP_PROMOTION', app_install: 10, cpi: 10, spend: 100 }),
    ]);

    await prepare(tmpDir, configPath);
    const analysis = readOutput('creative-analysis.json') as Record<string, unknown>;
    const app = analysis.OUTCOME_APP_PROMOTION as Record<string, unknown>;
    const winners = app.winners as Record<string, unknown>[];
    expect(winners[0].ad_name).toBe('Ad 1'); // lower cpi wins
  });

  it('creative-media includes correct primary_metric_value', async () => {
    writeJson('_summaries/ads-summary.json', [
      makeAd({ ad_id: 'a1', purchases: 5, roas: 3.567, spend: 200 }),
    ]);

    await prepare(tmpDir, configPath);
    const media = readOutput('creative-media.json') as Record<string, unknown>[];
    expect(media[0].primary_metric_name).toBe('roas');
    expect(media[0].primary_metric_value).toBe(3.57); // round2(3.567)
  });
});
