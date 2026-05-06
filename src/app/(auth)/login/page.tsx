'use client';

import { useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

// Minimal login form. No styling polish, no remember-me, no forgot-
// password — those flows land alongside Mailgun integration in a
// future slice. The only goal here is to unblock GUI work: a working
// session cookie after a successful POST.

type LoginErrorBody = { error?: string; message?: string };

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as LoginErrorBody;
    return body.message ?? body.error ?? `Login failed (${res.status})`;
  } catch {
    return `Login failed (${res.status})`;
  }
}

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      // BetterAuth sets the session cookie on the success response.
      // Use a hard navigation so server components reload with the
      // new cookie (router.push wouldn't re-run RSC layouts).
      window.location.assign(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setPending(false);
    }
  }

  return (
    <main style={{ maxWidth: 360, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Sign in</h1>
      <form onSubmit={onSubmit}>
        <label style={{ display: 'block', marginTop: '1rem' }}>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
          />
        </label>
        <label style={{ display: 'block', marginTop: '1rem' }}>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
          />
        </label>
        {error ? (
          <p role="alert" style={{ color: 'crimson', marginTop: '1rem' }}>
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          style={{ marginTop: '1.5rem', padding: '0.5rem 1rem' }}
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
