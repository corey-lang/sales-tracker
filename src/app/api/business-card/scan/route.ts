import { getServerSupabase } from "@/lib/supabase/server";
import { isTestAccount } from "@/lib/permissions";

// Server-side intake for a business card scan.
// POST /api/business-card/scan
//   body: { salespersonId: string, imageUrl: string }
//   200:  { scanId: string }
//
// WHY THIS ROUTE EXISTS
//   business_card_scans has RLS enabled in production (see
//   supabase/business_card_rls.sql) and the app has NO Supabase Auth — reps
//   pick a name from a dropdown, so every browser request uses the shared
//   anon key and auth.uid() is NULL. The browser therefore cannot (and must
//   not) insert scan rows directly: that is exactly the
//   "new row violates row-level security policy" error AEs were seeing.
//
//   This route runs with the service-role key, which bypasses RLS. It
//   validates the salesperson against the salespeople table and writes the
//   scan with server-trusted salesperson_id / salesperson_name / is_test_data
//   rather than trusting whatever the browser claimed.

export const runtime = "nodejs";

/** A scan image must live in the business-card-scans storage bucket. */
const IMAGE_URL_MARKER = "/business-card-scans/";

export async function POST(req: Request) {
  let salespersonId: string | undefined;
  let imageUrl: string | undefined;

  try {
    const body = (await req.json()) as {
      salespersonId?: unknown;
      imageUrl?: unknown;
    };
    if (
      typeof body.salespersonId === "string" &&
      body.salespersonId.length > 0
    ) {
      salespersonId = body.salespersonId;
    }
    if (typeof body.imageUrl === "string" && body.imageUrl.length > 0) {
      imageUrl = body.imageUrl;
    }
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!salespersonId) {
    return Response.json(
      { error: "Missing salespersonId in request body" },
      { status: 400 },
    );
  }
  if (!imageUrl) {
    return Response.json(
      { error: "Missing imageUrl in request body" },
      { status: 400 },
    );
  }
  // Only accept an image we just uploaded to our own bucket — never an
  // arbitrary external URL the client may have supplied.
  if (!imageUrl.includes(IMAGE_URL_MARKER)) {
    return Response.json(
      { error: "imageUrl is not a business-card-scans storage URL" },
      { status: 400 },
    );
  }

  const supabase = getServerSupabase();

  // Validate the salesperson. The app login is name-based with no Supabase
  // Auth, so the only identity check available is that the id the client sent
  // corresponds to a real salespeople row. The DB's values (name, role) are
  // then trusted over anything the client claimed.
  const personRes = await supabase
    .from("salespeople")
    .select("id, first_name")
    .eq("id", salespersonId)
    .single();

  if (personRes.error || !personRes.data) {
    return Response.json(
      { error: "Unknown salesperson — cannot save scan" },
      { status: 403 },
    );
  }

  const person = personRes.data;

  const insert = await supabase
    .from("business_card_scans")
    .insert({
      salesperson_id: person.id,
      // Server-trusted: re-read from the DB, not taken from the request body.
      salesperson_name: person.first_name,
      image_url: imageUrl,
      status: "processing",
      // Derived server-side from the DB name (not trusted from the client) so
      // the seeded "Test" account's scans stay cleanly separable from live
      // AE data for the cleanup script.
      is_test_data: isTestAccount(person),
    })
    .select("id")
    .single();

  if (insert.error || !insert.data) {
    return Response.json(
      { error: insert.error?.message ?? "Failed to save scan" },
      { status: 500 },
    );
  }

  return Response.json({ scanId: insert.data.id });
}
