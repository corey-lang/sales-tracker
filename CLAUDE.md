@AGENTS.md

# Sales Tracker

A daily sales activity tracker for an 11-person team. Mobile-first; reps log activity from their phones, edit past entries, and compare against teammates on a leaderboard. An admin dashboard provides filtering, charts, CSV export, and weekly goal management.

## Identity / auth model

No passwords. First time a rep opens the app, they pick their name from a dropdown; the selection is cached in `localStorage`. Every salesperson is a row in the `salespeople` table — there is no `auth.users` integration yet.

## Activities tracked (per rep per day)

- `office_visits`
- `service_requests`
- `ones_scheduled`
- `ones_held`
- `impressions`
- `team_meetings`
- `gold_list_touches` — derived count. Each rep maintains a personal list of target names (`gold_list_targets`); on the daily entry screen they tap which names they touched and the count is computed from `gold_list_touches_log` rows.

## Tech stack

- Next.js 16 (App Router, React 19) — `create-next-app@latest` installed v16, despite the original spec saying 15. App Router conventions only; no Pages Router code.
- TypeScript, Tailwind CSS v4 (uses `@import "tailwindcss"` and `@theme inline` in `globals.css`).
- shadcn/ui — preset `radix-nova`, base color `slate`, icons `lucide`. Config: `components.json`.
- Supabase (`@supabase/supabase-js`) — browser client only for now in `src/lib/supabase/client.ts`. Project already provisioned externally.
- Forms: `react-hook-form` + `zod` (via `@hookform/resolvers`).
- Dates: `date-fns`.
- Charts: `recharts`.
- Deploy target: Vercel.

## Folder structure

```
src/
  app/                    # App Router routes, layouts, pages
    layout.tsx
    page.tsx
    globals.css           # Tailwind v4 + shadcn theme tokens
  components/
    ui/                   # shadcn primitives (button.tsx, etc.)
  lib/
    utils.ts              # shadcn cn() helper
    supabase/
      client.ts           # browser Supabase client
  types/                  # shared TypeScript types (empty for now)
supabase/
  schema.sql              # canonical schema, run in Supabase SQL editor
public/                   # static assets
components.json           # shadcn config
.env.example              # env var names, no values
.env.local                # gitignored; populated locally
```

Path alias: `@/*` → `src/*`.

## Database schema

Authoritative copy lives in [supabase/schema.sql](supabase/schema.sql). Five tables:

- `salespeople` — `id`, `first_name` (CITEXT, case-insensitive unique), `location`, `created_at`.
- `weekly_goals` — `id`, `effective_from` (date), one int column per activity, `created_at`. **Values are DAILY targets** despite the legacy table name; weekly target = daily × 5 (5 working days). Goals are global (not per-rep) and dated; admin can change them by inserting a new row.
- `activity_entries` — one row per `(salesperson_id, entry_date)`; unique constraint enforces this. Each activity is an int column, plus `gold_list_touches` as a denormalized count.
- `gold_list_targets` — per-rep list of target names; `active` flag for soft-deletes.
- `gold_list_touches_log` — join table: which targets were touched on a given `activity_entry`. Unique on `(activity_entry_id, target_id)`.

Indexes:
- `idx_activity_entries_salesperson_date` — `(salesperson_id, entry_date DESC)` for the "My Week" view.
- `idx_gold_list_targets_salesperson` — partial index `WHERE active = true`.

## Conventions

- **Read Next.js docs before writing routing/RSC/data-fetching code.** `node_modules/next/dist/docs/01-app/` is bundled and reflects v16 (not v15 / not training-data Next.js). The root `AGENTS.md` enforces this.
- shadcn components go under `src/components/ui/`; app-specific components live alongside the routes that use them or under `src/components/` if shared.
- All env vars consumed in the browser must be prefixed `NEXT_PUBLIC_`.
- Currency for the leaderboard / goals is "count of activities," not money. No currency formatting needed.
- Mobile-first Tailwind: design for narrow viewports, then enhance with `sm:` / `md:`.

## Setup on a new machine

1. `npm install`
2. Copy `.env.example` → `.env.local` and fill in the two Supabase values.
3. In the Supabase SQL editor, run `supabase/schema.sql`.
4. `npm run dev` → http://localhost:3000.

## Open questions / TODO

- **Phase 2 work not yet started:** name-picker login screen, daily entry form, "My Week" view, leaderboard, admin dashboard, CSV export, weekly goals editor.
- **Server-side Supabase access** — `client.ts` is browser-only. When server actions or route handlers need DB access we'll add a server client (likely `@supabase/ssr`) and decide on a service-role key story.
- **RLS policies** — `schema.sql` defines no RLS. With no auth, the anon key effectively has full table access. Acceptable for a closed 11-person team but should be revisited before any public exposure.
- **Seeding the 11 salespeople** — needs a one-time INSERT script or admin UI. Not yet written.
- **Gold list management UI** — reps need a way to add/edit/deactivate their own targets. Spec doesn't specify the entry point (settings page? inline?).
- **Timezone handling for `entry_date`** — currently a plain `DATE`. Need to decide which timezone "today" means for a rep entering at 11pm local.
- **Next.js version mismatch** — original spec asked for 15; installed 16.2.6. No code written yet depends on v15-only behavior; leaving on v16 unless this needs to change.
- **Editable past entries** — UI not yet built. Schema already supports it (no readonly flag); `updated_at` column exists but no trigger refreshes it on UPDATE.
