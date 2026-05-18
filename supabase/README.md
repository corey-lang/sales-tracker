# Supabase schema & migration order

The database has no single authoritative dump. `schema.sql` is the **base**;
every other `.sql` file is a migration or maintenance script layered on top.
This file is the source of truth for **what to run, and in what order**.

All migration files are idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE` /
drop-then-create), so re-running the full list against an existing database is
safe.

## Migration order — apply now (fresh database)

Run these in the Supabase SQL editor, top to bottom:

| # | File | Purpose |
|---|------|---------|
| 1 | `schema.sql` | Base: the 5 core tables — `salespeople`, `weekly_goals`, `activity_entries`, `gold_list_targets`, `gold_list_touches_log`. Includes `salespeople.role`. |
| 2 | `seed.sql` | Test/Alex/Jordan salespeople + the first `weekly_goals` row. |
| 3 | `add_role.sql` | Assigns roles (Corey/Ryan = admin, Tonja = assistant, others = ae). The `ADD COLUMN role` is now redundant with `schema.sql` but harmless. |
| 4 | `salespeople_auth_columns.sql` | Reconciliation: adds `is_admin`, `is_test`, `admin_pin` (drifted columns never previously in a migration) and revokes anon `SELECT` on `admin_pin`. |
| 5 | `business_card_scans.sql` | `business_card_scans` table + Storage bucket + storage policies. |
| 6 | `business_card_scans_phase5.sql` | AI-extraction columns on `business_card_scans`. |
| 7 | `business_card_contacts.sql` | `business_card_contacts`, `business_card_export_batches`, verification/export columns. |
| 8 | `business_card_rls.sql` | Enables RLS on the business-card tables (anon = SELECT only; writes via service role). |

## Staged migrations — DO NOT APPLY YET

These migrations are correct but will **break the running app** if applied
before the matching application code ships. Apply each only once its
precondition is met.

### `weekly_goals_rls.sql` — blocked (was applied prematurely; rolled back)

Enables RLS on `weekly_goals` with no anon policy, so the browser anon key can
no longer read the table. **Several reads/writes still run client-side** and
break the moment this is applied:

- `src/lib/goals.ts` (reads — feeds my-week-card, today-totals-card, daily-entry-form)
- `src/components/admin/totals-card.tsx` (reads)
- `src/components/admin/goals-card.tsx` (reads **and writes** — insert/delete)
- `src/components/admin/maintenance-card.tsx` (reads)

The AE-facing leaderboard reads were already moved to `GET /api/leaderboard`,
but the admin goal-management reads/writes above were not.

**This migration was applied to the database by mistake** before those call
sites were migrated. `weekly_goals_rls_rollback.sql` reverses it (disables RLS
on `weekly_goals` only) and restores the prior anon access posture — run it if
not already run. **Do not re-apply `weekly_goals_rls.sql`** until the call
sites above are moved behind service-role server routes; only then retire the
rollback. Until then `weekly_goals` stays anon-readable/writable — an accepted
gap for the closed 11-person team, tracked as a remaining blocker.

### `business_card_rls_lockdown.sql` — staged

Drops the anon `SELECT` policies on `business_card_scans` /
`business_card_contacts`, so those tables become unreadable from the browser.
**Apply only after the release that adds `GET /api/business-card/verification`
is deployed** — before that release the Verification Center reads those tables
directly with the anon key.

## Maintenance scripts (NOT migrations)

| File | When to run |
|------|-------------|
| `cleanup_business_card_test_data.sql` | On demand — purges scans/contacts flagged `is_test_data = true`. Read its header before running. |

## Authoritative vs. drifted — known issues

- **`schema.sql` is incomplete.** It declares the 5 core tables but **not** the
  later `salespeople` columns (`is_admin`, `is_test`, `admin_pin`) and **no**
  RLS. The authoritative schema is `schema.sql` **plus** the migrations above.
  A database built from `schema.sql` alone will not run the app.
- **`add_role.sql` overlaps `schema.sql`.** Both define `salespeople.role`.
  `add_role.sql`'s column add is a no-op against a current DB; its role-
  assignment statements are still authoritative.
- **`admin_pin` is a plaintext secret.** After migration 4 it is no longer
  readable by the anon key. Set it for admin rows directly in SQL, e.g.
  `UPDATE salespeople SET admin_pin = '1234' WHERE first_name = 'Corey';`

## Auth model & session limitation (read before touching RLS)

The app has **no Supabase Auth**. Reps sign in by name; admins also enter a
PIN. As of Phase 0:

- The PIN is validated server-side by `POST /api/auth/login` (service-role
  key), which issues a signed (HMAC-SHA256) session token. The browser never
  sees `admin_pin`.
- Authenticated API routes verify that token via `src/lib/server/auth.ts`
  (`requireSalesperson` / `requireAdmin` / `requireReviewer` /
  `requireScanAccess`). The role is always re-read from the DB.
- All business-card table writes go through service-role route handlers; the
  anon key has SELECT-only access to those tables (and none, once
  `business_card_rls_lockdown.sql` is applied).

**Known limitation — the session token is bearer-only.** It proves the client
completed a login, but with no real auth backing it, anyone who copies a
token holds that session until it expires (30 days). There is no server-side
revocation. This is intentionally accepted for the closed 11-person internal
team and is strictly stronger than the pre-Phase-0 state (routes had no
identity check at all). **Durable fix:** real per-user Supabase Auth, which
would also let RLS — rather than route handlers — enforce row-level ownership.
Deferred beyond Phase 0.
