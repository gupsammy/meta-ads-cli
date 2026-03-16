import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockGetDefault } = vi.hoisted(() => ({
  mockGetDefault: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../lib/config.js', () => ({
  ConfigManager: vi.fn().mockImplementation(() => ({
    read: vi.fn().mockReturnValue({}),
    write: vi.fn(),
    getDefault: mockGetDefault,
    setDefault: vi.fn(),
    getConfigPath: vi.fn().mockReturnValue('/mock/config.json'),
    getConfigDir: vi.fn().mockReturnValue('/mock'),
  })),
}));

import { resolveAccountId, requireAccountId } from '../auth.js';

describe('resolveAccountId', () => {
  beforeEach(() => {
    mockGetDefault.mockReturnValue(undefined);
  });

  it('should return flag value with act_ prefix when provided', () => {
    expect(resolveAccountId('act_123')).toBe('act_123');
  });

  it('should add act_ prefix to flag value without it', () => {
    expect(resolveAccountId('123')).toBe('act_123');
  });

  it('should fall back to config default when no flag', () => {
    mockGetDefault.mockReturnValue('act_456');
    expect(resolveAccountId()).toBe('act_456');
  });

  it('should add act_ prefix to config default', () => {
    mockGetDefault.mockReturnValue('789');
    expect(resolveAccountId()).toBe('act_789');
  });

  it('should return undefined when no flag and no config', () => {
    expect(resolveAccountId()).toBeUndefined();
  });
});

describe('requireAccountId', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetDefault.mockReturnValue(undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('should return account ID when flag provided', () => {
    expect(requireAccountId('act_123')).toBe('act_123');
  });

  it('should exit when no flag and no config', () => {
    requireAccountId();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should return config default when no flag', () => {
    mockGetDefault.mockReturnValue('act_999');
    expect(requireAccountId()).toBe('act_999');
  });
});
