"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { apiFetch } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { isUserRole, type UserRole } from "@/lib/permissions";
import { landingPathFor } from "@/lib/role-routing";
import {
  sessionVerdict,
  verdictShouldClearSession,
  verdictShouldRedirect,
} from "@/lib/session-verification";
import { useSalesperson } from "@/lib/use-salesperson";

import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type LoginPerson = {
  id: string;
  first_name: string;
  role: string;
};

/** Shape of a /api/auth/login response (success or error). */
type LoginResponse = {
  salesperson?: {
    id: string;
    first_name: string;
    is_test: boolean;
    role: string;
  };
  token?: string;
  error?: string;
};

export default function Home() {
  const router = useRouter();
  const { salesperson, setSalesperson, clear, loaded } = useSalesperson();

  const [people, setPeople] = useState<LoginPerson[] | null>(null);
  const [typed, setTyped] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // ─── Stored-session verification ──────────────────────────────────────
  // A stored session is NOT proof of a working one. Presence alone used to
  // trigger `router.replace(landingPathFor(...))`, which with a stale token
  // produced a hard loop: this page bounced to /dashboard, /dashboard got 401
  // and bounced back, forever — the name picker never became usable.
  //
  // Now the session is confirmed with the server first, and each outcome has
  // exactly one action (see src/lib/session-verification.ts):
  //   200 → redirect ONCE      401 → clear ONCE and stay here
  //   other/offline → keep the session, stay here, never loop.
  const [verify, setVerify] = useState<{
    settled: boolean;
    status: number | null;
    role: UserRole | null;
  }>({ settled: false, status: null, role: null });

  useEffect(() => {
    if (!loaded) return;
    if (!salesperson) return; // nothing to verify
    let cancelled = false;
    void (async () => {
      let status: number | null = null;
      let role: UserRole | null = null;
      try {
        const res = await apiFetch("/api/me/permissions");
        status = res.status;
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as {
            role?: unknown;
          } | null;
          // Trust the SERVER's role for the landing decision, not the stored
          // copy (which the user can edit).
          if (isUserRole(body?.role)) role = body.role;
        }
      } catch {
        // Network failure — `status` stays null → verdict "unknown".
      }
      if (cancelled) return;
      setVerify({ settled: true, status, role });
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, salesperson]);

  const verdict = sessionVerdict({
    loaded,
    hasStoredSession: salesperson !== null,
    settled: verify.settled,
    status: verify.status,
    role: verify.role,
  });

  // One-shot guards: at most ONE navigation and at most ONE clear per mount,
  // so a re-render can never re-fire either.
  const redirectedRef = useRef(false);
  const clearedRef = useRef(false);

  useEffect(() => {
    if (verdictShouldRedirect(verdict)) {
      if (redirectedRef.current) return;
      redirectedRef.current = true;
      router.replace(
        landingPathFor({ role: verdict.kind === "valid" ? verdict.role : "ae" }),
      );
      return;
    }
    if (verdictShouldClearSession(verdict)) {
      if (clearedRef.current) return;
      clearedRef.current = true;
      // Deletes localStorage synchronously, then drops the in-memory copy. No
      // navigation: we are already on the sign-in screen, and the next render
      // sees no session, so there is nothing left to redirect on.
      clear();
    }
  }, [verdict, router, clear]);

  // Roster for the name picker. Fetched independently of session
  // verification so the picker is ready the moment the screen is usable —
  // previously it only loaded once we knew there was no session.
  useEffect(() => {
    // Bulk fetch deliberately excludes admin_pin — we only need id/name/role
    // here to power autocomplete + decide whether to show the PIN field.
    // role (not the legacy is_admin column) drives the PIN gate so the form
    // agrees with the server's `requireAdmin` and `/api/auth/login` PIN
    // check, which also key on role === 'admin'.
    //
    // `deactivated_at IS NULL` is the active-roster predicate: someone who
    // has left the company keeps their row (their history hangs off it) but
    // must not appear in the name list. This is presentation only — the
    // authoritative refusal is in /api/auth/login, which rejects a
    // deactivated row even if the name is typed in by hand.
    supabase
      .from("salespeople")
      .select("id, first_name, role")
      .is("deactivated_at", null)
      .order("first_name", { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          setError(error.message);
          return;
        }
        setPeople((data ?? []) as LoginPerson[]);
      });
  }, []);

  // The salesperson whose name exactly matches what's typed/selected, or null.
  // Sign in stays disabled until this is set — no AE name is ever pre-filled.
  const selectedPerson = useMemo(() => {
    if (!people) return null;
    const lower = typed.trim().toLowerCase();
    if (!lower) return null;
    return people.find((p) => p.first_name.toLowerCase() === lower) ?? null;
  }, [people, typed]);

  // Admins additionally enter a PIN. role is the single source of truth for
  // admin status — the legacy is_admin column is not consulted here so a
  // drifted row (is_admin=true, role='ae') doesn't display a PIN prompt
  // the server-side gate wouldn't actually validate.
  const matchedAdmin = selectedPerson?.role === "admin" ? selectedPerson : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = typed.trim();
    if (!name) {
      setError("Type your name.");
      return;
    }
    setLoading(true);
    setError(null);

    // Credentials are validated server-side: the admin PIN is compared in
    // /api/auth/login and never sent back to the browser. On success the
    // server returns a signed session token used to authorize API calls.
    let payload: LoginResponse | null = null;
    let status = 0;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, pin }),
      });
      status = res.status;
      payload = (await res.json().catch(() => null)) as LoginResponse | null;
    } catch (err) {
      setLoading(false);
      setError(
        `Sign in failed: ${err instanceof Error ? err.message : "network error"}`,
      );
      return;
    }
    setLoading(false);

    const signedIn = payload?.salesperson;
    const token = payload?.token;
    if (!signedIn || !token) {
      setError(payload?.error ?? `Sign in failed (${status}).`);
      return;
    }

    const role = isUserRole(signedIn.role) ? signedIn.role : "ae";
    setSalesperson({
      id: signedIn.id,
      first_name: signedIn.first_name,
      is_test: signedIn.is_test === true,
      role,
      token,
    });
    router.push(landingPathFor({ role }));
  };

  // ONE stable screen while a stored session is being checked, and while a
  // confirmed one is navigating away. No flash of the picker, and — crucially —
  // no redirect from here on anything other than a server-confirmed session.
  if (verdict.kind === "verifying" || verdict.kind === "valid") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
        <Logo width={240} height={74} priority />
        <p className="text-sm text-muted-foreground">
          {verdict.kind === "valid"
            ? "Signing you in…"
            : loaded && salesperson !== null
              ? "Checking your saved sign-in…"
              : // Pre-hydration: localStorage hasn't been read yet, so we don't
                // yet know whether there IS a saved sign-in to check. Same
                // neutral state /dashboard and /juice-box show.
                "Loading…"}
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <Logo width={240} height={74} priority />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Type your first name. Admins also enter a PIN.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Your name</Label>
              <Input
                id="name"
                name="name"
                list="salespeople-list"
                autoComplete="off"
                autoCapitalize="words"
                placeholder="Select your name"
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setError(null);
                }}
                disabled={loading || !people}
              />
              <datalist id="salespeople-list">
                {people?.map((p) => (
                  <option key={p.id} value={p.first_name} />
                ))}
              </datalist>
            </div>

            {matchedAdmin && (
              <div className="space-y-2">
                <Label htmlFor="pin">Admin PIN</Label>
                <Input
                  id="pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="PIN"
                  value={pin}
                  onChange={(e) => {
                    setPin(e.target.value);
                    setError(null);
                  }}
                  onFocus={(e) => e.currentTarget.select()}
                  disabled={loading}
                />
              </div>
            )}

            {/* The saved-session check failed (server error / offline). The
                session was NOT cleared — it may well be fine — and we did not
                redirect, so there is no loop. Signing in again is available
                right here if they'd rather not wait. */}
            {verdict.kind === "unknown" && !error && (
              <p className="text-sm text-muted-foreground">
                Couldn&apos;t check your saved sign-in. You can sign in again
                below.
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {!people && !error && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {people?.length === 0 && !error && (
              <p className="text-sm text-muted-foreground">
                Run <code>supabase/seed.sql</code> in your Supabase SQL editor
                to add the team.
              </p>
            )}

            <Button
              className="w-full"
              type="submit"
              disabled={loading || !selectedPerson || (!!matchedAdmin && !pin)}
            >
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
