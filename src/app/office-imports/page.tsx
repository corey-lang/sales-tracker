"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Upload,
  AlertTriangle,
  CheckCircle2,
  ArrowLeft,
  XCircle,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { useLivePermissions } from "@/lib/use-live-permissions";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Office Imports (Test) — sandbox tool for CSV office import. Access
// is gated on `is_admin` or the per-user `can_import_offices`
// permission (see migration #26), NOT on role membership.
//
// SANDBOX
//   This page ONLY supports environment="test". The server route hard-
//   rejects production imports for the MVP; the client mirrors that
//   constraint by hard-coding environment="test" on every POST.
//
// ACCESS
//   `is_admin === true` OR `can_import_offices === true` on the
//   salespeople row (see migration #26). Non-flagged users (AEs,
//   juice_box_only, plain assistants without the flag) are redirected.
//   The server route enforces the same gate via `requireOfficeImporter`,
//   so UI and API agree.
//
//   Permission state comes from /api/me/permissions on every mount
//   (via useLivePermissions) — NOT from the login-time session cache.
//   This means an admin granting or revoking `can_import_offices`
//   takes effect on the next page mount without a logout/login cycle.
//   While the live fetch is in flight, the gate fails closed — no
//   page render, no button — so a stale "granted" cache can never
//   flash a button at a user whose permission was revoked.
//
//   The gate is named `canImport` and applied at BOTH the page-level
//   guard AND the Import-button site so the contract is explicit at
//   every call point and the two layers can never drift.
//
// SCOPE
//   No map, no read endpoint, no production import. CSV → preview →
//   POST to /api/admin/offices/import. Everything else is the existing
//   foundation from supabase/offices.sql + that route.
// ---------------------------------------------------------------------------

// Mirror of the canonical office field names accepted by the server route.
type FieldName =
  | "salesperson_id"
  | "salesperson_first_name"
  | "name"
  | "street"
  | "city"
  | "state"
  | "zip"
  | "latitude"
  | "longitude"
  // Badger persistence fields (offices_badger_fields.sql + #27 columns).
  | "office_phone"
  | "office_email"
  | "external_badger_id"
  | "office_notes"
  | "next_action";

/**
 * Header aliases for fuzzy CSV column matching. Lowercase, trimmed
 * comparison. Order within an alias list doesn't matter — the first
 * column to match wins. Unknown headers fall through to the
 * "ignored" bucket in the preview banner so a renamed column doesn't
 * silently drop data without the user seeing it called out.
 *
 * The list covers three shapes of source CSV:
 *   * What an admin types by hand ("Office Name", "Street", "Zip").
 *   * Badger Maps' standard export ("Location Name", "Address Line 1",
 *     "Zip/Postal Code", "Account Owner").
 *   * Badger Maps' UNDERSCORE-PREFIXED export. This is the shape
 *     Badger uses when exporting from a saved view — the underscores
 *     mark fields that came from the location record itself (vs.
 *     derived joins) and show up verbatim in the CSV header row.
 *     The full Badger surface — `_Name`, `_Address`, `_Latitude`,
 *     `_Longitude`, `_Phone`, `_Email`, `_CustomerId`, `_Notes`,
 *     `_FollowUp` — is mapped to schema columns after
 *     offices_badger_fields.sql (migration #29). `_Notes` and
 *     `_FollowUp` are forwarded but the import route only SEEDS them
 *     on first create — re-imports never overwrite AE edits, even
 *     when the CSV column carries a different value.
 *
 * Remaining Badger saved-view columns that don't have a schema home
 * (`Residential?`, `Frequency`, `Contact`, `Brochure Dropoff`,
 * `Import Date`, `_Address Line 2`) live in `ACKNOWLEDGED_HEADERS`
 * below so the preview can show them as "we see this but don't
 * store it yet" rather than dumping them into the generic Ignored
 * list.
 */
const HEADER_ALIASES: Record<FieldName, readonly string[]> = {
  salesperson_id: [
    "salesperson id",
    "salesperson_id",
    "ae id",
    "ae_id",
    "owner id",
    "account owner id",
  ],
  salesperson_first_name: [
    "ae name",
    "ae",
    "salesperson",
    "salesperson name",
    "rep",
    "rep name",
    "first name",
    "first_name",
    // Badger exports the owning user as "Account Owner".
    "account owner",
    "owner",
    "assigned to",
  ],
  name: [
    // Badger's primary location label.
    "location name",
    "office name",
    "office",
    "name",
    "account name",
    "company",
    "company name",
    // Badger saved-view export shape.
    "_name",
  ],
  street: [
    "street",
    "address",
    "street address",
    "full address",
    // Badger uses "Address Line 1" / "Address Line 2"; we consume
    // line 1 as the street and ignore line 2 (rare apartment/suite
    // detail that the dedupe key would normalize away anyway).
    "address line 1",
    "address 1",
    "address1",
    // Badger saved-view export shape. NOTE: `_Address` is the FULL
    // address as one string ("12 Main St, Orem, UT 84057"). We store
    // the whole string in `street` because the schema's `street`
    // column is sized for it (TEXT) and the dedupe key normalizes
    // street + zip — putting the full address in `street` actually
    // makes dedupe MORE stable across exports that have/don't have
    // the city/state split out. The preview banner explains this.
    "_address",
  ],
  city: ["city", "town"],
  state: [
    "state",
    "state/province",
    "state code",
    "province",
    "region",
  ],
  zip: [
    "zip",
    "zip code",
    "zipcode",
    "postal code",
    "zip/postal code",
    "postcode",
  ],
  latitude: ["latitude", "lat", "_latitude"],
  longitude: ["longitude", "lng", "lon", "long", "_longitude"],
  // Badger contact + identity fields. These now have schema homes
  // (offices_badger_fields.sql adds office_phone, office_email,
  // external_badger_id) so they map and import like any other field.
  // Aliases stay narrow on purpose — the spec called out Badger as
  // the only target, and "flexible header detection" is explicitly
  // out of scope.
  office_phone: ["_phone", "phone"],
  office_email: ["_email", "email"],
  external_badger_id: ["_customerid", "_customer id", "customer id"],
  // Notes / next_action — schema columns existed already (#27). The
  // server SEEDS these on first create only and never overwrites
  // them on re-import, so AE edits made through the office-detail
  // UI are preserved.
  office_notes: ["_notes", "notes"],
  next_action: ["_followup", "_follow up", "follow up", "next action"],
};

/**
 * Headers we RECOGNIZE but intentionally do not import into the
 * current schema. Lowercased + trimmed. Shown in the preview banner
 * as "Recognized but not stored yet" so the user knows their column
 * was seen — distinct from genuinely unknown headers which still
 * fall into the "Ignored" group.
 *
 * Why each entry sits here (vs. HEADER_ALIASES):
 *   The remaining Badger saved-view columns (`residential?`,
 *   `frequency`, `contact`, `brochure dropoff`, `import date`,
 *   `_address line 2`) don't map to anything in `offices`. Listing
 *   them keeps the preview banner honest: the user sees we noticed
 *   the column, we just don't have a column to put it in.
 */
const ACKNOWLEDGED_HEADERS: ReadonlySet<string> = new Set([
  "residential?",
  "residential",
  "frequency",
  "contact",
  "brochure dropoff",
  "import date",
  "_address line 2",
]);

const MAX_ROWS = 5_000;
const PREVIEW_LIMIT = 50;
const SOURCE_LABEL = "Badger CSV";

// ---------------------------------------------------------------------------
// CSV parsing (no deps — handles quoted fields, escaped `""`, CRLF, BOM)
// ---------------------------------------------------------------------------

/**
 * Parses CSV text into a header array + body rows. Robust enough for
 * Badger/CRM exports: handles double-quoted fields, escaped `""` inside
 * quoted fields, embedded newlines INSIDE quoted fields (the `\n`
 * branch is only entered when `inQuotes` is false, so a newline that
 * appears between an opening `"` and its closing `"` is appended to
 * the field verbatim), CRLF, and a leading UTF-8 BOM.
 *
 * NOT a full RFC 4180 parser: an opening `"` mid-field (e.g.
 * `foo"bar"`) is treated as a state toggle rather than a literal
 * quote, but Badger / CRM exports never produce that shape.
 *
 * Reports a structural parse error (returned via `error` rather than
 * thrown) when:
 *   * An opening `"` is never closed before end-of-file. Without this
 *     guard the parser would silently swallow the rest of the file
 *     into one giant quoted field and the user would see "0 rows
 *     parsed" with no explanation.
 */
function parseCsv(text: string): {
  headers: string[];
  rows: string[][];
  error: string | null;
} {
  // Strip UTF-8 BOM if present so the first header doesn't gain a "﻿" prefix.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
          continue;
        }
        inQuotes = false;
        continue;
      }
      // Includes `\n` — multi-line quoted fields are preserved here.
      field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      current.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") continue; // CRLF handled by the \n branch
    if (ch === "\n") {
      current.push(field);
      field = "";
      // Skip fully-blank rows so trailing newlines don't create empty rows.
      if (!(current.length === 1 && current[0].length === 0)) {
        rows.push(current);
      }
      current = [];
      continue;
    }
    field += ch;
  }

  // Unclosed quote — the file ended while still inside a quoted field.
  // Surface this loudly so the user knows their CSV is malformed
  // (typically a missing close quote on a row with commas in it).
  // Without this guard the parser would silently emit one row with a
  // giant trailing field and the user would have no idea why the
  // import shape is wrong.
  if (inQuotes) {
    return {
      headers: [],
      rows: [],
      error:
        "CSV has an unclosed quoted field. Check your file for a missing closing quote.",
    };
  }

  // Tail field/row if no trailing newline.
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    if (!(current.length === 1 && current[0].length === 0)) {
      rows.push(current);
    }
  }

  if (rows.length === 0) {
    return { headers: [], rows: [], error: null };
  }
  const headers = rows[0].map((h) => h.trim());
  return { headers, rows: rows.slice(1), error: null };
}

/** Maps each CSV column to its canonical field name, or null if unknown. */
function mapHeaders(headers: string[]): Array<FieldName | null> {
  return headers.map((header) => {
    const lower = header.toLowerCase().trim();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<
      [FieldName, readonly string[]]
    >) {
      if (aliases.includes(lower)) return field;
    }
    return null;
  });
}

/**
 * Per-column classification for the preview banner.
 *
 *   "recognized"   — column maps to a field we actually import.
 *   "acknowledged" — column is a known Badger saved-view field but
 *                    the schema doesn't store it yet (e.g.
 *                    `Residential?`, `Frequency`, `Contact`,
 *                    `Brochure Dropoff`, `Import Date`,
 *                    `_Address Line 2`). Surfaced separately so the
 *                    user sees "we noticed this but didn't save it"
 *                    rather than the same treatment as a typo'd
 *                    header.
 *   "unknown"      — column is truly unrecognized — likely a typo or
 *                    a one-off custom field. Ignored, no destination.
 *
 * Order of precedence matches the order checked above: recognized
 * (HEADER_ALIASES) takes priority over acknowledged so a header that
 * appears in both gets imported, not skipped.
 */
type HeaderClass = "recognized" | "acknowledged" | "unknown";

function classifyHeader(
  header: string,
  mapped: FieldName | null,
): HeaderClass {
  if (mapped) return "recognized";
  const lower = header.toLowerCase().trim();
  if (ACKNOWLEDGED_HEADERS.has(lower)) return "acknowledged";
  return "unknown";
}

type ParsedRow = Partial<Record<FieldName, string>>;

/** Builds a sparse field-keyed object from a CSV row + header map. */
function rowToObject(
  row: string[],
  headerMap: Array<FieldName | null>,
): ParsedRow {
  const obj: ParsedRow = {};
  for (let i = 0; i < headerMap.length; i++) {
    const field = headerMap[i];
    if (!field) continue;
    const raw = row[i];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) obj[field] = trimmed;
  }
  return obj;
}

/**
 * Per-row preview classification. Returns a `blocking` reason (the
 * row will be reported by the server in `skipped[]`) plus a list of
 * non-blocking `warnings` (the row imports but the user should know
 * something was off — e.g. invalid lat/lng silently coerced to NULL).
 *
 * Blocking conditions:
 *   * Row has no recognized data at all (every cell was either empty
 *     OR mapped to an unrecognized column). This catches CSVs whose
 *     headers don't match any alias and would otherwise be silently
 *     dropped before reaching the server.
 *   * Missing office name.
 *   * Missing AE AND no Default AE picker selection.
 *
 * Warning conditions:
 *   * Latitude cell is present but doesn't parse as a finite number.
 *   * Longitude cell is present but doesn't parse as a finite number.
 *     (We intentionally still import the row — see toApiRow — because
 *     coords can be geocoded later and dropping the whole row over a
 *     bad cell would lose useful name/address data.)
 */
type RowChecks = {
  blocking: string | null;
  warnings: string[];
};

function rowChecks(row: ParsedRow, hasDefaultAe: boolean): RowChecks {
  const warnings: string[] = [];
  let blocking: string | null = null;

  // Row has no mapped data at all → CSV headers probably don't match
  // any alias. Surface explicitly so the user can fix headers BEFORE
  // submit instead of seeing a confusing "Missing office name" later.
  const hasAnyMappedField = Object.keys(row).length > 0;
  if (!hasAnyMappedField) {
    blocking =
      "No recognized data — check that the column headers match the accepted names.";
  } else if (!row.name) {
    blocking = "Missing office name";
  } else if (
    !hasDefaultAe &&
    !row.salesperson_id &&
    !row.salesperson_first_name
  ) {
    blocking = "Missing AE — pick a Default AE or add an AE column";
  }

  if (
    row.latitude !== undefined &&
    row.latitude !== "" &&
    !Number.isFinite(Number(row.latitude))
  ) {
    warnings.push(
      `Invalid latitude "${row.latitude}" — coordinate will not be saved.`,
    );
  }
  if (
    row.longitude !== undefined &&
    row.longitude !== "" &&
    !Number.isFinite(Number(row.longitude))
  ) {
    warnings.push(
      `Invalid longitude "${row.longitude}" — coordinate will not be saved.`,
    );
  }

  return { blocking, warnings };
}

/** Shape the route accepts. Numbers are pre-coerced from string here. */
type ApiRow = {
  salesperson_id?: string;
  salesperson_first_name?: string;
  name?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  latitude?: number;
  longitude?: number;
  // Badger persistence fields. office_notes / next_action are
  // forwarded but the server only seeds them on first create
  // (never on update) so AE edits are preserved on re-imports.
  office_phone?: string;
  office_email?: string;
  external_badger_id?: string;
  office_notes?: string;
  next_action?: string;
};

/**
 * Converts a parsed-from-CSV row into the JSON shape the route accepts.
 * NEVER drops the row — even if every cell is unmapped or every field
 * is invalid, the row is sent so the server can report it in
 * `skipped[]` with a clear reason. This is the invariant the four-
 * bucket reconciliation depends on:
 *
 *   created + updated + skipped.length + errors.length === sent.length
 *
 * Invalid lat/lng cells are coerced to NULL on the wire (the row still
 * imports with its other data). The preview surfaces the issue as a
 * row-level warning via `rowChecks` so the user is not blindsided.
 */
function toApiRow(row: ParsedRow): ApiRow {
  const out: ApiRow = {};
  if (row.salesperson_id) out.salesperson_id = row.salesperson_id;
  if (row.salesperson_first_name) {
    out.salesperson_first_name = row.salesperson_first_name;
  }
  if (row.name) out.name = row.name;
  if (row.street) out.street = row.street;
  if (row.city) out.city = row.city;
  if (row.state) out.state = row.state;
  if (row.zip) out.zip = row.zip;
  // Coordinates: a literal "0" is falsy but a valid coordinate
  // (equator / prime meridian), so check for non-empty + finite.
  // Invalid values are reported as warnings via rowChecks; here they
  // simply don't make it into the payload (which is what the user was
  // shown in the preview).
  if (row.latitude !== undefined && row.latitude !== "") {
    const n = Number(row.latitude);
    if (Number.isFinite(n)) out.latitude = n;
  }
  if (row.longitude !== undefined && row.longitude !== "") {
    const n = Number(row.longitude);
    if (Number.isFinite(n)) out.longitude = n;
  }
  // Badger persistence fields. Forwarded verbatim — server-side Zod
  // re-validates length caps, and notes/next_action are seeded by
  // the server only on first create.
  if (row.office_phone) out.office_phone = row.office_phone;
  if (row.office_email) out.office_email = row.office_email;
  if (row.external_badger_id) out.external_badger_id = row.external_badger_id;
  if (row.office_notes) out.office_notes = row.office_notes;
  if (row.next_action) out.next_action = row.next_action;
  return out;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type RowReport = { row: number; reason: string };
type ImportResult = {
  batch_id: string | null;
  source: string;
  environment: string;
  /** Rows that didn't exist before this import. */
  created: number;
  /** Rows that matched an existing office (same AE + dedupe key) and
   *  had their address / coords / source updated in place. */
  updated: number;
  total_rows: number;
  /** Rows the importer intentionally bypassed — validation failures,
   *  AE not resolvable, intra-batch duplicates. Caller-fixable. */
  skipped: RowReport[];
  /** Rows the database rejected — constraint violation, transient
   *  connection failure, etc. Usually retryable. */
  errors: RowReport[];
  warning?: string;
};

/** Lightweight salesperson summary for the Default-AE picker. */
type AePerson = {
  id: string;
  first_name: string;
};

export default function OfficeImportsPage() {
  const router = useRouter();
  const { salesperson, loaded: sessionLoaded } = useSalesperson();
  const { permissions, loaded: permsLoaded } = useLivePermissions();
  useScrollToTop();

  // ---- Auth gate (client-side; server route is the final authority) ------
  // Permission resolution prefers LIVE values from /api/me/permissions
  // so a grant/revoke takes effect on the next mount without a
  // logout/login cycle. If the live fetch fails (network blip, transient
  // 5xx, etc.), we fall back to the cached session's flag so a valid
  // user isn't bounced out of a working surface by a transient error.
  //
  // The fallback is UI-only — every write still goes through
  // `requireOfficeImporter` on the server, which re-reads the live DB
  // row. A user with a stale-granted cached session can SEE the
  // button during an outage but can't actually import if their grant
  // has been revoked: the import POST will return 403.
  //
  // Visibility precedence:
  //   1. permsLoaded === true && permissions !== null
  //        → live succeeded. Use live values verbatim.
  //   2. permsLoaded === true && permissions === null
  //        → live FAILED (network/server). Fall back to cached session
  //          flags so a valid user keeps access during an outage.
  //   3. permsLoaded === false
  //        → live still pending. Wait — no fallback yet — so a slow
  //          fetch can't flash a button at a recently-revoked user.
  //
  // juice_box_only is never granted access regardless of the resolution
  // branch — the role-based redirect below fires first.
  const effectivePermissions =
    permissions ??
    (permsLoaded && salesperson
      ? {
          is_admin: salesperson.is_admin === true,
          role: salesperson.role,
          can_import_offices: salesperson.can_import_offices === true,
        }
      : null);

  const canImport =
    !!effectivePermissions &&
    effectivePermissions.role !== "juice_box_only" &&
    (effectivePermissions.is_admin === true ||
      effectivePermissions.can_import_offices === true);

  // Wait for BOTH the session hydration (so we know who's logged in
  // and can do the role-specific juice_box_only redirect) AND the
  // live permission fetch (success OR error — `permsLoaded` flips
  // true either way) before making any access decision. The fallback
  // above kicks in only after permsLoaded so a slow fetch can't
  // accidentally render via the cached path.
  const accessReady = sessionLoaded && permsLoaded;

  useEffect(() => {
    if (!accessReady) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    // juice_box_only is hard-blocked regardless of cached vs live —
    // role rarely changes at runtime and the cached value is safe to
    // read here for redirect routing.
    if (salesperson.role === "juice_box_only") {
      router.replace("/juice-box");
      return;
    }
    if (!canImport) {
      router.replace("/dashboard");
    }
  }, [accessReady, salesperson, canImport, router]);

  // ---- CSV state ---------------------------------------------------------
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [headerMap, setHeaderMap] = useState<Array<FieldName | null>>([]);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- Default-AE picker -------------------------------------------------
  // Badger exports the offices owned by the logged-in user — there is
  // no per-row "AE Name" column. The picker lets the admin select a
  // single AE to assign EVERY row to, with per-row AE columns (when
  // they exist) taking precedence on the server side. Empty value =
  // no default; the import then requires every row to carry its own
  // AE assignment.
  const [aePeople, setAePeople] = useState<AePerson[] | null>(null);
  const [defaultAeId, setDefaultAeId] = useState<string>("");
  const hasDefaultAe = defaultAeId.length > 0;

  // Pull the AE roster for the picker. The anon key has SELECT on
  // salespeople by default (no RLS on that table), so we can read it
  // directly from the browser — matches the pattern in src/app/page.tsx
  // (the name-picker login screen).
  useEffect(() => {
    let cancelled = false;
    supabase
      .from("salespeople")
      .select("id, first_name")
      .order("first_name", { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          // Picker failure is non-fatal — the user can still import
          // a CSV that carries its own AE column. Surface the error
          // inline only if they try to use the picker (the value
          // stays empty until then).
          console.warn("[office-imports] AE roster fetch failed", error);
          setAePeople([]);
          return;
        }
        setAePeople((data ?? []) as AePerson[]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Import state ------------------------------------------------------
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);

  /**
   * Per-row checks memoized once per (rows, hasDefaultAe) change so
   * the preview table and the stats summary read from the same
   * underlying classification — no chance of the two views getting
   * out of sync.
   */
  const checks = useMemo(
    () => rows.map((r) => rowChecks(r, hasDefaultAe)),
    [rows, hasDefaultAe],
  );

  const stats = useMemo(() => {
    let importable = 0;
    let willSkip = 0;
    let withWarnings = 0;
    for (const c of checks) {
      if (c.blocking) willSkip++;
      else importable++;
      if (c.warnings.length > 0) withWarnings++;
    }
    return {
      total: rows.length,
      importable,
      willSkip,
      withWarnings,
      tooMany: rows.length > MAX_ROWS,
    };
  }, [rows.length, checks]);

  function resetParse() {
    setFileName(null);
    setParseError(null);
    setHeaders([]);
    setHeaderMap([]);
    setRows([]);
    setResult(null);
    setResultError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFile(file: File) {
    setParseError(null);
    setResult(null);
    setResultError(null);
    setFileName(file.name);
    try {
      const text = await file.text();
      const { headers: h, rows: r, error: parserErr } = parseCsv(text);
      if (parserErr) {
        setParseError(parserErr);
        setHeaders([]);
        setHeaderMap([]);
        setRows([]);
        return;
      }
      if (h.length === 0) {
        setParseError("CSV appears empty — no header row found.");
        setHeaders([]);
        setHeaderMap([]);
        setRows([]);
        return;
      }
      const map = mapHeaders(h);
      // INVARIANT: every parsed CSV data row makes it into `rows` and
      // therefore into the import payload. Rows whose cells are all
      // empty or all-unmapped are NOT silently filtered here — they
      // would otherwise disappear from the count without explanation.
      // The preview classifier (rowChecks) flags them with a blocking
      // reason so the user sees them in the preview, and the server
      // reports them in `skipped[]` so the reconciliation
      //   created + updated + skipped + errors === rows.length
      // holds.
      const parsed = r.map((row) => rowToObject(row, map));
      setHeaders(h);
      setHeaderMap(map);
      setRows(parsed);
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : "Failed to read the file.",
      );
      setRows([]);
    }
  }

  async function handleImport() {
    if (importing || rows.length === 0 || stats.tooMany) return;
    setImporting(true);
    setResult(null);
    setResultError(null);
    try {
      // environment is HARD-CODED to "test" — the server also enforces
      // this for the MVP. Sending it explicitly documents the intent.
      // default_salesperson_id is only sent when the picker has a
      // value selected, so an "import from a CSV that already has AE
      // columns" workflow doesn't get a misleading default applied.
      const payload: {
        source: string;
        environment: "test";
        rows: ApiRow[];
        default_salesperson_id?: string;
      } = {
        source: SOURCE_LABEL,
        environment: "test",
        rows: rows.map(toApiRow),
      };
      if (defaultAeId) payload.default_salesperson_id = defaultAeId;

      const res = await apiFetch("/api/admin/offices/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as
        | (ImportResult & { error?: string })
        | null;
      if (!res.ok) {
        setResultError(data?.error ?? `Import failed (${res.status}).`);
        return;
      }
      if (data) setResult(data);
    } catch (err) {
      setResultError(
        err instanceof Error ? err.message : "Import failed unexpectedly.",
      );
    } finally {
      setImporting(false);
    }
  }

  if (!accessReady || !salesperson || !canImport) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  // Header classification banner — helps the admin see which of their
  // CSV columns we'll consume, which we KNOW about but don't store
  // yet (Badger _Phone / _Email / _Notes / etc.), and which are truly
  // unknown. Splitting "acknowledged" out of "ignored" prevents the
  // common Badger export from looking like the user has typos in
  // half their headers.
  const classified = headers.map((h, i) => ({
    header: h,
    cls: classifyHeader(h, headerMap[i]),
  }));
  const recognized = classified.filter((c) => c.cls === "recognized");
  const acknowledged = classified.filter((c) => c.cls === "acknowledged");
  const ignored = classified.filter((c) => c.cls === "unknown");

  return (
    <main className="pwa-safe-top mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Sandbox tool
          </p>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Office Imports{" "}
            <span className="ml-1 align-middle inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-400">
              Test
            </span>
          </h1>
        </div>
        <Link
          // Back-link target uses the same `effectivePermissions` that
          // gated the page render — live admin state when available,
          // cached session as fallback during an outage. Safe to deref
          // since we're past the canImport guard, which requires it
          // to be non-null.
          href={
            effectivePermissions?.is_admin ? "/admin" : "/dashboard"
          }
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back
        </Link>
      </header>

      {/* Sandbox banner — make it obvious this never reaches production. */}
      <div
        role="note"
        className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
      >
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p className="leading-snug">
          This tool imports offices into the <strong>test</strong> sandbox
          only. AEs cannot see these records yet — the map and AE read
          surfaces are not wired up. Production imports are blocked
          server-side.
        </p>
      </div>


      {/* ---- Default AE picker ----
          Badger exports the offices that belong to the logged-in user,
          so its CSVs typically have NO per-row AE column. The picker
          assigns every row in the batch to one AE; per-row AE columns
          (when present in the CSV) take precedence on the server. */}
      <Card>
        <CardHeader>
          <CardTitle>Default AE</CardTitle>
          <CardDescription>
            Used when a CSV row has no AE column. Per-row AE columns
            (when present) take precedence, so it&apos;s safe to leave
            this set for mixed CSVs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <label
            htmlFor="default-ae"
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Assign every row to
          </label>
          <select
            id="default-ae"
            value={defaultAeId}
            onChange={(e) => setDefaultAeId(e.target.value)}
            disabled={aePeople === null || importing}
            className="w-full max-w-sm rounded-md border border-input bg-background/40 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="">
              {aePeople === null
                ? "Loading AEs…"
                : "(none — use AE column from CSV)"}
            </option>
            {(aePeople ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.first_name}
              </option>
            ))}
          </select>
          {aePeople !== null && aePeople.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No AEs found. The CSV must include an AE column for every row.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ---- Upload card ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Upload CSV</CardTitle>
          <CardDescription>
            Required: <strong>Office Name</strong> (also accepted as{" "}
            <em>Location Name</em>, <em>Office</em>,{" "}
            <em>Account Name</em>, <em>Company</em>, or Badger&apos;s{" "}
            <em>_Name</em>). Optional:{" "}
            <em>Address / Street / Address Line 1 / Full Address</em>{" "}
            (or Badger&apos;s <em>_Address</em>, stored as-is when
            city/state/zip aren&apos;t split into their own columns),{" "}
            <em>City</em>, <em>State / State Code / State/Province</em>,{" "}
            <em>Zip / Zip Code / Zip/Postal Code</em>,{" "}
            <em>Latitude</em> (or <em>_Latitude</em>),{" "}
            <em>Longitude</em> (or <em>_Longitude</em>). AE column accepted
            as <em>AE Name / Salesperson / Account Owner</em>, or{" "}
            <em>Salesperson ID / Owner ID</em>.
            <br />
            <strong>Badger</strong> saved-view exports import directly:
            <em> _Name</em>, <em>_Address</em>, <em>_Latitude</em>,{" "}
            <em>_Longitude</em>, <em>_Phone</em>, <em>_Email</em>,{" "}
            <em>_CustomerId</em>, <em>_Notes</em>, <em>_FollowUp</em>
            {" "}all land in the office row. Other Badger columns
            (<em>Residential?</em>, <em>Frequency</em>,{" "}
            <em>Contact</em>, <em>Brochure Dropoff</em>,{" "}
            <em>Import Date</em>) are recognized but not stored yet;
            the preview banner calls them out so nothing disappears
            silently.
            <br />
            Re-importing the same office updates address, coordinates,
            phone, email, and external id in place. <em>_Notes</em> and{" "}
            <em>_FollowUp</em> are seeded only on first create — AE
            edits made later through the office UI are preserved on
            every re-import.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Upload aria-hidden="true" className="size-4" />
              Choose CSV…
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                }}
              />
            </label>
            {fileName && (
              <span className="truncate text-sm text-muted-foreground">
                {fileName}
              </span>
            )}
            {(fileName || rows.length > 0) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={resetParse}
                disabled={importing}
              >
                Clear
              </Button>
            )}
          </div>
          {parseError && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {parseError}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ---- Preview card ---- */}
      {rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>
              {stats.total} row{stats.total === 1 ? "" : "s"} parsed
              {" · "}
              <span className="font-medium text-foreground">
                {stats.importable} importable
              </span>
              {stats.willSkip > 0 && (
                <>
                  {" · "}
                  <span className="font-medium text-amber-600 dark:text-amber-400">
                    {stats.willSkip} will be skipped
                  </span>
                </>
              )}
              {stats.withWarnings > 0 && (
                <>
                  {" · "}
                  <span className="font-medium text-amber-600 dark:text-amber-400">
                    {stats.withWarnings} with warnings
                  </span>
                </>
              )}
              {stats.total > PREVIEW_LIMIT && (
                <> · showing first {PREVIEW_LIMIT}</>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {stats.tooMany && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                CSV has {stats.total} rows — the import API caps at {MAX_ROWS}.
                Split the file and try again.
              </p>
            )}

            {(recognized.length > 0 ||
              acknowledged.length > 0 ||
              ignored.length > 0) && (
              <div className="space-y-1 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {recognized.length > 0 && (
                  <p>
                    <span className="font-medium text-foreground">
                      Recognized:
                    </span>{" "}
                    {recognized.map((c) => c.header).join(", ")}
                  </p>
                )}
                {acknowledged.length > 0 && (
                  <p>
                    <span className="font-medium text-foreground">
                      Recognized but not stored yet:
                    </span>{" "}
                    {acknowledged.map((c) => c.header).join(", ")}
                    {" — "}
                    these Badger columns are known to the importer but
                    the schema doesn&apos;t have a place for them yet.
                  </p>
                )}
                {ignored.length > 0 && (
                  <p>
                    <span className="font-medium text-foreground">
                      Ignored (unknown):
                    </span>{" "}
                    {ignored.map((c) => c.header).join(", ")}
                  </p>
                )}
              </div>
            )}

            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/40">
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-1.5 font-semibold">#</th>
                    <th className="px-2 py-1.5 font-semibold">AE</th>
                    <th className="px-2 py-1.5 font-semibold">Office</th>
                    <th className="px-2 py-1.5 font-semibold">Address</th>
                    <th className="px-2 py-1.5 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, PREVIEW_LIMIT).map((r, i) => {
                    const c = checks[i] ?? {
                      blocking: null,
                      warnings: [],
                    };
                    const address = [r.street, r.city, r.state, r.zip]
                      .filter(Boolean)
                      .join(", ");
                    return (
                      <tr
                        key={i}
                        className="border-t border-border/60 last:border-b"
                      >
                        <td className="px-2 py-1.5 tabular-nums text-muted-foreground">
                          {i + 1}
                        </td>
                        <td className="px-2 py-1.5">
                          {r.salesperson_id ?? r.salesperson_first_name ?? (
                            <span className="text-muted-foreground/70">—</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {r.name ?? (
                            <span className="text-muted-foreground/70">—</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {address || (
                            <span className="text-muted-foreground/70">—</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {/* Blocking takes the lead chip; warnings
                              stack underneath so the user sees both
                              reasons on rows that fail multiple checks.
                              "OK" only appears when both are clear. */}
                          <div className="flex flex-col gap-0.5">
                            {c.blocking ? (
                              <span className="inline-flex items-start gap-1 text-amber-600 dark:text-amber-400">
                                <AlertTriangle
                                  aria-hidden="true"
                                  className="mt-0.5 size-3 shrink-0"
                                />
                                <span>Will be skipped: {c.blocking}</span>
                              </span>
                            ) : c.warnings.length === 0 ? (
                              <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                                <CheckCircle2
                                  aria-hidden="true"
                                  className="size-3"
                                />
                                OK
                              </span>
                            ) : null}
                            {c.warnings.map((w, wi) => (
                              <span
                                key={wi}
                                className="inline-flex items-start gap-1 text-amber-600 dark:text-amber-400"
                              >
                                <AlertTriangle
                                  aria-hidden="true"
                                  className="mt-0.5 size-3 shrink-0"
                                />
                                <span>{w}</span>
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {stats.total > PREVIEW_LIMIT && (
              <p className="text-xs text-muted-foreground">
                … and {stats.total - PREVIEW_LIMIT} more row
                {stats.total - PREVIEW_LIMIT === 1 ? "" : "s"} not shown
                in preview. Every parsed row is sent to the server and
                accounted for in the result summary — nothing is
                silently dropped on the client.
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <p className="text-xs text-muted-foreground">
                Source label: <code className="font-mono">{SOURCE_LABEL}</code>
                {" · "}Environment: <code className="font-mono">test</code>
              </p>
              {/* Explicit `canImport` gate. Mirrors the server's
                  `requireOfficeImporter` so the button is visible
                  for exactly the same callers the API will accept.
                  Redundant with the page-level guard above today
                  (anyone who fails canImport is redirected before
                  this card renders), but kept here so the UI gate
                  is impossible to miss in a future refactor. */}
              {canImport ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={handleImport}
                  disabled={
                    importing || rows.length === 0 || stats.tooMany
                  }
                >
                  {importing
                    ? "Importing…"
                    : `Import ${stats.total} row${stats.total === 1 ? "" : "s"}`}
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Importing requires the office-import permission.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---- Result card ---- */}
      {(result || resultError) && (
        <Card>
          <CardHeader>
            <CardTitle>Import result</CardTitle>
            {result && (
              <CardDescription>
                Batch <code className="font-mono">{result.batch_id ?? "—"}</code>
                {" · "}
                {result.total_rows} row{result.total_rows === 1 ? "" : "s"} in CSV
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {resultError && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {resultError}
              </p>
            )}
            {result?.warning && (
              <p
                role="alert"
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
              >
                {result.warning}
              </p>
            )}
            {result && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <SummaryStat
                  label="Created"
                  value={result.created}
                  tone="success"
                />
                <SummaryStat
                  label="Updated"
                  value={result.updated}
                  tone="info"
                />
                <SummaryStat
                  label="Skipped"
                  value={result.skipped.length}
                  tone="warning"
                />
                <SummaryStat
                  label="Errors"
                  value={result.errors.length}
                  tone={result.errors.length > 0 ? "destructive" : "muted"}
                />
              </div>
            )}
            {/*
              Reconciliation guard. The four-bucket invariant is
              `created + updated + skipped + errors === total_rows`.
              If those don't add up, surface it loudly so a silent
              accounting gap can't ever go unnoticed — the import is
              still authoritative for the rows it touched, but the
              admin needs to know a row went unreported.
            */}
            {result &&
              result.created +
                result.updated +
                result.skipped.length +
                result.errors.length !==
                result.total_rows && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  Row accounting mismatch: server reported{" "}
                  {result.created +
                    result.updated +
                    result.skipped.length +
                    result.errors.length}{" "}
                  of {result.total_rows} sent rows. This shouldn&apos;t
                  happen — please report it.
                </p>
              )}
            {result && result.errors.length > 0 && (
              <ResultRowsTable
                title="Errors (database rejected these rows)"
                tone="destructive"
                rows={result.errors}
              />
            )}
            {result && result.skipped.length > 0 && (
              <ResultRowsTable
                title="Skipped (caller-fixable)"
                tone="warning"
                rows={result.skipped}
              />
            )}
            {result &&
              result.skipped.length === 0 &&
              result.errors.length === 0 &&
              result.created + result.updated > 0 && (
                <p className="inline-flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
                  <CheckCircle2 aria-hidden="true" className="size-4" />
                  All rows imported cleanly.
                </p>
              )}
          </CardContent>
        </Card>
      )}
    </main>
  );
}

/**
 * One number-pill in the four-bucket summary header. Tone drives the
 * background/border color so the four pills read at a glance as
 * created (green) / updated (blue) / skipped (amber) / errors
 * (red — unless zero, in which case neutral).
 */
function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "info" | "warning" | "destructive" | "muted";
}) {
  const toneClass =
    tone === "success"
      ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
      : tone === "info"
        ? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
        : tone === "warning"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : tone === "destructive"
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "border-border bg-muted/30 text-muted-foreground";
  return (
    <div className={`rounded-md border px-3 py-2 ${toneClass}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-80">
        {label}
      </p>
      <p className="text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

/** Shared per-row reasons table for the Skipped / Errors lists. */
function ResultRowsTable({
  title,
  tone,
  rows,
}: {
  title: string;
  tone: "warning" | "destructive";
  rows: RowReport[];
}) {
  const Icon = tone === "destructive" ? XCircle : AlertTriangle;
  const headingClass =
    tone === "destructive"
      ? "text-destructive"
      : "text-amber-600 dark:text-amber-400";
  return (
    <div>
      <p
        className={`mb-1 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${headingClass}`}
      >
        <Icon aria-hidden="true" className="size-3.5" />
        {title} ({rows.length})
      </p>
      <div className="max-h-64 overflow-y-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/40">
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-1.5 font-semibold">Row</th>
              <th className="px-2 py-1.5 font-semibold">Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr
                key={i}
                className="border-t border-border/60 last:border-b"
              >
                <td className="px-2 py-1.5 tabular-nums text-muted-foreground">
                  {s.row}
                </td>
                <td className="px-2 py-1.5">{s.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
