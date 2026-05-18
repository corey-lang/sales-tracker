// DEPRECATED — Phase 5 single-scan extraction route. DO NOT USE.
//
// This route was the original test-account-only extraction endpoint
// (POST /api/scans/[id]/extract). It has been superseded by
// POST /api/business-card/process, which performs the same OCR + structured
// extraction, runs the safe auto-approval rule, and is authorization-guarded.
//
// Nothing in the app calls this path anymore (verified by grep across src/).
// The handler is kept only so the route does not 404 silently if an old
// client or bookmark hits it — instead it returns 410 Gone with a pointer to
// the replacement. It performs NO database writes and NO OpenAI calls.
//
// Safe to delete once we are confident no stale clients reference it.

export const runtime = "nodejs";

const GONE_BODY = {
  error: "This endpoint has been removed.",
  use: "POST /api/business-card/process",
} as const;

export async function POST() {
  return Response.json(GONE_BODY, { status: 410 });
}

export async function GET() {
  return Response.json(GONE_BODY, { status: 410 });
}
