import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

const TOKEN = 'test_access_token_123';

vi.mock('../../auth.js', () => ({
  requireAccessToken: () => TOKEN,
  resolveAccessToken: () => TOKEN,
  requireAccountId: (v?: string) => v?.startsWith('act_') ? v : `act_${v}`,
  resolveAccountId: (v?: string) => v ? (v.startsWith('act_') ? v : `act_${v}`) : undefined,
}));

import { registerUpdateCommand } from '../../commands/update.js';

describe('update command', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should report up_to_date when versions match', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ version: '0.1.0' }), { status: 200 }),
    );

    const program = new Command();
    program.version('0.1.0');
    program.exitOverride();
    registerUpdateCommand(program);

    await program.parseAsync(['node', 'meta-ads', 'update', '--check', '-o', 'json']);
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.status).toBe('up_to_date');
  });

  it('should report update_available when versions differ', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 }),
    );

    const program = new Command();
    program.version('0.1.0');
    program.exitOverride();
    registerUpdateCommand(program);

    await program.parseAsync(['node', 'meta-ads', 'update', '--check', '-o', 'json']);
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.status).toBe('update_available');
    expect(output.latest_version).toBe('0.2.0');
  });

  it('should normalize v-prefixed versions', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ version: 'v0.1.0' }), { status: 200 }),
    );

    const program = new Command();
    program.version('v0.1.0');
    program.exitOverride();
    registerUpdateCommand(program);

    await program.parseAsync(['node', 'meta-ads', 'update', '--check', '-o', 'json']);
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.status).toBe('up_to_date');
  });

  it('should handle npm registry errors', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('Not Found', { status: 404 }),
    );

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const program = new Command();
    program.version('0.1.0');
    program.exitOverride();
    registerUpdateCommand(program);

    await program.parseAsync(['node', 'meta-ads', 'update', '--check', '-o', 'json']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
