import { createClient } from "@supabase/supabase-js";

// Server-only Supabase client. Prefer the service-role key so future RLS
// won't block server-side writes; fall back to the anon key so Phase 5 still
// works against the unauthenticated, no-RLS dev DB documented in CLAUDE.md.
// Never import this from a "use client" component — service-role keys must
// never reach the browser.
export function getServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/NEXT_PUBLIC_SUPABASE_ANON_KEY in environment.",
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
