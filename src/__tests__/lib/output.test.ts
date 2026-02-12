import { describe, it, expect } from 'vitest';
import { formatOutput } from '../../lib/output.js';

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
