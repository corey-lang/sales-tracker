"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Upload, AlertTriangle, CheckCircle2, ArrowLeft } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Office Imports (Test) — admin/assistant sandbox tool for CSV office import.
//
// SANDBOX
//   This page ONLY supports environment="test". The server route hard-
//   rejects production imports for the MVP; the client mirrors that
//   constraint by hard-coding environment="test" on every POST.
//
// ACCESS
//   is_admin OR role === "assistant". AEs and juice_box_only are
//   redirected. The server route enforces the same gate via
//   `requireAdminOrAssistant`, so the UI and API agree — an assistant
//   who reaches the page can actually import.
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
  | "longitude";

/**
 * Header aliases for fuzzy CSV column matching. Lowercase, trimmed
 * comparison. Order within an alias list doesn't matter — the first
 * column to match wins. Unknown headers are simply ignored, so a CSV
 * with extra columns ("Notes", "Owner ID") doesn't break the import.
 */
const HEADER_ALIASES: Record<FieldName, readonly string[]> = {
  salesperson_id: ["salesperson id", "salesperson_id", "ae id", "ae_id"],
  salesperson_first_name: [
    "ae name",
    "ae",
    "salesperson",
    "salesperson name",
    "rep",
    "rep name",
    "first name",
    "first_name",
  ],
  name: ["office name", "office", "name"],
  street: ["street", "address", "street address"],
  city: ["city"],
  state: ["state"],
  zip: ["zip", "zip code", "zipcode", "postal code"],
  latitude: ["latitude", "lat"],
  longitude: ["longitude", "lng", "lon", "long"],
};

const MAX_ROWS = 5_000;
const PREVIEW_LIMIT = 50;
const SOURCE_LABEL = "Badger CSV";

// ---------------------------------------------------------------------------
// CSV parsing (no deps — handles quoted fields, escaped `""`, CRLF, BOM)
// ---------------------------------------------------------------------------

/**
 * Parses CSV text into a header array + body rows. Robust enough for
 * Badger/CRM exports: handles double-quoted fields, escaped `""` inside
 * quoted fields, CRLF, and a leading UTF-8 BOM. Doesn't try to be a
 * full RFC 4180 parser (no multi-line quoted fields with embedded
 * newlines — rare in office CSVs and not worth the complexity).
 */
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
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
  // Tail field/row if no trailing newline.
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    if (!(current.length === 1 && current[0].length === 0)) {
      rows.push(current);
    }
  }

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  return { headers, rows: rows.slice(1) };
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

/** Per-row preview validation. Returns null when OK. */
function rowWarning(row: ParsedRow): string | null {
  if (!row.name) return "Missing office name";
  if (!row.salesperson_id && !row.salesperson_first_name) {
    return "Missing AE name / Salesperson ID";
  }
  return null;
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
};

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
  if (row.latitude) {
    const n = Number(row.latitude);
    if (Number.isFinite(n)) out.latitude = n;
  }
  if (row.longitude) {
    const n = Number(row.longitude);
    if (Number.isFinite(n)) out.longitude = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type ImportSkip = { row: number; reason: string };
type ImportResult = {
  batch_id: string | null;
  source: string;
  environment: string;
  inserted: number;
  total_rows: number;
  skipped: ImportSkip[];
  warning?: string;
};

export default function OfficeImportsPage() {
  const router = useRouter();
  const { salesperson, loaded } = useSalesperson();
  useScrollToTop();

  // ---- Auth gate (client-side; server route enforces independently) ------
  const allowed =
    !!salesperson &&
    (salesperson.is_admin === true || salesperson.role === "assistant");

  useEffect(() => {
    if (!loaded) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    if (salesperson.role === "juice_box_only") {
      router.replace("/juice-box");
      return;
    }
    if (!allowed) {
      router.replace("/dashboard");
    }
  }, [loaded, salesperson, allowed, router]);

  // ---- CSV state ---------------------------------------------------------
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [headerMap, setHeaderMap] = useState<Array<FieldName | null>>([]);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- Import state ------------------------------------------------------
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);

  const stats = useMemo(() => {
    let importable = 0;
    let warnings = 0;
    for (const r of rows) {
      if (rowWarning(r)) warnings++;
      else importable++;
    }
    return {
      total: rows.length,
      importable,
      warnings,
      tooMany: rows.length > MAX_ROWS,
    };
  }, [rows]);

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
      const { headers: h, rows: r } = parseCsv(text);
      if (h.length === 0) {
        setParseError("CSV appears empty — no header row found.");
        setHeaders([]);
        setHeaderMap([]);
        setRows([]);
        return;
      }
      const map = mapHeaders(h);
      const parsed = r
        .map((row) => rowToObject(row, map))
        .filter((row) => Object.keys(row).length > 0);
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
      const payload = {
        source: SOURCE_LABEL,
        environment: "test" as const,
        rows: rows.map(toApiRow),
      };
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

  if (!loaded || !salesperson || !allowed) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  // Recognized columns banner — helps the admin see which of their CSV
  // columns we'll consume vs ignore. Unrecognized columns are listed
  // explicitly so a misspelled header doesn't silently drop a field.
  const recognized = headers
    .map((h, i) => ({ header: h, field: headerMap[i] }))
    .filter((c) => c.field !== null);
  const ignored = headers
    .map((h, i) => ({ header: h, field: headerMap[i] }))
    .filter((c) => c.field === null);

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
          href={salesperson.is_admin ? "/admin" : "/dashboard"}
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

      {/* ---- Upload card ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Upload CSV</CardTitle>
          <CardDescription>
            Required columns: <strong>AE Name</strong> (or{" "}
            <strong>Salesperson ID</strong>) and <strong>Office Name</strong>.
            Optional: Street, City, State, Zip, Latitude, Longitude. Unknown
            columns are ignored.
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
              {stats.warnings > 0 && (
                <>
                  {" · "}
                  <span className="font-medium text-amber-600 dark:text-amber-400">
                    {stats.warnings} with warnings
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

            {(recognized.length > 0 || ignored.length > 0) && (
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {recognized.length > 0 && (
                  <p>
                    <span className="font-medium text-foreground">
                      Recognized:
                    </span>{" "}
                    {recognized.map((c) => c.header).join(", ")}
                  </p>
                )}
                {ignored.length > 0 && (
                  <p className="mt-1">
                    <span className="font-medium text-foreground">
                      Ignored:
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
                    const warning = rowWarning(r);
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
                          {warning ? (
                            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                              <AlertTriangle
                                aria-hidden="true"
                                className="size-3"
                              />
                              {warning}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                              <CheckCircle2
                                aria-hidden="true"
                                className="size-3"
                              />
                              OK
                            </span>
                          )}
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
                {stats.total - PREVIEW_LIMIT === 1 ? "" : "s"} not shown in
                preview. All rows will be sent to the server — the server
                returns full per-row results in the import summary.
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <p className="text-xs text-muted-foreground">
                Source label: <code className="font-mono">{SOURCE_LABEL}</code>
                {" · "}Environment: <code className="font-mono">test</code>
              </p>
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
                <span className="font-medium text-foreground">
                  {result.inserted} inserted
                </span>
                {" · "}
                {result.skipped.length} skipped of {result.total_rows} total
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
            {result && result.skipped.length > 0 && (
              <div>
                <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                  Skipped rows
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
                      {result.skipped.map((s, i) => (
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
            )}
            {result && result.skipped.length === 0 && result.inserted > 0 && (
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
