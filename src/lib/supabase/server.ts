import { createClient } from "@supabase/supabase-js";

// Server-only Supabase client. ALWAYS uses the service-role key.
//
// The business card tables (business_card_scans, business_card_contacts,
// business_card_export_batches) have RLS enabled — see
// supabase/business_card_rls.sql — and the app has no Supabase Auth, so
// auth.uid() is always NULL. Server-side writes must therefore bypass RLS via
// the service role; an anon-key fallback would silently fail every write with
// "violates row-level security policy". Identity is validated inside the route
// handlers (against the salespeople table), not by RLS.
//
// Never import this from a "use client" component — the service-role key must
// never reach the browser.
export function getServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "Server-side Supabase access requires the service-role key because " +
        "the business card tables have RLS enabled. Set SUPABASE_SERVICE_ROLE_KEY " +
        "in the deployment environment (and local .env.local).",
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      // Force every server-side read/write to bypass Next.js's fetch Data
      // Cache. Without this, a GET inside a route handler can be memoised by
      // Next and serve STALE rows — e.g. an admin adds a working-day holiday,
      // but /api/admin/leaderboard keeps returning a cached
      // working_day_adjustments result (availableDays=5) so the leaderboard
      // never reflects the adjustment. This is a live admin dashboard; reads
      // must always hit the database. `no-store` also disables request
      // memoisation so concurrent reads in one request stay correct.
      fetch: (input, init) =>
        fetch(input, { ...init, cache: "no-store" }),
    },
  });
}
