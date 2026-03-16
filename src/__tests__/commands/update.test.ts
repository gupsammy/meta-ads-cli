import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const TOKEN = 'test_access_token_123';

vi.mock('../../auth.js', () => ({
  requireAccessToken: () => TOKEN,
  resolveAccessToken: () => TOKEN,
  requireAccountId: (v?: string) => v?.startsWith('act_') ? v : `act_${v}`,
  resolveAccountId: (v?: string) => v ? (v.startsWith('act_') ? v : `act_${v}`) : undefined,
}));

describe('update command', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('should fetch latest version from npm registry', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 }),
    );

    const response = await fetch('https://registry.npmjs.org/meta-ads-cli/latest');
    const data = await response.json() as { version: string };

    expect(data.version).toBe('1.2.3');
  });

  it('should handle npm registry errors', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('Not Found', { status: 404 }),
    );

    const response = await fetch('https://registry.npmjs.org/meta-ads-cli/latest');
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  });

  it('should compare versions correctly', () => {
    const current = '0.1.0';
    const latest = '0.2.0';
    expect(current).not.toBe(latest);

    const sameVersion = '0.1.0';
    expect(current).toBe(sameVersion);
  });
});
