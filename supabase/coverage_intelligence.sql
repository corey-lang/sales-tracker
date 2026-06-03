-- ===========================================================================
-- coverage_intelligence — Elevate brochure registry + extracted coverage data.
-- ===========================================================================
-- WHAT THIS IS
--   The data foundation for the "Coverage & Pricing Expert" AI Assistant. Four
--   append-only tables that hold AUTHORITATIVE, brochure-backed facts so the
--   assistant can answer "Does Epic cover sprinklers?" / "Which plans include
--   pool coverage?" / "Compare Elevated vs Totally Elevated" from structured
--   data instead of AI-generated guesses.
--
--     plan_brochures      — one row per imported brochure VERSION (the registry)
--     plan_coverage_items — per (brochure, plan, coverage item) facts
--     plan_pricing        — per (brochure, plan) price, only when stated
--     plan_addons         — per (brochure, add-on) catalog + price + limits
--     coverage_synonyms   — maps typed terms → canonical brochure terms
--
-- PRIMARY SOURCE OF TRUTH
--   Coverage Intelligence is the PRIMARY answer source for coverage lookups,
--   plan comparisons, limits, add-ons, and brochure-backed pricing. The
--   external AI agent is the FALLBACK, used only when these tables can't answer
--   (no current brochure for the state, plan/item not found, or no approved
--   row). The Coverage Service (src/lib/coverage/) enforces that order.
--
-- REVIEW WORKFLOW / CONFIDENCE / PROVENANCE
--   Every extracted fact row carries: source_page (which brochure page),
--   extraction_method ('manual'|'ai'|'ai_assisted'), extraction_confidence
--   (0..1), and a review lifecycle (review_status pending → approved/rejected/
--   needs_changes, with reviewed_by/reviewed_at). ONLY review_status='approved'
--   rows on a status='current' brochure are served to the AI as authoritative;
--   everything else is review-queue only. This keeps AI-assisted extraction
--   from ever answering before a human approves it.
--
-- VERSIONING / HISTORY (hard requirement)
--   Brochures are APPEND-ONLY. A new version of a state's brochure is a NEW
--   plan_brochures row with its OWN extracted coverage/pricing/add-on rows
--   (all FK'd to that brochure_id). Prior versions are never overwritten or
--   deleted, so historical answers remain reproducible. Exactly one brochure
--   per state may be marked `status='current'` (enforced by a partial UNIQUE
--   index); "mark as current" demotes the prior current row to 'superseded'.
--
-- AUTHORITATIVE-ONLY / NO INFERENCE
--   Every fact row stores BOTH a structured value (e.g. coverage_limit 500) and
--   the raw brochure wording (coverage_limit_text "$500 per service request",
--   source_text = the original line). Pricing is recorded ONLY when explicitly
--   present in the brochure — extraction must never infer a price. `source_text`
--   exists so a human can verify any extracted row against the brochure.
--
-- ACCESS MODEL
--   RLS ENABLED with NO policy on all five tables: the browser anon key has
--   zero access. Reads happen only through the service-role Coverage
--   Intelligence library (src/lib/coverage/*) behind authenticated routes
--   (the AI proxy + the admin "AI Coverage Intelligence" page). Same posture
--   as ae_tasks / cogent_territory_mappings.
--
-- APPEND-ONLY ENFORCEMENT (DB layer, not just convention)
--   * Fact FKs are ON DELETE RESTRICT (a brochure can't be deleted out from
--     under its facts).
--   * No-delete triggers on plan_brochures + all three fact tables — history is
--     never destroyed; correct by superseding with a NEW brochure version.
--   * Brochure identity/source/timeline is immutable after registration:
--     state_code + brochure_title + imported_at + created_at can never change;
--     brochure_version/effective_date/source_url/file_hash are immutable once
--     set (a NULL may be backfilled once). Only status/notes/updated_at change.
--   * Approved facts are frozen: a review_status='approved' row's VALUE columns
--     cannot be UPDATEd (only the review lifecycle / notes), so historical
--     facts can't be silently rewritten.
--   * Triggers fire for EVERY role (BYPASSRLS skips RLS, never triggers), so
--     the service role can't bypass these rules.
--
-- CONSISTENCY / PROMOTION / READS
--   * A fact's denormalized state_code is pinned to its parent brochure by a
--     trigger AND the parent's state_code is immutable, so it can never drift.
--   * coverage_promote_current_brochure(uuid) atomically demotes the prior
--     current brochure for a state and promotes the target. Guardrails: only an
--     'imported' brochure may be promoted ('current' = no-op; failed/archived/
--     superseded rejected). EXECUTE is service-role-only.
--   * The authoritative_* VIEWS expose ONLY (current brochure + approved row)
--     facts; the Coverage Service reads these, so the review gate is enforced
--     by the read surface, not just a code contract.
--
-- STATE-SPECIFIC
--   state_code is carried on every table (denormalized onto the fact tables for
--   fast filtering) because coverage and pricing differ by state. All lookups
--   are scoped by state.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- CREATE OR REPLACE VIEW, DROP TRIGGER IF EXISTS, ENABLE ROW LEVEL SECURITY,
-- and REVOKE are all re-runnable.
-- No seed data — these tables are populated by the extraction pipeline from
-- real, human-verified brochures (see src/lib/coverage/). See
-- supabase/README.md for migration order.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Phase 1 — plan_brochures (the registry).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_brochures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Two-letter USPS state code, stored UPPER (e.g. 'UT','AZ','TX','NV').
  state_code TEXT NOT NULL CHECK (state_code = UPPER(state_code) AND char_length(state_code) = 2),
  brochure_title TEXT NOT NULL,
  -- Free-text version label exactly as the brochure presents it (e.g.
  -- "2025.7"). Free text because Elevate's versioning scheme is not ours to
  -- normalize and varies by state/year.
  brochure_version TEXT,
  -- The brochure's own stated effective date (calendar day, no TZ).
  effective_date DATE,
  -- Where the file came from (public URL or internal storage path).
  source_url TEXT,
  -- SHA-256 of the source file. Dedupes accidental re-imports of an identical
  -- file for a state (see the UNIQUE index below). OPTIONAL at the SCHEMA level
  -- for now (Phase 1 registers metadata only and does not fetch the file).
  -- PHASE 2 EXPECTATION: the ingestion/fetch flow MUST always populate file_hash
  -- whenever it actually has the bytes (i.e. it fetched/parsed the file), so an
  -- extracted brochure is provably tied to the exact source it came from. It is
  -- backfillable exactly once (the identity-freeze trigger allows NULL→value but
  -- blocks any later change). TODO: make this column NOT NULL once the
  -- fetch/hashing pipeline is the only ingestion path.
  file_hash TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Lifecycle:
  --   imported   — registered, extraction may be pending/in-progress
  --   current    — the authoritative brochure for its state (at most one)
  --   superseded — a prior version, kept for history
  --   archived   — withdrawn / not for use
  --   failed     — import or extraction failed; do not read from it
  status TEXT NOT NULL DEFAULT 'imported'
    CHECK (status IN ('imported','current','superseded','archived','failed')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One CURRENT brochure per state. Partial UNIQUE — only 'current' rows are
-- constrained, so any number of 'superseded'/'archived' history rows coexist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_brochures_current_per_state
  ON plan_brochures(state_code)
  WHERE status = 'current';

-- Dedupe identical re-imports of the same file for a state (NULL hashes are
-- not constrained, so a not-yet-hashed import is allowed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_brochures_state_filehash
  ON plan_brochures(state_code, file_hash)
  WHERE file_hash IS NOT NULL;

-- Hot path: list/browse brochures for a state, newest first.
CREATE INDEX IF NOT EXISTS idx_plan_brochures_state
  ON plan_brochures(state_code, effective_date DESC NULLS LAST, imported_at DESC);

-- ---------------------------------------------------------------------------
-- Phase 2 — plan_coverage_items (per plan, per coverage item).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_coverage_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE RESTRICT: facts must never disappear because a brochure row was
  -- touched. Combined with the no-delete triggers below, history is immutable.
  brochure_id UUID NOT NULL REFERENCES plan_brochures(id) ON DELETE RESTRICT,
  -- Denormalized from the brochure for fast state-scoped filtering.
  state_code TEXT NOT NULL CHECK (state_code = UPPER(state_code) AND char_length(state_code) = 2),
  -- Brochure plan name VERBATIM (e.g. "Epic", "Elevated", "Totally Elevated").
  plan_name TEXT NOT NULL,
  -- Coverage line VERBATIM (e.g. "Sprinkler System & Timers", "HVAC").
  coverage_item TEXT NOT NULL,
  -- TRUE = included, FALSE = explicitly not included, NULL = brochure unclear
  -- (don't guess — leave NULL and let the service say "not specified").
  included BOOLEAN,
  -- Structured numeric limit when the brochure states one (e.g. 500). NULL when
  -- there is no numeric limit or it isn't expressed as a single number.
  coverage_limit NUMERIC,
  -- The limit EXACTLY as written (e.g. "$500 per service request",
  -- "Up to $2,000 per term"). Source of truth for display.
  coverage_limit_text TEXT,
  -- The raw brochure line this row was extracted from — for human verification
  -- and to preserve wording the structured fields can't capture.
  source_text TEXT,
  -- Provenance: 1-based brochure PAGE this fact was extracted from.
  source_page INTEGER,
  -- Extraction provenance + review workflow. Only `review_status='approved'`
  -- rows are served to the AI as authoritative; pending/needs_changes/rejected
  -- rows are visible in the admin review queue but never answered from.
  extraction_method TEXT CHECK (extraction_method IN ('manual','ai','ai_assisted')),
  extraction_confidence NUMERIC CHECK (extraction_confidence >= 0 AND extraction_confidence <= 1),
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','approved','rejected','needs_changes')),
  reviewed_by UUID REFERENCES salespeople(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (brochure, plan, coverage item). Supports ON CONFLICT upsert when
-- re-running extraction for the same brochure. Case/whitespace normalization is
-- the extractor's responsibility before insert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_coverage_items_brochure_plan_item
  ON plan_coverage_items(brochure_id, plan_name, coverage_item);

-- Lookup: "does <plan> cover <item> in <state>?" and plan comparisons.
CREATE INDEX IF NOT EXISTS idx_plan_coverage_items_state_plan
  ON plan_coverage_items(state_code, plan_name);
-- Lookup: "which plans include <item> in <state>?"
CREATE INDEX IF NOT EXISTS idx_plan_coverage_items_state_item
  ON plan_coverage_items(state_code, coverage_item);
CREATE INDEX IF NOT EXISTS idx_plan_coverage_items_brochure
  ON plan_coverage_items(brochure_id);
-- Admin review queue: rows not yet approved.
CREATE INDEX IF NOT EXISTS idx_plan_coverage_items_review
  ON plan_coverage_items(review_status)
  WHERE review_status <> 'approved';

-- ---------------------------------------------------------------------------
-- Phase 3 — plan_pricing (per plan; only when the brochure states a price).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_pricing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE RESTRICT: facts must never disappear because a brochure row was
  -- touched. Combined with the no-delete triggers below, history is immutable.
  brochure_id UUID NOT NULL REFERENCES plan_brochures(id) ON DELETE RESTRICT,
  state_code TEXT NOT NULL CHECK (state_code = UPPER(state_code) AND char_length(state_code) = 2),
  plan_name TEXT NOT NULL,
  -- Structured price when clearly present. NEVER inferred.
  price_amount NUMERIC,
  -- Billing cadence the amount applies to (e.g. annual / monthly / per_term).
  price_cadence TEXT CHECK (price_cadence IN (
    'one_time','monthly','quarterly','semi_annual','annual','per_term',
    'per_service_request','other'
  )),
  -- ISO 4217 currency, defaults USD; explicit so multi-currency markets work.
  currency_code TEXT NOT NULL DEFAULT 'USD'
    CHECK (currency_code = UPPER(currency_code) AND char_length(currency_code) = 3),
  -- Price EXACTLY as written (e.g. "$600 / year", "$55/mo for 12 months").
  price_text TEXT,
  source_text TEXT,
  source_page INTEGER,
  extraction_method TEXT CHECK (extraction_method IN ('manual','ai','ai_assisted')),
  extraction_confidence NUMERIC CHECK (extraction_confidence >= 0 AND extraction_confidence <= 1),
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','approved','rejected','needs_changes')),
  reviewed_by UUID REFERENCES salespeople(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_pricing_brochure_plan
  ON plan_pricing(brochure_id, plan_name);
CREATE INDEX IF NOT EXISTS idx_plan_pricing_state_plan
  ON plan_pricing(state_code, plan_name);
CREATE INDEX IF NOT EXISTS idx_plan_pricing_brochure
  ON plan_pricing(brochure_id);
CREATE INDEX IF NOT EXISTS idx_plan_pricing_review
  ON plan_pricing(review_status)
  WHERE review_status <> 'approved';

-- ---------------------------------------------------------------------------
-- Phase 4 — plan_addons (add-on catalog: inclusion, availability, price, limit).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_addons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE RESTRICT: facts must never disappear because a brochure row was
  -- touched. Combined with the no-delete triggers below, history is immutable.
  brochure_id UUID NOT NULL REFERENCES plan_brochures(id) ON DELETE RESTRICT,
  state_code TEXT NOT NULL CHECK (state_code = UPPER(state_code) AND char_length(state_code) = 2),
  -- e.g. "Sprinkler Coverage", "Pool Coverage", "Spa Coverage", "Well Pump",
  -- "Septic", "Guest House".
  addon_name TEXT NOT NULL,
  -- Optional: the plan this row is scoped to, when the brochure expresses the
  -- add-on per plan. NULL = applies across plans / catalog-level. Lets us
  -- answer "which plans include pool coverage?" without forcing a plan.
  plan_name TEXT,
  -- TRUE = already part of the (scoped) plan; FALSE = not included.
  included_in_plan BOOLEAN,
  -- TRUE = can be purchased as an optional add-on.
  available_as_addon BOOLEAN,
  -- Structured add-on price when stated. NEVER inferred. Same structured shape
  -- as plan_pricing (amount + cadence + currency) plus the raw text.
  addon_price_amount NUMERIC,
  addon_price_cadence TEXT CHECK (addon_price_cadence IN (
    'one_time','monthly','quarterly','semi_annual','annual','per_term',
    'per_service_request','other'
  )),
  currency_code TEXT NOT NULL DEFAULT 'USD'
    CHECK (currency_code = UPPER(currency_code) AND char_length(currency_code) = 3),
  addon_price_text TEXT,
  coverage_limit NUMERIC,
  coverage_limit_text TEXT,
  source_text TEXT,
  source_page INTEGER,
  extraction_method TEXT CHECK (extraction_method IN ('manual','ai','ai_assisted')),
  extraction_confidence NUMERIC CHECK (extraction_confidence >= 0 AND extraction_confidence <= 1),
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','approved','rejected','needs_changes')),
  reviewed_by UUID REFERENCES salespeople(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (brochure, add-on, plan-scope). COALESCE(plan_name,'') so the
-- catalog-level (NULL plan) row and per-plan rows don't collide and upserts are
-- deterministic.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_addons_brochure_addon_plan
  ON plan_addons(brochure_id, addon_name, COALESCE(plan_name, ''));
CREATE INDEX IF NOT EXISTS idx_plan_addons_state
  ON plan_addons(state_code, addon_name);
CREATE INDEX IF NOT EXISTS idx_plan_addons_brochure
  ON plan_addons(brochure_id);
CREATE INDEX IF NOT EXISTS idx_plan_addons_review
  ON plan_addons(review_status)
  WHERE review_status <> 'approved';

-- ---------------------------------------------------------------------------
-- coverage_synonyms — maps the words AEs/agents actually type to the canonical
-- brochure terms, so "sprinklers" resolves to "Sprinkler System & Timers" and
-- "TE" resolves to "Totally Elevated". Without this the service can only
-- exact/normalized-match and would miss common phrasings.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coverage_synonyms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = applies to all states; a code scopes the synonym to one state when
  -- terminology differs by market.
  state_code TEXT CHECK (state_code IS NULL OR (state_code = UPPER(state_code) AND char_length(state_code) = 2)),
  -- What kind of canonical term this maps to.
  canonical_type TEXT NOT NULL CHECK (canonical_type IN ('coverage_item','plan','addon')),
  -- The term as typed, stored normalized. CHECK enforces lower+trim at the DB
  -- so lookups (which lower/trim the user's term) always match.
  synonym TEXT NOT NULL CHECK (synonym = lower(btrim(synonym)) AND char_length(synonym) > 0),
  -- The exact brochure term it resolves to (matches plan_name / coverage_item /
  -- addon_name verbatim).
  canonical_value TEXT NOT NULL,
  -- Synonyms are curated/reviewed, never auto-guessed at answer time.
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One mapping per (state-scope, type, synonym). COALESCE so a global (NULL
-- state) row and a state-specific row don't collide and upserts are stable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_coverage_synonyms_scope_type_synonym
  ON coverage_synonyms(COALESCE(state_code, ''), canonical_type, synonym);
CREATE INDEX IF NOT EXISTS idx_coverage_synonyms_lookup
  ON coverage_synonyms(canonical_type, synonym);

-- ---------------------------------------------------------------------------
-- updated_at maintenance. One small self-contained trigger per table (the
-- project has no shared trigger — see CLAUDE.md), mirroring ae_tasks.sql /
-- cogent_territory_mappings.sql.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_coverage_intelligence_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_brochures_updated_at ON plan_brochures;
CREATE TRIGGER trg_plan_brochures_updated_at
  BEFORE UPDATE ON plan_brochures
  FOR EACH ROW EXECUTE FUNCTION set_coverage_intelligence_updated_at();

DROP TRIGGER IF EXISTS trg_plan_coverage_items_updated_at ON plan_coverage_items;
CREATE TRIGGER trg_plan_coverage_items_updated_at
  BEFORE UPDATE ON plan_coverage_items
  FOR EACH ROW EXECUTE FUNCTION set_coverage_intelligence_updated_at();

DROP TRIGGER IF EXISTS trg_plan_pricing_updated_at ON plan_pricing;
CREATE TRIGGER trg_plan_pricing_updated_at
  BEFORE UPDATE ON plan_pricing
  FOR EACH ROW EXECUTE FUNCTION set_coverage_intelligence_updated_at();

DROP TRIGGER IF EXISTS trg_plan_addons_updated_at ON plan_addons;
CREATE TRIGGER trg_plan_addons_updated_at
  BEFORE UPDATE ON plan_addons
  FOR EACH ROW EXECUTE FUNCTION set_coverage_intelligence_updated_at();

DROP TRIGGER IF EXISTS trg_coverage_synonyms_updated_at ON coverage_synonyms;
CREATE TRIGGER trg_coverage_synonyms_updated_at
  BEFORE UPDATE ON coverage_synonyms
  FOR EACH ROW EXECUTE FUNCTION set_coverage_intelligence_updated_at();

-- ---------------------------------------------------------------------------
-- Server-only access: RLS on, NO policy. Service-role routes bypass RLS; the
-- anon key is fully locked out. No client reads these tables directly.
-- ---------------------------------------------------------------------------
ALTER TABLE plan_brochures      ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_coverage_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_pricing        ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_addons         ENABLE ROW LEVEL SECURITY;
ALTER TABLE coverage_synonyms   ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- INTEGRITY ENFORCEMENT (append-only history is preserved at the DB layer).
-- ===========================================================================
-- Triggers run for ALL roles, including the service role (BYPASSRLS only skips
-- RLS, never triggers), so these rules cannot be sidestepped by the app.

-- ---------------------------------------------------------------------------
-- (A) No deletes. plan_brochures and every fact table are append-only — a
-- correction is a NEW brochure version, never a delete. RESTRICT FKs already
-- stop a brochure delete while facts reference it; this stops deletes outright.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coverage_block_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Deletes are not allowed on % — Coverage Intelligence is append-only; supersede with a new brochure version instead.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_brochures_no_delete ON plan_brochures;
CREATE TRIGGER trg_plan_brochures_no_delete
  BEFORE DELETE ON plan_brochures
  FOR EACH ROW EXECUTE FUNCTION coverage_block_delete();

DROP TRIGGER IF EXISTS trg_plan_coverage_items_no_delete ON plan_coverage_items;
CREATE TRIGGER trg_plan_coverage_items_no_delete
  BEFORE DELETE ON plan_coverage_items
  FOR EACH ROW EXECUTE FUNCTION coverage_block_delete();

DROP TRIGGER IF EXISTS trg_plan_pricing_no_delete ON plan_pricing;
CREATE TRIGGER trg_plan_pricing_no_delete
  BEFORE DELETE ON plan_pricing
  FOR EACH ROW EXECUTE FUNCTION coverage_block_delete();

DROP TRIGGER IF EXISTS trg_plan_addons_no_delete ON plan_addons;
CREATE TRIGGER trg_plan_addons_no_delete
  BEFORE DELETE ON plan_addons
  FOR EACH ROW EXECUTE FUNCTION coverage_block_delete();

-- ---------------------------------------------------------------------------
-- (A2) Brochure identity/source/timeline is immutable after registration. A
-- registered brochure's identity (state_code, brochure_title), source
-- (brochure_version, effective_date, source_url, file_hash), and timeline
-- (imported_at, created_at) cannot be silently rewritten — only lifecycle/admin
-- fields (status, notes, updated_at) may change.
--
-- state_code + brochure_title are NOT NULL, so they are FULLY immutable — this
-- is also what stops parent→child state_code drift (a fact's state_code is
-- pinned to the brochure at insert and the brochure's can never change).
-- imported_at + created_at are set once at insert and FULLY immutable too, so
-- the audit timeline of when a brochure entered the registry can't be altered.
--
-- The nullable source fields use "immutable ONCE SET": a NULL may be backfilled
-- exactly once (e.g. the future fetch pipeline computes file_hash, or extraction
-- parses brochure_version/effective_date), but a value already present can never
-- be changed. That preserves "no silent rewriting of source" while still
-- allowing the one-time backfill those fields were designed for.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coverage_freeze_brochure_identity()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.state_code IS DISTINCT FROM OLD.state_code
     OR NEW.brochure_title IS DISTINCT FROM OLD.brochure_title
     -- Timeline fields are set once at insert and never editable thereafter.
     OR NEW.imported_at IS DISTINCT FROM OLD.imported_at
     OR NEW.created_at  IS DISTINCT FROM OLD.created_at
     OR (OLD.brochure_version IS NOT NULL AND NEW.brochure_version IS DISTINCT FROM OLD.brochure_version)
     OR (OLD.effective_date  IS NOT NULL AND NEW.effective_date  IS DISTINCT FROM OLD.effective_date)
     OR (OLD.source_url       IS NOT NULL AND NEW.source_url       IS DISTINCT FROM OLD.source_url)
     OR (OLD.file_hash        IS NOT NULL AND NEW.file_hash        IS DISTINCT FROM OLD.file_hash)
  THEN
    RAISE EXCEPTION
      'Brochure identity/source/timeline is immutable after registration (id %); only status/notes may change (nullable source fields may be backfilled once).',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_brochures_freeze_identity ON plan_brochures;
CREATE TRIGGER trg_plan_brochures_freeze_identity
  BEFORE UPDATE ON plan_brochures
  FOR EACH ROW EXECUTE FUNCTION coverage_freeze_brochure_identity();

-- ---------------------------------------------------------------------------
-- (B) Approved facts are immutable except review/audit metadata. Once a fact
-- row is review_status='approved', its VALUE columns are frozen so an approved
-- historical fact can never be silently rewritten. The only permitted changes
-- are the review lifecycle columns (review_status / reviewed_by / reviewed_at),
-- `notes`, and `updated_at` — e.g. to RETRACT approval (→ needs_changes), which
-- is an auditable state change, not a fact rewrite. After retraction the row is
-- editable again (it is no longer approved). Comparisons use IS DISTINCT FROM
-- (null-safe). One function per table because the protected column set differs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coverage_freeze_approved_coverage_item()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.review_status = 'approved' AND (
       NEW.brochure_id           IS DISTINCT FROM OLD.brochure_id
    OR NEW.state_code            IS DISTINCT FROM OLD.state_code
    OR NEW.plan_name             IS DISTINCT FROM OLD.plan_name
    OR NEW.coverage_item         IS DISTINCT FROM OLD.coverage_item
    OR NEW.included              IS DISTINCT FROM OLD.included
    OR NEW.coverage_limit        IS DISTINCT FROM OLD.coverage_limit
    OR NEW.coverage_limit_text   IS DISTINCT FROM OLD.coverage_limit_text
    OR NEW.source_text           IS DISTINCT FROM OLD.source_text
    OR NEW.source_page           IS DISTINCT FROM OLD.source_page
    OR NEW.extraction_method     IS DISTINCT FROM OLD.extraction_method
    OR NEW.extraction_confidence IS DISTINCT FROM OLD.extraction_confidence
  ) THEN
    RAISE EXCEPTION
      'Approved coverage fact %.% is immutable; retract approval (review_status) before editing values.',
      OLD.id, OLD.coverage_item
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_coverage_items_freeze ON plan_coverage_items;
CREATE TRIGGER trg_plan_coverage_items_freeze
  BEFORE UPDATE ON plan_coverage_items
  FOR EACH ROW EXECUTE FUNCTION coverage_freeze_approved_coverage_item();

CREATE OR REPLACE FUNCTION coverage_freeze_approved_pricing()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.review_status = 'approved' AND (
       NEW.brochure_id           IS DISTINCT FROM OLD.brochure_id
    OR NEW.state_code            IS DISTINCT FROM OLD.state_code
    OR NEW.plan_name             IS DISTINCT FROM OLD.plan_name
    OR NEW.price_amount          IS DISTINCT FROM OLD.price_amount
    OR NEW.price_cadence         IS DISTINCT FROM OLD.price_cadence
    OR NEW.currency_code         IS DISTINCT FROM OLD.currency_code
    OR NEW.price_text            IS DISTINCT FROM OLD.price_text
    OR NEW.source_text           IS DISTINCT FROM OLD.source_text
    OR NEW.source_page           IS DISTINCT FROM OLD.source_page
    OR NEW.extraction_method     IS DISTINCT FROM OLD.extraction_method
    OR NEW.extraction_confidence IS DISTINCT FROM OLD.extraction_confidence
  ) THEN
    RAISE EXCEPTION
      'Approved pricing fact % is immutable; retract approval (review_status) before editing values.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_pricing_freeze ON plan_pricing;
CREATE TRIGGER trg_plan_pricing_freeze
  BEFORE UPDATE ON plan_pricing
  FOR EACH ROW EXECUTE FUNCTION coverage_freeze_approved_pricing();

CREATE OR REPLACE FUNCTION coverage_freeze_approved_addon()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.review_status = 'approved' AND (
       NEW.brochure_id           IS DISTINCT FROM OLD.brochure_id
    OR NEW.state_code            IS DISTINCT FROM OLD.state_code
    OR NEW.addon_name            IS DISTINCT FROM OLD.addon_name
    OR NEW.plan_name             IS DISTINCT FROM OLD.plan_name
    OR NEW.included_in_plan      IS DISTINCT FROM OLD.included_in_plan
    OR NEW.available_as_addon    IS DISTINCT FROM OLD.available_as_addon
    OR NEW.addon_price_amount    IS DISTINCT FROM OLD.addon_price_amount
    OR NEW.addon_price_cadence   IS DISTINCT FROM OLD.addon_price_cadence
    OR NEW.currency_code         IS DISTINCT FROM OLD.currency_code
    OR NEW.addon_price_text      IS DISTINCT FROM OLD.addon_price_text
    OR NEW.coverage_limit        IS DISTINCT FROM OLD.coverage_limit
    OR NEW.coverage_limit_text   IS DISTINCT FROM OLD.coverage_limit_text
    OR NEW.source_text           IS DISTINCT FROM OLD.source_text
    OR NEW.source_page           IS DISTINCT FROM OLD.source_page
    OR NEW.extraction_method     IS DISTINCT FROM OLD.extraction_method
    OR NEW.extraction_confidence IS DISTINCT FROM OLD.extraction_confidence
  ) THEN
    RAISE EXCEPTION
      'Approved add-on fact % is immutable; retract approval (review_status) before editing values.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_addons_freeze ON plan_addons;
CREATE TRIGGER trg_plan_addons_freeze
  BEFORE UPDATE ON plan_addons
  FOR EACH ROW EXECUTE FUNCTION coverage_freeze_approved_addon();

-- ---------------------------------------------------------------------------
-- (C) Child state_code must equal the parent brochure's state_code. The denorm
-- column is for fast filtering; this guarantees it never drifts from the FK.
-- BEFORE INSERT OR UPDATE on all three fact tables.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coverage_enforce_state_matches_brochure()
RETURNS TRIGGER AS $$
DECLARE
  parent_state TEXT;
BEGIN
  SELECT state_code INTO parent_state FROM plan_brochures WHERE id = NEW.brochure_id;
  IF parent_state IS NULL THEN
    RAISE EXCEPTION 'brochure_id % does not exist', NEW.brochure_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.state_code IS DISTINCT FROM parent_state THEN
    RAISE EXCEPTION
      'state_code (%) must match the brochure''s state_code (%)', NEW.state_code, parent_state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_coverage_items_state ON plan_coverage_items;
CREATE TRIGGER trg_plan_coverage_items_state
  BEFORE INSERT OR UPDATE ON plan_coverage_items
  FOR EACH ROW EXECUTE FUNCTION coverage_enforce_state_matches_brochure();

DROP TRIGGER IF EXISTS trg_plan_pricing_state ON plan_pricing;
CREATE TRIGGER trg_plan_pricing_state
  BEFORE INSERT OR UPDATE ON plan_pricing
  FOR EACH ROW EXECUTE FUNCTION coverage_enforce_state_matches_brochure();

DROP TRIGGER IF EXISTS trg_plan_addons_state ON plan_addons;
CREATE TRIGGER trg_plan_addons_state
  BEFORE INSERT OR UPDATE ON plan_addons
  FOR EACH ROW EXECUTE FUNCTION coverage_enforce_state_matches_brochure();

-- ---------------------------------------------------------------------------
-- (D) Transactional "promote current" RPC. Demotes the state's prior current
-- brochure to 'superseded' and promotes the target to 'current' atomically (one
-- function call = one transaction), so the partial-unique "one current per
-- state" index is never transiently violated. Call via supabase.rpc(...).
--
-- PROMOTION GUARDRAILS (status):
--   * 'imported'   → promote (the normal path: a freshly extracted+reviewed
--                    brochure becomes current).
--   * 'current'    → idempotent no-op (returns the row unchanged).
--   * 'failed' / 'archived' / 'superseded' → REJECTED with a clear message.
--     Re-promoting a superseded version is intentionally NOT supported here; if
--     that's ever wanted it must be a deliberate, separate operation.
--
-- PRIVILEGES: service-role-only. EXECUTE is revoked from PUBLIC/anon/
-- authenticated below and granted only to service_role — the admin route uses
-- the service-role key, so anon/authenticated can never invoke promotion.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coverage_promote_current_brochure(target_id UUID)
RETURNS plan_brochures AS $$
DECLARE
  target_state TEXT;
  target_status TEXT;
  promoted plan_brochures;
BEGIN
  SELECT state_code, status INTO target_state, target_status
    FROM plan_brochures WHERE id = target_id;
  IF target_state IS NULL THEN
    RAISE EXCEPTION 'Brochure % not found', target_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Already current → idempotent no-op.
  IF target_status = 'current' THEN
    SELECT * INTO promoted FROM plan_brochures WHERE id = target_id;
    RETURN promoted;
  END IF;

  -- Only an 'imported' brochure may be promoted.
  IF target_status <> 'imported' THEN
    RAISE EXCEPTION
      'Brochure % has status "%" and cannot be promoted to current; only an imported brochure may be promoted.',
      target_id, target_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Demote the existing current brochure for this state (if any other).
  UPDATE plan_brochures
    SET status = 'superseded'
    WHERE state_code = target_state AND status = 'current' AND id <> target_id;

  -- Promote the target.
  UPDATE plan_brochures
    SET status = 'current'
    WHERE id = target_id
    RETURNING * INTO promoted;

  RETURN promoted;
END;
$$ LANGUAGE plpgsql;

-- Service-role-only execution. REVOKE from PUBLIC removes the default grant
-- every role inherits; the explicit anon/authenticated REVOKE is belt-and-
-- braces; GRANT to service_role keeps the intended admin (service-role key)
-- path working. Re-runnable.
REVOKE ALL ON FUNCTION coverage_promote_current_brochure(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION coverage_promote_current_brochure(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION coverage_promote_current_brochure(UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- (E) AUTHORITATIVE READ VIEWS. The future Coverage Service reads ONLY these,
-- so "serve only current brochure + approved rows" is enforced by the query
-- surface, not just a code contract. security_invoker = on means a caller hits
-- the base-table RLS (anon → zero rows); the service role (BYPASSRLS) sees all.
-- REVOKE from anon/authenticated as belt-and-braces.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW authoritative_plan_coverage_items
  WITH (security_invoker = on) AS
  SELECT ci.*, b.brochure_version, b.effective_date, b.brochure_title
  FROM plan_coverage_items ci
  JOIN plan_brochures b ON b.id = ci.brochure_id
  WHERE b.status = 'current' AND ci.review_status = 'approved';

CREATE OR REPLACE VIEW authoritative_plan_pricing
  WITH (security_invoker = on) AS
  SELECT p.*, b.brochure_version, b.effective_date, b.brochure_title
  FROM plan_pricing p
  JOIN plan_brochures b ON b.id = p.brochure_id
  WHERE b.status = 'current' AND p.review_status = 'approved';

CREATE OR REPLACE VIEW authoritative_plan_addons
  WITH (security_invoker = on) AS
  SELECT a.*, b.brochure_version, b.effective_date, b.brochure_title
  FROM plan_addons a
  JOIN plan_brochures b ON b.id = a.brochure_id
  WHERE b.status = 'current' AND a.review_status = 'approved';

REVOKE ALL ON authoritative_plan_coverage_items FROM anon, authenticated;
REVOKE ALL ON authoritative_plan_pricing        FROM anon, authenticated;
REVOKE ALL ON authoritative_plan_addons         FROM anon, authenticated;
