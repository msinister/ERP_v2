import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '@/lib/crypto';

describe('lib/crypto AES-256-GCM helper', () => {
  it('encrypt/decrypt round-trips a plaintext string', () => {
    const plain = 'EIN: 12-3456789';
    const { ciphertext, iv } = encrypt(plain);
    expect(typeof ciphertext).toBe('string');
    expect(typeof iv).toBe('string');
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(decrypt(ciphertext, iv)).toBe(plain);
  });

  it('round-trips empty string and unicode payloads', () => {
    for (const plain of ['', 'plain ascii', 'unicodé café — 🎉 漢字']) {
      const { ciphertext, iv } = encrypt(plain);
      expect(decrypt(ciphertext, iv)).toBe(plain);
    }
  });

  it('produces a different ciphertext + IV on each call for the same plaintext', () => {
    const plain = 'SSN: 999-00-0000';
    const a = encrypt(plain);
    const b = encrypt(plain);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // But both decrypt to the same value.
    expect(decrypt(a.ciphertext, a.iv)).toBe(plain);
    expect(decrypt(b.ciphertext, b.iv)).toBe(plain);
  });

  it('decrypt throws when ciphertext has been tampered with (single-byte flip)', () => {
    const { ciphertext, iv } = encrypt('DL: D1234567');
    const buf = Buffer.from(ciphertext, 'base64');
    // Flip one bit in the very first ciphertext byte (before the auth tag).
    buf[0] = buf[0] ^ 0x01;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered, iv)).toThrow();
  });

  it('decrypt throws when the auth tag has been tampered with', () => {
    const { ciphertext, iv } = encrypt('DL: D1234567');
    const buf = Buffer.from(ciphertext, 'base64');
    // Flip a bit in the last byte (which is part of the 16-byte auth tag).
    buf[buf.length - 1] = buf[buf.length - 1] ^ 0x01;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered, iv)).toThrow();
  });

  it('decrypt throws when the IV does not match the encrypt IV', () => {
    const a = encrypt('payload A');
    const b = encrypt('payload B');
    // Same key, but use B's IV with A's ciphertext — auth tag fails.
    expect(() => decrypt(a.ciphertext, b.iv)).toThrow();
  });

  it('decrypt throws when the IV is the wrong length', () => {
    const { ciphertext } = encrypt('x');
    const shortIv = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString('base64'); // 8 bytes
    expect(() => decrypt(ciphertext, shortIv)).toThrow(/iv must be 12 bytes/);
  });

  it('throws at module load when TENANT_FIELD_ENCRYPTION_KEY is missing or wrong size', async () => {
    const original = process.env.TENANT_FIELD_ENCRYPTION_KEY;
    try {
      // (a) missing key
      delete process.env.TENANT_FIELD_ENCRYPTION_KEY;
      // Bypass Vitest's module cache so the ESM import re-runs the module's
      // top-level loadKey() validation. The query-string cache-buster forces
      // Vite to re-resolve and re-execute the module.
      await expect(
        import(/* @vite-ignore */ `@/lib/crypto/index?missing=${Date.now()}`),
      ).rejects.toThrow(/TENANT_FIELD_ENCRYPTION_KEY is not set/);

      // (b) wrong-length key (16 bytes instead of 32)
      process.env.TENANT_FIELD_ENCRYPTION_KEY = Buffer.alloc(16, 0).toString('base64');
      await expect(
        import(/* @vite-ignore */ `@/lib/crypto/index?short=${Date.now()}`),
      ).rejects.toThrow(/must decode to 32 bytes/);
    } finally {
      process.env.TENANT_FIELD_ENCRYPTION_KEY = original;
    }
  });
});
