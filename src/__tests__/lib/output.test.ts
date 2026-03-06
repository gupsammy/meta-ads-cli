import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatOutput, getErrorHint, printError, printListOutput } from '../../lib/output.js';

describe('formatOutput', () => {
  const sampleData = [
    { id: '1', name: 'Campaign A', status: 'ACTIVE' },
    { id: '2', name: 'Campaign B', status: 'PAUSED' },
  ];

  describe('json format', () => {
    it('should format array data as JSON', () => {
      const result = formatOutput(sampleData, 'json');
      const parsed = JSON.parse(result);
      expect(parsed).toEqual(sampleData);
    });

    it('should format single object as JSON', () => {
      const result = formatOutput(sampleData[0], 'json');
      const parsed = JSON.parse(result);
      expect(parsed).toEqual(sampleData[0]);
    });
  });

  describe('table format', () => {
    it('should format data as a table', () => {
      const result = formatOutput(sampleData, 'table');
      expect(result).toContain('id');
      expect(result).toContain('name');
      expect(result).toContain('status');
      expect(result).toContain('Campaign A');
      expect(result).toContain('ACTIVE');
    });

    it('should handle empty array', () => {
      const result = formatOutput([], 'table');
      expect(result).toBe('No data');
    });

    it('should suppress color when NO_COLOR is set', () => {
      process.env['NO_COLOR'] = '1';
      const result = formatOutput(sampleData, 'table');
      expect(result).toContain('Campaign A');
      expect(result).not.toContain('\x1B[36m');
      delete process.env['NO_COLOR'];
    });
  });

  describe('csv format', () => {
    it('should format data as CSV', () => {
      const result = formatOutput(sampleData, 'csv');
      expect(result).toContain('id');
      expect(result).toContain('name');
      expect(result).toContain('status');
      expect(result).toContain('Campaign A');
    });

    it('should handle empty array', () => {
      const result = formatOutput([], 'csv');
      expect(result).toBe('');
    });
  });
});

describe('getErrorHint', () => {
  it('should return hint for AUTH_FAILED', () => {
    expect(getErrorHint('AUTH_FAILED')).toBe('meta-ads auth login --token <token>');
  });

  it('should return hint for API_ERROR_190', () => {
    expect(getErrorHint('API_ERROR_190')).toBe('meta-ads auth login --token <token>');
  });

  it('should return null for RATE_LIMITED', () => {
    expect(getErrorHint('RATE_LIMITED')).toBeNull();
  });

  it('should return null for unknown codes', () => {
    expect(getErrorHint('SOME_OTHER_ERROR')).toBeNull();
  });
});

describe('printListOutput', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleLogSpy: any;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('should wrap data with pagination metadata in json mode', () => {
    const data = [{ id: '1', name: 'Test' }];
    printListOutput(data, 'json', { has_more: true, next_cursor: 'abc123' });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.data).toEqual(data);
    expect(output.has_more).toBe(true);
    expect(output.next_cursor).toBe('abc123');
  });

  it('should set has_more to false when no paging info', () => {
    const data = [{ id: '1', name: 'Test' }];
    printListOutput(data, 'json');

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.data).toEqual(data);
    expect(output.has_more).toBe(false);
  });

  it('should omit next_cursor when not present', () => {
    const data = [{ id: '1', name: 'Test' }];
    printListOutput(data, 'json', { has_more: false });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output).not.toHaveProperty('next_cursor');
  });

  it('should output table format for table mode', () => {
    const data = [{ id: '1', name: 'Test' }];
    printListOutput(data, 'table', { has_more: false });

    const output = consoleLogSpy.mock.calls[0][0] as string;
    expect(output).toContain('id');
    expect(output).toContain('Test');
  });

  it('should output No data for empty table', () => {
    printListOutput([], 'table');
    expect(consoleLogSpy.mock.calls[0][0]).toBe('No data');
  });
});

describe('printError', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('should include hint in json output', () => {
    printError({ code: 'AUTH_FAILED', message: 'Bad token' }, 'json');
    const output = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(output.error).toBe('AUTH_FAILED');
    expect(output.hint).toBe('meta-ads auth login --token <token>');
  });

  it('should include hint in text output', () => {
    printError({ code: 'AUTH_FAILED', message: 'Bad token' }, 'table');
    const output = consoleErrorSpy.mock.calls[0][0] as string;
    expect(output).toContain('Hint: meta-ads auth login --token <token>');
  });

  it('should use explicit hint when provided', () => {
    printError({ code: 'UNKNOWN', message: 'Error', hint: 'Do this thing' }, 'json');
    const output = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(output.hint).toBe('Do this thing');
  });

  it('should omit hint when null', () => {
    printError({ code: 'UNKNOWN', message: 'Error' }, 'json');
    const output = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(output).not.toHaveProperty('hint');
  });
});
