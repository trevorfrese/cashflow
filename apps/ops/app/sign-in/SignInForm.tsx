'use client';

import { useState, type FormEvent } from 'react';

import { Button, Field, Notice } from '@/components/ui';

/**
 * Sends the token and the operator's name to the console server, once. The server checks
 * them with the API and answers with an httpOnly cookie. The token is held only in this
 * form's password field while it is being typed: it is not kept in component state after
 * submitting, and never in localStorage, sessionStorage, or a readable cookie.
 */
export function SignInForm({ expired }: { expired: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: data.get('token'), actor: data.get('actor') }),
      });
      if (response.ok) {
        form.reset();
        window.location.assign('/');
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(body?.error?.message ?? `Sign in failed (status ${response.status}).`);
    } catch {
      setError('The console server did not answer. Is it still running?');
    }
    setBusy(false);
  }

  return (
    <form className="form" onSubmit={submit} autoComplete="off">
      {expired && !error ? (
        <Notice tone="warn" title="Your session ended">
          <p>Sign in again to carry on.</p>
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="bad" title="Could not sign in">
          <p>{error}</p>
        </Notice>
      ) : null}
      <Field
        label="Your name or email"
        htmlFor="actor"
        required
        hint="Recorded on everything you do here, in the audit log."
      >
        <input
          id="actor"
          name="actor"
          type="text"
          required
          minLength={2}
          maxLength={120}
          autoComplete="off"
          aria-describedby="actor-hint"
        />
      </Field>
      <Field
        label="Operator token"
        htmlFor="token"
        required
        hint="The reviewer or admin token from the API's environment. Your role comes from the token."
      >
        <input
          id="token"
          name="token"
          type="password"
          required
          autoComplete="off"
          spellCheck={false}
          aria-describedby="token-hint"
        />
      </Field>
      <Button type="submit" variant="azure" busy={busy}>
        Sign in
      </Button>
    </form>
  );
}
