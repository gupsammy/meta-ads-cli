import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { summarize } from '../../intel/summarize.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Minimal insights row with enough data to exercise the metrics pipeline */
function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spend: '100',
    impressions: '5000',
    clicks: '150',
    cpc: '0.67',
    ctr: '3.0',
    cpm: '20.10',
    frequency: '1.5',
    reach: '3333',
    actions: [{ action_type: 'omni_purchase', value: '5' }],
    action_values: [{ action_type: 'omni_purchase', value: '250' }],
    purchase_roas: [{ action_type: 'omni_purchase', value: '2.5' }],
    date_start: '2026-03-01',
    date_stop: '2026-03-14',
    ...overrides,
  };
}

function writeJson(filename: string, data: unknown): void {
  fs.writeFileSync(path.join(tmpDir, filename), JSON.stringify(data));
}

function readOutput(filename: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, filename), 'utf-8'));
}

describe('campaigns', () => {
  it('summarizes campaigns with objective lookup — CONVERSIONS normalizes to OUTCOME_SALES', async () => {
    writeJson('campaigns-meta.json', {
      data: [{ id: '123', objective: 'CONVERSIONS' }],
    });
    writeJson('campaigns.json', {
      data: [makeRow({ campaign_id: '123', campaign_name: 'Test Campaign' })],
    });

    await summarize(tmpDir);
    const result = readOutput('campaigns-summary.json') as Record<string, unknown>[];

    expect(result).toHaveLength(1);
    expect(result[0].campaign_id).toBe('123');
    expect(result[0].campaign_name).toBe('Test Campaign');
    expect(result[0].objective).toBe('OUTCOME_SALES');
    expect(result[0].spend).toBe(100);
    expect(result[0].purchases).toBe(5);
    expect(result[0].cpa).toBe(20); // 100 / 5
  });

  it('skips when campaigns.json missing — no output file created', async () => {
    await summarize(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'campaigns-summary.json'))).toBe(false);
  });

  it('uses UNKNOWN when campaigns-meta.json missing', async () => {
    writeJson('campaigns.json', {
      data: [makeRow({ campaign_id: '999', campaign_name: 'No Meta' })],
    });

    await summarize(tmpDir);
    const result = readOutput('campaigns-summary.json') as Record<string, unknown>[];
    expect(result[0].objective).toBe('UNKNOWN');
  });

  it('uses UNKNOWN for campaign_id not in lookup', async () => {
    writeJson('campaigns-meta.json', { data: [{ id: '111', objective: 'REACH' }] });
    writeJson('campaigns.json', {
      data: [makeRow({ campaign_id: '999', campaign_name: 'Not In Lookup' })],
    });

    await summarize(tmpDir);
    const result = readOutput('campaigns-summary.json') as Record<string, unknown>[];
    expect(result[0].objective).toBe('UNKNOWN');
  });

  it('produces correct values for all 32 fields', async () => {
    writeJson('campaigns-meta.json', { data: [{ id: '1', objective: 'CONVERSIONS' }] });
    writeJson('campaigns.json', { data: [makeRow({ campaign_id: '1', campaign_name: 'Full Test' })] });

    await summarize(tmpDir);
    const result = readOutput('campaigns-summary.json') as Record<string, unknown>[];

    expect(result[0]).toEqual({
      // ExtractedMetrics (21 fields)
      spend: 100,
      impressions: 5000,
      clicks: 150,
      cpc: 0.67,
      ctr: 3.0,
      cpm: 20.1,
      frequency: 1.5,
      reach: 3333,
      purchases: 5,
      revenue: 250,
      roas: 2.5,
      add_to_cart: 0,
      initiate_checkout: 0,
      view_content: 0,
      link_clicks: 0,
      landing_page_views: 0,
      post_engagement: 0,
      page_engagement: 0,
      lead: 0,
      app_install: 0,
      video_view: 0,
      // DerivedMetrics (6 fields)
      cpa: 20,         // 100 / 5
      cpe: null,        // post_engagement = 0
      cpl: null,        // lead = 0
      cpi: null,        // app_install = 0
      link_click_ctr: 0, // link_clicks = 0
      link_click_cpc: null, // link_clicks = 0
      // Entity fields (5 fields)
      campaign_id: '1',
      campaign_name: 'Full Test',
      objective: 'OUTCOME_SALES',
      date_start: '2026-03-01',
      date_stop: '2026-03-14',
    });
  });

  it('handles bare array format (no .data wrapper)', async () => {
    writeJson('campaigns-meta.json', [{ id: '50', objective: 'LINK_CLICKS' }]);
    writeJson('campaigns.json', [makeRow({ campaign_id: '50', campaign_name: 'Bare' })]);

    await summarize(tmpDir);
    const result = readOutput('campaigns-summary.json') as Record<string, unknown>[];

    expect(result).toHaveLength(1);
    expect(result[0].objective).toBe('OUTCOME_TRAFFIC');
  });
});

describe('adsets', () => {
  it('summarizes adsets with objective from campaign lookup', async () => {
    writeJson('campaigns-meta.json', {
      data: [{ id: 'c1', objective: 'LEAD_GENERATION' }],
    });
    writeJson('adsets.json', {
      data: [
        makeRow({
          adset_id: 'as1',
          adset_name: 'Adset 1',
          campaign_id: 'c1',
          campaign_name: 'Lead Campaign',
        }),
      ],
    });

    await summarize(tmpDir);
    const result = readOutput('adsets-summary.json') as Record<string, unknown>[];

    expect(result).toHaveLength(1);
    expect(result[0].adset_id).toBe('as1');
    expect(result[0].adset_name).toBe('Adset 1');
    expect(result[0].campaign_id).toBe('c1');
    expect(result[0].objective).toBe('OUTCOME_LEADS');
  });

  it('skips when adsets.json missing', async () => {
    await summarize(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'adsets-summary.json'))).toBe(false);
  });
});

describe('ads', () => {
  it('summarizes ads with creative lookup — body and title populated', async () => {
    writeJson('creatives.json', {
      data: [{ id: 'a1', creative_body: 'Buy now!', creative_title: 'Sale' }],
    });
    writeJson('ads.json', {
      data: [
        makeRow({
          ad_id: 'a1',
          ad_name: 'Ad 1',
          adset_id: 'as1',
          campaign_id: 'c1',
          campaign_name: 'Campaign 1',
        }),
      ],
    });

    await summarize(tmpDir);
    const result = readOutput('ads-summary.json') as Record<string, unknown>[];

    expect(result).toHaveLength(1);
    expect(result[0].ad_id).toBe('a1');
    expect(result[0].creative_body).toBe('Buy now!');
    expect(result[0].creative_title).toBe('Sale');
  });

  it('defaults creative fields to "" when creatives.json missing', async () => {
    writeJson('ads.json', {
      data: [makeRow({ ad_id: 'a1', ad_name: 'Ad 1', adset_id: 'as1', campaign_id: 'c1', campaign_name: 'C1' })],
    });

    await summarize(tmpDir);
    const result = readOutput('ads-summary.json') as Record<string, unknown>[];
    expect(result[0].creative_body).toBe('');
    expect(result[0].creative_title).toBe('');
  });

  it('defaults creative fields when ad_id not in lookup', async () => {
    writeJson('creatives.json', {
      data: [{ id: 'a99', creative_body: 'Other', creative_title: 'Other Title' }],
    });
    writeJson('ads.json', {
      data: [makeRow({ ad_id: 'a1', ad_name: 'Ad 1', adset_id: 'as1', campaign_id: 'c1', campaign_name: 'C1' })],
    });

    await summarize(tmpDir);
    const result = readOutput('ads-summary.json') as Record<string, unknown>[];
    expect(result[0].creative_body).toBe('');
    expect(result[0].creative_title).toBe('');
  });

  it('defaults creative fields when ad_id is empty/null', async () => {
    writeJson('creatives.json', { data: [{ id: 'a1', creative_body: 'X', creative_title: 'Y' }] });
    writeJson('ads.json', {
      data: [makeRow({ ad_id: null, ad_name: 'No ID', adset_id: 'as1', campaign_id: 'c1', campaign_name: 'C1' })],
    });

    await summarize(tmpDir);
    const result = readOutput('ads-summary.json') as Record<string, unknown>[];
    expect(result[0].ad_id).toBeNull();
    expect(result[0].creative_body).toBe('');
    expect(result[0].creative_title).toBe('');
  });

  it('skips when ads.json missing', async () => {
    await summarize(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'ads-summary.json'))).toBe(false);
  });
});

describe('edge cases', () => {
  it('handles empty data arrays — writes []', async () => {
    writeJson('campaigns.json', { data: [] });
    writeJson('adsets.json', { data: [] });
    writeJson('ads.json', { data: [] });

    await summarize(tmpDir);

    expect(readOutput('campaigns-summary.json')).toEqual([]);
    expect(readOutput('adsets-summary.json')).toEqual([]);
    expect(readOutput('ads-summary.json')).toEqual([]);
  });

  it('handles all three files present — all three summaries created', async () => {
    writeJson('campaigns-meta.json', { data: [{ id: 'c1', objective: 'CONVERSIONS' }] });
    writeJson('campaigns.json', { data: [makeRow({ campaign_id: 'c1', campaign_name: 'C1' })] });
    writeJson('adsets.json', {
      data: [makeRow({ adset_id: 'as1', adset_name: 'AS1', campaign_id: 'c1', campaign_name: 'C1' })],
    });
    writeJson('creatives.json', { data: [{ id: 'a1', creative_body: 'B', creative_title: 'T' }] });
    writeJson('ads.json', {
      data: [makeRow({ ad_id: 'a1', ad_name: 'A1', adset_id: 'as1', campaign_id: 'c1', campaign_name: 'C1' })],
    });

    await summarize(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, 'campaigns-summary.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'adsets-summary.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'ads-summary.json'))).toBe(true);
  });

  it('skips malformed JSON files without crashing', async () => {
    fs.writeFileSync(path.join(tmpDir, 'campaigns.json'), '{not valid json');
    fs.writeFileSync(path.join(tmpDir, 'adsets.json'), '{{broken');
    fs.writeFileSync(path.join(tmpDir, 'ads.json'), '');

    await summarize(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, 'campaigns-summary.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'adsets-summary.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'ads-summary.json'))).toBe(false);
  });

  it('handles empty directory — no files created, no error', async () => {
    await summarize(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, 'campaigns-summary.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'adsets-summary.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'ads-summary.json'))).toBe(false);
  });

  it('stringifies numeric campaign_id for lookup', async () => {
    writeJson('campaigns-meta.json', { data: [{ id: 12345, objective: 'APP_INSTALLS' }] });
    writeJson('campaigns.json', {
      data: [makeRow({ campaign_id: 12345, campaign_name: 'Numeric ID' })],
    });

    await summarize(tmpDir);
    const result = readOutput('campaigns-summary.json') as Record<string, unknown>[];
    expect(result[0].objective).toBe('OUTCOME_APP_PROMOTION');
    expect(result[0].campaign_id).toBe('12345');
  });
});

describe('output format', () => {
  it('writes pretty-printed JSON with 2-space indent', async () => {
    writeJson('campaigns.json', { data: [makeRow({ campaign_id: '1', campaign_name: 'C' })] });

    await summarize(tmpDir);
    const raw = fs.readFileSync(path.join(tmpDir, 'campaigns-summary.json'), 'utf-8');

    // 2-space indent produces lines starting with "  " for object properties
    expect(raw).toContain('\n  ');
    // Verify it's valid JSON that round-trips
    expect(JSON.parse(raw)).toHaveLength(1);
  });
});
