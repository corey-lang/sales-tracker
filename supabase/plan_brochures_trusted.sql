-- ===========================================================================
-- plan_brochures.trusted — "Trusted Brochure Mode" for Coverage Intelligence.
--
-- WHY
--   Official company brochures are clean, authoritative source documents. For
--   them we want high-confidence extracted rows to AUTO-APPROVE so an operator
--   isn't forced to hand-approve dozens of obvious rows before Ask Smitty is
--   useful. `trusted = TRUE` lowers ONLY the extraction-confidence gate (to a
--   0.50 floor in code); every structural safety gate still applies — a row is
--   only auto-published when it has a citation (source_text), passes the
--   citation-consistency check, isn't a duplicate, and has its required
--   plan/price. Low-confidence/OCR-garbage, citation mismatches, and missing
--   fields still hold as pending exceptions.
--
--   Opt-in per upload (NOT automatic by source host) — set at registration.
--
-- SHAPE
--   Boolean, NOT NULL DEFAULT FALSE, so every existing/non-trusted brochure
--   keeps the stricter default threshold. Not part of the identity-freeze set,
--   so it can be set at registration (and toggled later if ever needed).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run. Additive; no backfill
-- needed (FALSE is the safe default).
-- ===========================================================================

ALTER TABLE plan_brochures
  ADD COLUMN IF NOT EXISTS trusted BOOLEAN NOT NULL DEFAULT FALSE;
