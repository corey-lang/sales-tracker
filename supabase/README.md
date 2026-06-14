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
| 9 | `ae_tasks.sql` | AE To-Do / Follow-Up tasks table + indexes + `updated_at` trigger. RLS on, no policy — all access via the `/api/tasks/*` service-role routes. |
| 10 | `business_card_crm_hardening.sql` | CRM prep: `storage_path`, `normalized_email`, `normalized_phone`, `raw_extraction_json`, `extraction_model`, `updated_at` (+ trigger) on `business_card_scans`; `storage_path` / `normalized_email` / `normalized_phone` on `business_card_contacts`. Backfills existing rows. **Must be run before deploying the CRM-hardening app code** — that code writes the new columns, and inserts/updates will fail until they exist. Additive and idempotent, so it is safe to run early. |
| 11 | `business_card_phone_contact.sql` | "Scan & Add to Phone Contacts" — adds `notes`, `verified_by_ae_at`, `phone_contact_exported_at`, `contact_save_mode` to `business_card_contacts`. **Must be run before deploying the phone-contact app code** — the `/api/business-card/ae-contact` route writes these columns and inserts will fail until they exist. Additive, idempotent, does not touch the admin flow or CSV export. |
| 12 | `business_card_image_rotation.sql` | Adds `image_rotation_degrees` (INTEGER, default 0) to `business_card_scans` — per-scan display rotation for the Verification Center. **Must be run before deploying the rotation app code** — `/api/business-card/update-rotation` writes this column. Display metadata only; the stored image file is never altered. Additive and idempotent. |
| 13 | `team_messages.sql` | Team announcements / chat message table for the Juice Box. |
| 14 | `team_message_reads.sql` | Per-user read state for team messages. |
| 15 | `juice_box_pass4_conversations.sql` | Juice Box conversation-grouping pass. |
| 16 | `juice_box_pass5_media.sql` | Juice Box media-upload pass. |
| 17 | `juice_box_pass6_push.sql` | Juice Box push-notification subscriptions. |
| 18 | `add_juice_box_only_role.sql` | Adds the `juice_box_only` role to `salespeople.role`. |
| 19 | `manager_one_on_ones.sql` | Manager coaching foundation: `one_on_ones`, `one_on_one_commitments`, `coaching_relationships`, `training_commitments`. Server-only (RLS on, no policies). **Must run before `weekly_focus.sql` and `weekly_focus_v2.sql`** — they extend tables this migration creates. |
| 20 | `weekly_focus.sql` | Evolves the 1:1 model into Weekly Focus: adds `week_start`, `notes_training`, `notes_manager` to `one_on_ones`, backfills, consolidates per-week duplicates, enforces one focus row per `(ae_id, week_start)`. **Depends on `manager_one_on_ones.sql`.** |
| 21 | `weekly_focus_v2.sql` | Weekly Focus durability + privacy hardening: adds commitment `status` lifecycle (open / completed / dropped — replaces hard-delete), `(ae_id, status)` index, `coaching_relationships.archived_at` + normalized dedupe unique index, and splits `notes_manager` off `one_on_ones` into a separate `weekly_focus_private_notes` table so a future AE-facing read can never leak private notes. **Depends on both `manager_one_on_ones.sql` AND `weekly_focus.sql`.** |
| 22 | `weekly_goals_lockdown.sql` | `weekly_goals` lockdown + uniqueness. Consolidates duplicate goal rows per `(scope, effective_from)` (keeps newest), then adds two partial UNIQUE indexes (per-AE + global) so duplicates cannot recur. ENABLEs RLS with an anon `SELECT`-only policy and REVOKEs `INSERT / UPDATE / DELETE` from `anon` + `authenticated` — anon clients can read goal targets (still needed by per-AE dashboard reads) but cannot mutate them. All admin goal writes now flow through service-role routes: `POST /api/admin/goals`, `DELETE /api/admin/goals/[id]`, and `PUT /api/admin/coaching/[ae_id]/next-week-goals`. **Must run after the matching app code ships** (the admin Goals card no longer writes via the anon key). **Replaces the staged `weekly_goals_rls.sql`** — that file should NOT be reapplied. Idempotent. |
| 23 | `add_faith_juice_box_only.sql` | Seeds Faith as `role='juice_box_only'`, mirroring how Travis and Rizz were seeded in migration #18. Single-row INSERT ... ON CONFLICT; no schema changes. Depends on migration #18 (the `juice_box_only` value must already be on `salespeople.role`'s CHECK constraint). |
| 24 | `juice_box_expand_reactions.sql` | Widens the `team_message_reactions.emoji` CHECK constraint to accept four additional emoji (🎉 🚀 🙌 🏆) on top of the nine introduced in migration #15. All historically-allowed emoji remain valid; no row data is touched. Must be kept in lockstep with `ALLOWED_REACTIONS` in `src/lib/team-messages.ts`. Depends on migration #15. Idempotent. |
| 25 | `offices.sql` | Foundation for the upcoming AE office-map feature. Three tables — `offices`, `office_visits`, `office_import_batches` — each carrying an `environment IN ('test','production')` column. Partial UNIQUE on `(salesperson_id, environment, dedupe_key)` so duplicate checks are scoped per-AE per-environment (test data can never collide with production). All three tables RLS-enabled with NO policies — service-role only via `/api/admin/offices/import` (admin-gated, currently hard-rejects anything other than `environment="test"`). No client-side surface yet. Idempotent. |
| 26 | `salespeople_can_import_offices.sql` | Adds `salespeople.can_import_offices BOOLEAN NOT NULL DEFAULT FALSE` — scoped per-user permission for the office import surface. Replaces the prior `is_admin OR role='assistant'` gate so import access is now granted per-row rather than role-wide. Backfills Tonja to `TRUE`; everyone else stays `FALSE`. Admins still bypass the flag entirely (`is_admin || can_import_offices`). Idempotent. |
| 27 | `offices_persistent_notes.sql` | Adds two free-text columns to `offices` for the office memory model: `office_notes TEXT NULL` (long-term reference info — broker name, weekly meeting time, etc.) and `next_action TEXT NULL` (the next-step intent). Both nullable; no backfill (existing offices start blank). Per-visit notes continue to live in `office_visits.note`. Foundation for the future office-detail view — no UI/map yet. Additive and idempotent. |
| 28 | `juice_box_multi_image.sql` | Adds `media_attachments JSONB` to `team_messages` so an image post can carry multiple images. The existing `media_*` columns stay populated with the FIRST attachment so historical single-image posts render unchanged and reply-preview logic (which keys off `media_type`) keeps working. NULL on every pre-migration row and on every text-only / GIF / historical single-image row. Depends on migration #16 (`juice_box_pass5_media.sql`). Additive and idempotent. |
| 29 | `offices_badger_fields.sql` | Adds three nullable columns to `offices` — `office_phone TEXT`, `office_email TEXT`, `external_badger_id TEXT` — so the Office Import surface can persist Badger Maps' `_Phone`, `_Email`, and `_CustomerId` fields. Refreshed on every re-import (factual source-system data). `external_badger_id` is NOT yet part of the dedupe key — promoting it would dedupe-mismatch existing rows; deferred to a future migration. No UNIQUE constraint on `external_badger_id` (Badger occasionally emits duplicates from saved-view exports; a UNIQUE would 23505 those into a confusing error). Depends on migration #25 (`offices.sql`). Additive and idempotent. |
| 30 | `offices_next_action_due_date.sql` | Adds `next_action_due_date DATE NULL` to `offices`. Paired with the existing `next_action TEXT NULL` (migration #27) so the office-detail page can show a follow-up like "Drop donuts next Friday" with an optional calendar-day due date. DATE (not TIMESTAMPTZ) avoids cross-TZ shifting since office follow-ups read as calendar days, not timestamps. "Also add to my AE To-Dos" is a CLIENT-side dual-write — there's no FK from `offices` to `ae_tasks`, so the two systems stay decoupled. Depends on migration #27 (`offices_persistent_notes.sql`). Additive and idempotent. |
| 31 | `ae_tasks_office_link.sql` | Adds `office_id UUID NULL REFERENCES offices(id) ON DELETE SET NULL` to `ae_tasks`, with a partial index `WHERE office_id IS NOT NULL`. Powers the "From office: <name>" back-link in the /todos UI for tasks created from an office Next Action. `ON DELETE SET NULL` so a removed office leaves the AE's task intact (back-link degrades to "(no longer available)" plain text). Manually-created tasks leave the column null and are entirely unaffected. Depends on migrations #9 (`ae_tasks.sql`) and #25 (`offices.sql`). Additive and idempotent. |
| 32 | `offices_nearby_index.sql` | Adds a partial B-tree index `idx_offices_salesperson_env_coords ON offices(salesperson_id, environment, latitude, longitude) WHERE latitude IS NOT NULL AND longitude IS NOT NULL`. Speeds the bounding-box pre-filter in `GET /api/offices/nearby` for AEs whose sandboxes hold thousands of geocoded offices (dense metros). NOT required for correctness — the route's paged candidate fetch already returns the full bbox set — only for latency at scale. Storage cost is trivial (geocoded rows only). Depends on migration #25 (`offices.sql`). Additive and idempotent. |
| 33 | `offices_archived_at.sql` | Adds `archived_at TIMESTAMPTZ NULL` to `offices`. Powers the soft-delete ("Remove this office from your list?") action on the office-detail page. Every office read surface filters `archived_at IS NULL` so archived rows disappear from List, Map, detail, visit logging, and task office-link enrichment — but the underlying `office_visits` and `ae_tasks.office_id` references are preserved so visit history isn't destroyed and task back-links degrade to "(no longer available)" rather than 404. `archived_at` doubles as the timestamp record so no separate boolean is needed. Depends on migration #25 (`offices.sql`). Additive and idempotent. |
| 35 | `working_day_adjustments.sql` | Admin-managed reductions to an AE's available working days for a week (holidays = global, PTO/travel = individual). Creates `working_day_adjustments` with a scope CHECK (`applies_to_all` ⇔ `salesperson_id IS NULL`), a `day_value NUMERIC(2,1)` in (0,1] (1.0 full / 0.5 half — half-day pace math supported, no UI yet), `updated_at` trigger, indexes on date + salesperson, and two partial UNIQUE indexes (one global row per day, one individual row per day+AE). RLS ENABLED with NO policy — fully server-only (mirrors `ae_tasks.sql`); the anon key has zero access (individual PTO rows can carry private notes, so no client reads them directly). All access is via service-role routes that verify the caller: admin management/reports under `/api/admin/*`, and an AE's OWN available-days/pace returned (own row only) by the leaderboard/scorecard helpers. **Does NOT change weekly goals** — only the pace/expected-to-date math (`src/lib/working-days.ts`) reads available days. Depends on `schema.sql` (`salespeople`). No app dependency before deploy — safe to apply anytime. Additive and idempotent. |
| 34 | `cogent_territory_mappings.sql` | Foundation for the upcoming AE Orders tile (Cogent integration). Creates `cogent_territory_mappings` — one row per Cogent `salesTerritoryName`, each mapping to a `salespeople.id`. A table (not a column) because Kennedy owns two territories ("UT Salt Lake" + "UT North"). RLS on, NO policy — read only by the service-role library `src/lib/server/cogent.ts` behind the admin-gated `/api/cogent/orders-summary` route. Seeds the 13 known territory→AE rows (12 via a `DO NOTHING` join-seed + "NV Mesquite" → Heather as a corrective `DO UPDATE` upsert) by joining on `first_name` (CITEXT, case-insensitive); a missing salesperson is silently skipped (no failure) and must be inserted manually once that person exists — see the comment block in the file. `updated_at` trigger + indexes on `salesperson_id` and `active` (the `sales_territory_name` index is provided by its UNIQUE constraint). Depends on `schema.sql` (`salespeople`). No app dependency — safe to apply anytime. Additive and idempotent. |
| 36 | `coverage_intelligence.sql` | Coverage Intelligence foundation for the AI Assistant. Creates five server-only tables — `plan_brochures` (append-only brochure VERSION registry, ≤1 `status='current'` per state via a partial UNIQUE index), `plan_coverage_items`, `plan_pricing` (structured `price_amount`/`price_cadence`/`currency_code` + raw `price_text`), `plan_addons`, and `coverage_synonyms` (typed-term → canonical-term map). Every extracted fact carries provenance (`source_page`, `extraction_method`, `extraction_confidence`) and a review lifecycle (`review_status` pending→approved/rejected/needs_changes, `reviewed_by`/`reviewed_at`); only `review_status='approved'` rows on a `current` brochure are ever served as authoritative. **Append-only at the DB layer:** fact FKs are `ON DELETE RESTRICT`, no-delete triggers block DELETE on the brochure + fact tables, and an approved fact's value columns are frozen (only the review lifecycle/notes may change) so historical facts can't be silently rewritten — triggers fire for every role, so the service role can't bypass them. A trigger forces each fact's `state_code` to match its parent brochure. Brochure promotion is the `coverage_promote_current_brochure(uuid)` RPC (atomic demote-prior + promote-target). The `authoritative_plan_*` VIEWS (`security_invoker=on`, revoked from anon/authenticated) expose only current+approved rows — the Coverage Service reads these, not the base tables. RLS ENABLED with NO policy on all five — fully server-only; read/written through the admin-gated `/api/admin/coverage/*` routes and (later) the AI proxy's Coverage Service (`src/lib/coverage/*`). No seed data — populated only from real, human-verified brochures. Depends on `schema.sql` (`salespeople`, for the `reviewed_by` FK). No app dependency — safe to apply anytime; the AI route does not read these tables yet. Additive and idempotent. |
| 37 | `order_snapshot.sql` | Orders Sync Cron V1 cache. Single-row (`id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id)`) `order_snapshot` table holding the computed month-to-date orders rollup as `payload JSONB` plus `started_at` (this run's start, for the overwrite guard), `refreshed_at` (last SUCCESSFUL refresh) and `duration_ms`. Writes go through the `upsert_order_snapshot(jsonb, timestamptz, timestamptz, integer)` RPC (service-role-only; REVOKEd from public/anon/authenticated), which only overwrites when the new run STARTED at-or-after the stored run — so overlapping cron/manual syncs can't let an older run clobber a newer snapshot. A Vercel cron (`/api/cron/orders-sync`, every 15 min during 7am–11pm MT, CRON_SECRET-required) and the admin manual refresh (`POST /api/admin/cogent/refresh`) run `syncOrders()` to write it; the AE Home Orders card (`/api/me/orders`) and Admin orders screen (`/api/cogent/orders-summary`) READ ONLY (no live Cogent call — never sync on a page load; an empty cache shows an unavailable/empty state until the first sync). RLS ENABLED with NO policy — fully server-only (service role read/write; anon zero access). **Must be applied before the Orders-Sync app code; then run the admin Refresh once to populate it.** `started_at` is added via `ALTER ... ADD COLUMN IF NOT EXISTS`, so re-running after an earlier version is safe. Depends on nothing. Additive and idempotent. |
| 38 | `order_today_baseline.sql` | Orders V1 Today-Orders baseline store. One row per America/Denver calendar date (`baseline_date DATE PRIMARY KEY`) holding the start-of-day month-to-date totals: `company_total INTEGER` + `ae_totals JSONB` (`{ salespersonId: mtdTotal }`) + `territory_totals JSONB` (`{ salesTerritoryName: mtdTotal }`, additive — feeds only the admin By-Territory view's Today), plus `created_at`/`updated_at`. Today Orders are computed as `current MTD − start-of-day baseline` (clamped ≥ 0), per AE and company, because the SalesReport6 same-day slice is unreliable (it returns earlier-dated period buckets) while its MTD aggregate is trusted. `syncOrders()` creates the day's baseline on the FIRST sync via INSERT … ON CONFLICT DO NOTHING (write-once; never overwritten), so Today = 0 at first sync and grows as orders land; a new MT date creates a new row → Today resets to 0. RLS ENABLED with NO policy — server-only (service role read/write; anon zero access), same posture as `order_snapshot.sql` (#37). **Apply before the baseline-delta app code ships**; until present, Today renders as "—" while monthly totals / goal / pace still work. Depends on nothing. Additive and idempotent. |
| 39 | `salespeople_state_code.sql` | Adds `salespeople.state_code TEXT NULL` (CHECK: NULL or a normalized UPPER 2-letter USPS code) — the AE's assigned state, used as **Ask Smitty's** default state context for Coverage Intelligence lookups. `salespeople.location` is free text and `cogent_territory` is a sales-territory label, so neither matches `plan_brochures.state_code` / the `authoritative_*` views; this column does. NULL = no assigned state → Ask Smitty declines coverage questions (never guesses a state). Seeds the Test AE to `'UT'` (change to whichever state's brochure goes `current`+`approved` first); real AEs are assigned later. Read server-side by `requireSalesperson` and the `/api/ai/chat` coverage path. Depends on `schema.sql` (`salespeople`) and migration #4 (`is_test`, for the seed). No app dependency before deploy — safe to apply anytime. Additive and idempotent. |
| 40 | `plan_brochures_trusted.sql` | Adds `plan_brochures.trusted BOOLEAN NOT NULL DEFAULT FALSE` for **Trusted Brochure Mode**. When `TRUE` (opt-in at registration, for official company brochures), the Coverage Intelligence publish flow lowers ONLY the extraction-confidence gate to a 0.50 floor so obvious high/medium-confidence rows auto-approve; every structural gate still applies (must have `source_text`/citation, a `source_page`, pass the citation-consistency check, not be a duplicate, have required plan/price). Non-trusted brochures keep the 0.85 default. The floor is server-owned — a caller-supplied threshold can only RAISE the gate, never lower it below the floor. No new statuses; no backfill (FALSE is the safe default). Read by `analyzeBrochure`/`approveAndPublishBrochure` via `effectiveThreshold`. Depends on migration #36 (`coverage_intelligence.sql`). Additive and idempotent. |
| 41 | `replace_activity_week.sql` | Atomic Sun-Sat activity-week replacement for the AE "Edit activity week" card. Reconciles the drifted `activity_entries.presentations` column (`ADD COLUMN IF NOT EXISTS`), then adds the `replace_activity_week(p_salesperson_id uuid, p_week_start date, p_week_end date, p_values jsonb)` RPC: in ONE transaction it upserts the week total onto the activity week's **Sunday** row and deletes that AE's rows in `(Sunday, Saturday]` (Mon..Sat), so the prior two-call upsert+delete can no longer leave a week double-counted on a partial failure. Validates the window is exactly Sun..Sun+6 and that `p_week_start` is a Sunday. `SECURITY INVOKER` — runs with the caller's privileges (the card calls it with the browser anon key, which already holds the table writes the prior path used); `EXECUTE` granted to `anon`/`authenticated`/`service_role`. Does NOT change activity-week logic, readers, or Mon-Fri target/availability math. **Must be applied before the matching app code ships** — `edit-week-card.tsx` now calls `supabase.rpc("replace_activity_week", …)` and saving will 404 until the function exists. Depends on `schema.sql` (`activity_entries`). Idempotent. |

> **Coaching migration order is strict.** `manager_one_on_ones.sql` → `weekly_focus.sql` → `weekly_focus_v2.sql`. Each later file extends/renames structure the earlier one creates. Skipping or reordering will leave `one_on_ones` / commitments in a half-migrated state that the API code expects to be fully migrated. All three are idempotent and re-runnable.
>
> **Goal migration order.** `weekly_goals_lockdown.sql` is independent of the coaching chain and can be applied any time AFTER the app code that moves admin Goals card writes to `/api/admin/goals*` ships. It supersedes the rolled-back `weekly_goals_rls.sql` and `weekly_goals_rls_rollback.sql`.

## Staged migrations — DO NOT APPLY YET

These migrations are correct but will **break the running app** if applied
before the matching application code ships. Apply each only once its
precondition is met.

### `weekly_goals_rls.sql` — superseded by `weekly_goals_lockdown.sql`

The original lockdown attempt simply enabled RLS with no policies, which
broke every client-side `weekly_goals` read (goals.ts / today-totals-card /
my-week-card / daily-entry-form / admin totals/maintenance/goals cards). It
was rolled back by `weekly_goals_rls_rollback.sql`. **Do not re-apply
`weekly_goals_rls.sql`.** The correct migration is migration #22
(`weekly_goals_lockdown.sql`) in the table above, which keeps anon `SELECT`
working while denying anon writes and moves admin writes behind service-role
routes (`/api/admin/goals*`, `/api/admin/coaching/[ae_id]/next-week-goals`).

### `business_card_rls_lockdown.sql` — staged

Drops the anon `SELECT` policies on `business_card_scans` /
`business_card_contacts`, so those tables become unreadable from the browser.
**Apply only after the release that adds `GET /api/business-card/verification`
is deployed** — before that release the Verification Center reads those tables
directly with the anon key.

## Storage bucket privacy — `business-card-scans` (planned, NOT done)

The `business-card-scans` Storage bucket is currently **public-read** (created
`public = true` in `business_card_scans.sql`, with anon `SELECT` on
`storage.objects`). Any business card image is viewable by anyone holding its
URL — names, emails, phone numbers included.

CRM hardening prepared, but did **not** trigger, the move to a private bucket:

- `business_card_scans.storage_path` now persists the stable object path for
  every scan (and contacts copy it), so image references no longer depend on
  the public URL format.
- `src/lib/supabase/storage.ts` ships `createSignedScanUrl()` — a ready, unused
  helper that mints short-lived signed URLs from a `storage_path`.

To actually make the bucket private later, all of the following must ship
together (none done yet):

1. `UPDATE storage.buckets SET public = false WHERE id = 'business-card-scans';`
   and drop the `business-card-scans anon select` policy.
2. Every place that renders an image by `image_url` (the Verification Center —
   `src/components/verification-center.tsx`) must instead request a signed URL
   via a new service-role route backed by `createSignedScanUrl()`.
3. The AI extraction route (`/api/business-card/process`) passes `image_url` to
   OpenAI; with a private bucket it must pass a freshly signed URL instead.
4. The CSV export currently emits `image_url`; decide whether to emit
   `storage_path` (stable) or a signed URL (expires) for CRM import.

Until then the bucket stays public — an accepted gap for the closed team.

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
