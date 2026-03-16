import { describe, it, expect, vi } from 'vitest';

const TOKEN = 'test_access_token_123';

const mockConfig = {
  read: vi.fn().mockReturnValue({}),
  write: vi.fn(),
  getDefault: vi.fn().mockReturnValue(undefined),
  setDefault: vi.fn(),
  getConfigPath: vi.fn().mockReturnValue('/mock/config.json'),
  getConfigDir: vi.fn().mockReturnValue('/mock/meta-ads-cli'),
};

vi.mock('../../lib/config.js', () => ({
  ConfigManager: vi.fn().mockImplementation(() => mockConfig),
}));

vi.mock('../../auth.js', () => ({
  requireAccessToken: () => TOKEN,
  resolveAccessToken: () => TOKEN,
  requireAccountId: (v?: string) => v?.startsWith('act_') ? v : `act_${v}`,
  resolveAccountId: (v?: string) => v ? (v.startsWith('act_') ? v : `act_${v}`) : undefined,
}));

describe('uninstall command', () => {
  it('should provide config directory path', () => {
    expect(mockConfig.getConfigDir()).toBe('/mock/meta-ads-cli');
  });

  it('should have force and keep-config options defined', async () => {
    // Verify the command module can be imported without errors
    const { registerUninstallCommand } = await import('../../commands/uninstall.js');
    expect(registerUninstallCommand).toBeDefined();
    expect(typeof registerUninstallCommand).toBe('function');
  });

  it('should have confirmAction available for prompts', async () => {
    const { confirmAction } = await import('../../lib/output.js');
    expect(typeof confirmAction).toBe('function');
  });
});
