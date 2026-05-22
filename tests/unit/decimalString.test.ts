import { describe, expect, it } from 'vitest';
import { decimalString } from '@/lib/validation/common';
import {
  isNonNegativeDecimalInput,
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

// The leading-dot shorthand (".93", ".5") must be accepted everywhere a
// money/decimal value is entered — both the server validator and the
// client helpers — and normalized to a canonical leading-zero form.

describe('decimalString (server validator)', () => {
  it('accepts standard + leading-dot forms', () => {
    for (const v of [
      '0.93',
      '.93',
      '93',
      '93.00',
      '0.5',
      '.5',
      '-.25',
      '-12.5',
      '-0.5',
    ]) {
      expect(decimalString.safeParse(v).success).toBe(true);
    }
  });

  it('accepts numeric input too', () => {
    expect(decimalString.parse(0.93)).toBe('0.93');
    expect(decimalString.parse(93)).toBe('93');
  });

  it('normalizes the leading-dot form to a leading-zero form', () => {
    expect(decimalString.parse('.93')).toBe('0.93');
    expect(decimalString.parse('.5')).toBe('0.5');
    expect(decimalString.parse('-.25')).toBe('-0.25');
  });

  it('preserves already-canonical values (incl. trailing zeros)', () => {
    expect(decimalString.parse('0.93')).toBe('0.93');
    expect(decimalString.parse('93.00')).toBe('93.00');
    expect(decimalString.parse('93')).toBe('93');
    expect(decimalString.parse('-12.5')).toBe('-12.5');
  });

  it('rejects non-decimal junk', () => {
    for (const v of ['', '.', '-', 'abc', '1.2.3', '1,000', '$5', '1.']) {
      expect(decimalString.safeParse(v).success).toBe(false);
    }
  });
});

describe('client decimal-input helpers', () => {
  it('isNonNegativeDecimalInput accepts the leading-dot form', () => {
    expect(isNonNegativeDecimalInput('.93')).toBe(true);
    expect(isNonNegativeDecimalInput('.5')).toBe(true);
    expect(isNonNegativeDecimalInput('0')).toBe(true);
    expect(isNonNegativeDecimalInput('')).toBe(false);
    expect(isNonNegativeDecimalInput('.')).toBe(false);
  });

  it('isPositiveDecimalInput accepts ".5" but rejects "0" / "0.0"', () => {
    expect(isPositiveDecimalInput('.5')).toBe(true);
    expect(isPositiveDecimalInput('.93')).toBe(true);
    expect(isPositiveDecimalInput('0')).toBe(false);
    expect(isPositiveDecimalInput('0.0')).toBe(false);
  });

  it('normalizeDecimalForSubmit canonicalizes leading-dot, preserves trailing zeros', () => {
    expect(normalizeDecimalForSubmit('.93')).toBe('0.93');
    expect(normalizeDecimalForSubmit('.5')).toBe('0.5');
    expect(normalizeDecimalForSubmit('10.50')).toBe('10.50');
    expect(normalizeDecimalForSubmit('93')).toBe('93');
  });
});
