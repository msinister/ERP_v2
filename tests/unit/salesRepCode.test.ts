import { describe, expect, it } from 'vitest';
import { deriveSalesRepCodeBase } from '@/server/services/salesReps';

// Auto-generated sales-rep codes must match the manual convention (short,
// uppercase, e.g. "CPT", "SKT") — NO "REP-" prefix.

describe('deriveSalesRepCodeBase', () => {
  it('uses initials for multi-word names', () => {
    expect(deriveSalesRepCodeBase('Chris P. Thompson', null)).toBe('CPT');
    expect(deriveSalesRepCodeBase('Sky Kratom Trading', null)).toBe('SKT');
    expect(deriveSalesRepCodeBase('bo xi', null)).toBe('BX');
  });

  it('caps initials at 4 chars', () => {
    expect(deriveSalesRepCodeBase('A B C D E F', null)).toBe('ABCD');
  });

  it('uses first 3 chars for a single-word name', () => {
    expect(deriveSalesRepCodeBase('Madonna', null)).toBe('MAD');
  });

  it('falls back to the email local part when the name has no letters', () => {
    expect(deriveSalesRepCodeBase('   ', 'skyler@example.com')).toBe('SKY');
    expect(deriveSalesRepCodeBase('!', 'cpt.jones@x.com')).toBe('CPT');
  });

  it('never emits the REP- prefix and is always uppercase', () => {
    for (const name of ['Chris Thompson', 'Madonna', '', '   ', '123']) {
      const code = deriveSalesRepCodeBase(name, 'fallback@example.com');
      expect(code.startsWith('REP-')).toBe(false);
      expect(code).toBe(code.toUpperCase());
      expect(code.length).toBeGreaterThanOrEqual(2);
      expect(code.length).toBeLessThanOrEqual(4);
    }
  });
});
