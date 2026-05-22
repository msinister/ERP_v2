import { z } from 'zod';

// Canonical money/decimal validator. Accepts the standard forms ("0.93",
// "93", "93.00", "-12.5") AND the leading-dot shorthand a human naturally
// types (".93", ".5", "-.25"), normalizing the latter to a leading-zero
// form so every downstream consumer (Prisma.Decimal, string compares)
// always sees a standard value. Single source of truth for decimal
// validation across every server schema — extend it, don't reinvent
// per-field regexes.
export const decimalString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine(
    (v) => /^-?(\d+(\.\d+)?|\.\d+)$/.test(v),
    'Must be a decimal number',
  )
  .transform((v) => {
    if (v.startsWith('.')) return `0${v}`; // ".93" → "0.93"
    if (v.startsWith('-.')) return `-0${v.slice(1)}`; // "-.5" → "-0.5"
    return v;
  });
