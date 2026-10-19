import { describe, expect, it } from 'vitest';
import { formatInr } from './money.js';

describe('formatInr (exact decimal strings, Indian grouping, no JavaScript numbers)', () => {
  it('formats with a rupee sign, two decimals and lakh/crore grouping', () => {
    expect(formatInr('0')).toBe('₹0.00');
    expect(formatInr('7.5')).toBe('₹7.50');
    expect(formatInr('999.99')).toBe('₹999.99');
    expect(formatInr('1000.00')).toBe('₹1,000.00');
    expect(formatInr('1180')).toBe('₹1,180.00');
    expect(formatInr('100000.00')).toBe('₹1,00,000.00');
    expect(formatInr('1234567.5')).toBe('₹12,34,567.50');
    expect(formatInr('123456789.01')).toBe('₹12,34,56,789.01');
  });

  it('keeps every digit of an amount a JavaScript number cannot hold', () => {
    expect(formatInr('1234567890123456.78')).toBe('₹1,23,45,67,89,01,23,456.78');
    expect(formatInr('9007199254740993.01')).toBe('₹9,00,71,99,25,47,40,993.01');
  });

  it('shows nothing for an empty value and echoes anything that is not a plain decimal', () => {
    expect(formatInr(null)).toBe('');
    expect(formatInr(undefined)).toBe('');
    expect(formatInr('')).toBe('');
    expect(formatInr('12abc')).toBe('12abc');
    expect(formatInr('007.5')).toBe('₹7.50');
  });
});
