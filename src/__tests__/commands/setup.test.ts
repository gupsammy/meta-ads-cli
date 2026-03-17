import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { EventEmitter } from 'node:events';
import nock from 'nock';

const BASE_URL = 'https://graph.facebook.com';
const TOKEN = 'test_access_token_123';

const { mockSaveToken, mockGetDefault, mockSetDefault, mockResolveAccessToken, mockSpawn } = vi.hoisted(() => ({
  mockSaveToken: vi.fn(),
  mockGetDefault: vi.fn().mockReturnValue(undefined),
  mockSetDefault: vi.fn(),
  mockResolveAccessToken: vi.fn().mockReturnValue(undefined),
  mockSpawn: vi.fn(),
}));

vi.mock('../../lib/config.js', () => ({
  ConfigManager: vi.fn().mockImplementation(() => ({
    read: vi.fn().mockReturnValue({}),
    write: vi.fn(),
    getDefault: mockGetDefault,
    setDefault: mockSetDefault,
    getConfigPath: vi.fn().mockReturnValue('/mock/config.json'),
    getConfigDir: vi.fn().mockReturnValue('/mock'),
  })),
}));

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('../../auth.js', () => ({
  requireAccessToken: () => TOKEN,
  resolveAccessToken: (...args: unknown[]) => mockResolveAccessToken(...args),
  saveToken: (...args: unknown[]) => mockSaveToken(...args),
  exchangeForLongLivedToken: vi.fn(),
  requireAccountId: (v?: string) => v?.startsWith('act_') ? v : `act_${v}`,
  resolveAccountId: (v?: string) => v ? (v.startsWith('act_') ? v : `act_${v}`) : undefined,
}));

import { registerSetupCommand } from '../../commands/setup.js';

describe('setup command', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nock.cleanAll();
    mockSaveToken.mockClear();
    mockSetDefault.mockClear();
    mockSpawn.mockClear();
    mockGetDefault.mockReturnValue(undefined);
    mockResolveAccessToken.mockReturnValue(undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
  });

  it('should exit with code 2 when --non-interactive without --token', async () => {
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);

    await program.parseAsync(['node', 'meta-ads', 'setup', '--non-interactive']);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('should save token in non-interactive mode', async () => {
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);

    nock(BASE_URL).get('/v21.0/act_111').query(true).reply(401, { error: { message: 'bad', type: 'OAuthException', code: 190 } });

    await program.parseAsync(['node', 'meta-ads', 'setup', '--non-interactive', '--token', 'my_token_123', '--account-id', 'act_111']);
    expect(mockSaveToken).toHaveBeenCalledWith('my_token_123');
  });

  it('should set default account in non-interactive mode', async () => {
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);

    nock(BASE_URL).get('/v21.0/act_222').query(true).reply(401, { error: { message: 'bad', type: 'OAuthException', code: 190 } });

    await program.parseAsync(['node', 'meta-ads', 'setup', '--non-interactive', '--token', 'tok', '--account-id', '222']);
    expect(mockSetDefault).toHaveBeenCalledWith('account_id', 'act_222');
  });

  it('should warn when overwriting existing token', async () => {
    mockResolveAccessToken.mockReturnValue('old_token_abcd');
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);

    nock(BASE_URL).get('/v21.0/act_111').query(true).reply(401, { error: { message: 'bad', type: 'OAuthException', code: 190 } });

    await program.parseAsync(['node', 'meta-ads', 'setup', '--non-interactive', '--token', 'new_token', '--account-id', 'act_111']);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('overwriting existing token'));
  });

  it('should run health check against account endpoint', async () => {
    const mockAccount = { id: 'act_111', name: 'Test Account', currency: 'USD', account_status: 1 };
    nock(BASE_URL).get('/v21.0/act_111').query(true).reply(200, mockAccount);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockAccount>(
      '/act_111', TOKEN, { params: { fields: 'id,name,currency,account_status' } },
    );

    expect(result.name).toBe('Test Account');
    expect(result.account_status).toBe(1);
  });

  it('should not spawn npx when --install-skill is not passed in non-interactive mode', async () => {
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);

    nock(BASE_URL).get('/v21.0/act_111').query(true).reply(200, { id: 'act_111', name: 'Test', currency: 'USD', account_status: 1 });

    await program.parseAsync(['node', 'meta-ads', 'setup', '--non-interactive', '--token', 'tok', '--account-id', 'act_111']);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should spawn npx skills when --install-skill is passed in non-interactive mode', async () => {
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);

    nock(BASE_URL).get('/v21.0/act_111').query(true).reply(200, { id: 'act_111', name: 'Test', currency: 'USD', account_status: 1 });

    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child);
    // Emit close on next tick so the promise resolves
    setTimeout(() => child.emit('close', 0), 0);

    await program.parseAsync(['node', 'meta-ads', 'setup', '--non-interactive', '--token', 'tok', '--account-id', 'act_111', '--install-skill']);
    expect(mockSpawn).toHaveBeenCalledWith('npx', ['-y', 'skills', 'add', 'gupsammy/meta-ads-cli'], { shell: true, stdio: 'inherit' });
    expect(stderrSpy).toHaveBeenCalledWith('  AI analysis skill installed.\n');
  });

  it('should handle skill install failure gracefully in non-interactive mode', async () => {
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);

    nock(BASE_URL).get('/v21.0/act_111').query(true).reply(200, { id: 'act_111', name: 'Test', currency: 'USD', account_status: 1 });

    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child);
    setTimeout(() => child.emit('close', 1), 0);

    await program.parseAsync(['node', 'meta-ads', 'setup', '--non-interactive', '--token', 'tok', '--account-id', 'act_111', '--install-skill']);
    expect(stderrSpy).toHaveBeenCalledWith('  Skill installation failed. You can install it manually:');
    // Setup should still complete
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('should handle spawn error event gracefully', async () => {
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);

    nock(BASE_URL).get('/v21.0/act_111').query(true).reply(200, { id: 'act_111', name: 'Test', currency: 'USD', account_status: 1 });

    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child);
    setTimeout(() => child.emit('error', new Error('ENOENT')), 0);

    await program.parseAsync(['node', 'meta-ads', 'setup', '--non-interactive', '--token', 'tok', '--account-id', 'act_111', '--install-skill']);
    expect(stderrSpy).toHaveBeenCalledWith('  Skill installation failed. You can install it manually:');
  });

  it('should list ad accounts for selection', async () => {
    const mockResponse = {
      data: [
        { id: 'act_111', name: 'Account A', account_id: '111', account_status: 1, currency: 'USD' },
        { id: 'act_222', name: 'Account B', account_id: '222', account_status: 1, currency: 'EUR' },
      ],
      paging: { cursors: { before: 'a', after: 'b' } },
    };

    nock(BASE_URL).get('/v21.0/me/adaccounts').query(true).reply(200, mockResponse);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockResponse>(
      '/me/adaccounts', TOKEN, { params: { fields: 'id,name,account_id,account_status,currency' } },
    );

    expect(result.data).toHaveLength(2);
    expect(result.data![0].id).toBe('act_111');
  });
});
