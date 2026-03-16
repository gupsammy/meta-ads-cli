import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

const TOKEN = 'test_access_token_123';

vi.mock('../../lib/config.js', () => ({
  ConfigManager: vi.fn().mockImplementation(() => ({
    read: () => ({}),
    write: vi.fn(),
    getDefault: () => undefined,
    setDefault: vi.fn(),
    getConfigPath: () => '/mock/config.json',
    getConfigDir: () => '/mock/meta-ads-cli',
  })),
}));

vi.mock('../../auth.js', () => ({
  requireAccessToken: () => TOKEN,
  resolveAccessToken: () => TOKEN,
  requireAccountId: (v?: string) => v?.startsWith('act_') ? v : `act_${v}`,
  resolveAccountId: (v?: string) => v ? (v.startsWith('act_') ? v : `act_${v}`) : undefined,
}));

import { registerUninstallCommand } from '../../commands/uninstall.js';

describe('uninstall command', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should exit with USAGE code when not confirmed in non-TTY', async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const program = new Command();
    program.exitOverride();
    registerUninstallCommand(program);

    await program.parseAsync(['node', 'meta-ads', 'uninstall']);
    expect(exitSpy).toHaveBeenCalledWith(2);

    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('should register with correct options', () => {
    const program = new Command();
    registerUninstallCommand(program);

    const cmd = program.commands.find(c => c.name() === 'uninstall');
    expect(cmd).toBeDefined();

    const optionNames = cmd!.options.map(o => o.long);
    expect(optionNames).toContain('--keep-config');
    expect(optionNames).toContain('--force');
  });

  it('should register with correct description', () => {
    const program = new Command();
    registerUninstallCommand(program);

    const cmd = program.commands.find(c => c.name() === 'uninstall');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe('Uninstall meta-ads-cli');
  });
});
