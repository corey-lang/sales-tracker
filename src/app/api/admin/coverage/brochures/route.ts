import { z } from "zod";

import {
  badRequest,
  handleApiError,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import { listBrochures, registerBrochure } from "@/lib/coverage/brochures";
import type { BrochureStatus } from "@/lib/coverage/types";
import { validateBrochureUrlSync } from "@/lib/coverage/url-safety";

// /api/admin/coverage/brochures — Coverage Intelligence brochure registry.
//
//   POST  → register a brochure VERSION (metadata only; no fetch/extraction).
//   GET   → list brochures, optional ?state=UT and ?status=imported filters.
//
// Admin-only. The plan_brochures table is RLS-locked (server-only); all access
// flows through these service-role routes. This is Phase 1 — registering where
// a brochure came from and its version. Extraction of coverage/pricing rows is
// a later phase and is NOT performed here.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BROCHURE_STATUSES: BrochureStatus[] = [
  "imported",
  "current",
  "superseded",
  "archived",
  "failed",
];

const RegisterSchema = z.object({
  // 2-letter USPS code; uppercased so it satisfies the DB CHECK regardless of
  // input casing.
  stateCode: z
    .string()
    .trim()
    .length(2, "stateCode must be a 2-letter code.")
    .transform((s) => s.toUpperCase()),
  brochureTitle: z.string().trim().min(1).max(200),
  brochureVersion: z.string().trim().min(1).max(60).optional(),
  effectiveDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "effectiveDate must be YYYY-MM-DD.")
    .optional(),
  sourceUrl: z.string().trim().url("sourceUrl must be a valid URL.").max(2000).optional(),
  fileHash: z.string().trim().min(8).max(128).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export async function POST(req: Request) {
  try {
    await requireAdmin(req);
    const body = await parseBody(req, RegisterSchema);
    // Enforce the SSRF host allowlist (https + trusted host) at registration
    // for fast feedback; the fetch path re-validates with DNS/IP checks.
    if (body.sourceUrl) validateBrochureUrlSync(body.sourceUrl);
    const brochure = await registerBrochure(body);
    return Response.json({ brochure }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function GET(req: Request) {
  try {
    await requireAdmin(req);

    const url = new URL(req.url);
    const stateParam = url.searchParams.get("state");
    const statusParam = url.searchParams.get("status");

    let stateCode: string | undefined;
    if (stateParam) {
      stateCode = stateParam.trim().toUpperCase();
      if (stateCode.length !== 2) {
        throw badRequest("state must be a 2-letter code.");
      }
    }

    let status: BrochureStatus | undefined;
    if (statusParam) {
      if (!BROCHURE_STATUSES.includes(statusParam as BrochureStatus)) {
        throw badRequest("Invalid status filter.");
      }
      status = statusParam as BrochureStatus;
    }

    const brochures = await listBrochures({ stateCode, status });
    return Response.json({ brochures });
  } catch (err) {
    return handleApiError(err);
  }
}
