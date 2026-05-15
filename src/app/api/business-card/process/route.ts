import { getServerSupabase } from "@/lib/supabase/server";
import {
  maybeAutoApproveScan,
  type ContactScan,
} from "@/lib/server/business-card-contacts";

// Phase 5C: server-side AI extraction for a single business_card_scans row.
// POST /api/business-card/process   body: { scanId: string }
//
// Test-account only: rows only land in business_card_scans for the seeded
// Test rep (Phase 3 intake gating), and this handler additionally rejects any
// row where is_test_data is false. No duplicate checking, no CRM export — just
// OCR + structured field extraction into the Phase 5 columns
// (extracted_*, ai_confidence, ai_notes, extraction_status, extracted_at,
// extraction_error).

export const runtime = "nodejs";
// Vision calls can take 10–30s; default 10s is too tight.
export const maxDuration = 60;

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

type ExtractionPayload = {
  raw_ocr_text: string | null;
  extracted_first_name: string | null;
  extracted_last_name: string | null;
  extracted_full_name: string | null;
  extracted_company: string | null;
  extracted_title: string | null;
  extracted_email: string | null;
  extracted_phone: string | null;
  extracted_website: string | null;
  extracted_address: string | null;
  extracted_contact_type: string | null;
  ai_confidence: number | null;
  ai_notes: string | null;
};

const SYSTEM_PROMPT = `You are an OCR and structured-extraction assistant for business cards.

Given a single image of a business card, respond with ONLY a JSON object containing these keys:

{
  "raw_ocr_text": string,             // every readable line from the card, newline-separated
  "extracted_first_name": string|null,
  "extracted_last_name": string|null,
  "extracted_full_name": string|null,
  "extracted_company": string|null,
  "extracted_title": string|null,
  "extracted_email": string|null,
  "extracted_phone": string|null,     // keep as printed; do not invent area codes
  "extracted_website": string|null,
  "extracted_address": string|null,
  "extracted_contact_type": string|null, // e.g. "real estate agent", "loan officer", "title rep", "contractor", "general"
  "ai_confidence": number,            // 0..1, your confidence the structured fields are correct
  "ai_notes": string|null             // anything notable: ambiguity, unreadable text, multiple people on card
}

Every key must be present. Use null when the card does not show that field. Never invent or guess values.`;

function toStr(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalize(raw: Partial<ExtractionPayload>): ExtractionPayload {
  return {
    raw_ocr_text: toStr(raw.raw_ocr_text),
    extracted_first_name: toStr(raw.extracted_first_name),
    extracted_last_name: toStr(raw.extracted_last_name),
    extracted_full_name: toStr(raw.extracted_full_name),
    extracted_company: toStr(raw.extracted_company),
    extracted_title: toStr(raw.extracted_title),
    extracted_email: toStr(raw.extracted_email),
    extracted_phone: toStr(raw.extracted_phone),
    extracted_website: toStr(raw.extracted_website),
    extracted_address: toStr(raw.extracted_address),
    extracted_contact_type: toStr(raw.extracted_contact_type),
    ai_confidence: toNum(raw.ai_confidence),
    ai_notes: toStr(raw.ai_notes),
  };
}

async function callOpenAI(
  imageUrl: string,
  apiKey: string,
): Promise<ExtractionPayload> {
  const model = process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini";
  const res = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract the business card fields from this image.",
            },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
    }),
  });

  // TEMP DIAGNOSTIC: log status (and body on failure) so Vercel shows the
  // real reason OpenAI rejected the call. Remove with the other [bc/process]
  // logs.
  console.log(`[bc/process] OpenAI response status=${res.status} model=${model}`);
  if (!res.ok) {
    const body = await res.text();
    console.error(
      `[bc/process] OpenAI error body (truncated): ${body.slice(0, 500)}`,
    );
    throw new Error(
      `OpenAI request failed (${res.status}): ${body.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI response missing message content");
  }

  let parsed: Partial<ExtractionPayload>;
  try {
    parsed = JSON.parse(content) as Partial<ExtractionPayload>;
  } catch {
    throw new Error("OpenAI returned non-JSON content");
  }
  return normalize(parsed);
}

export async function POST(req: Request) {
  // TEMP DIAGNOSTIC LOGS — remove once production extraction is debugged.
  // Logs only presence/absence and metadata, never secret values.
  const LOG = "[bc/process]";

  let scanId: string | undefined;
  try {
    const body = (await req.json()) as { scanId?: unknown };
    if (typeof body.scanId === "string" && body.scanId.length > 0) {
      scanId = body.scanId;
    }
  } catch {
    console.error(`${LOG} invalid JSON body`);
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!scanId) {
    console.error(`${LOG} missing scanId in request body`);
    return Response.json(
      { error: "Missing scanId in request body" },
      { status: 400 },
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const hasOpenAIKey = Boolean(apiKey);
  const hasServiceRoleKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const hasAnonKey = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const hasSupabaseUrl = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  console.log(
    `${LOG} env scanId=${scanId} hasOpenAIKey=${hasOpenAIKey} hasServiceRoleKey=${hasServiceRoleKey} hasAnonKey=${hasAnonKey} hasSupabaseUrl=${hasSupabaseUrl}`,
  );
  if (!apiKey) {
    console.error(`${LOG} OPENAI_API_KEY missing`);
    return Response.json(
      { error: "OPENAI_API_KEY is not configured on the server" },
      { status: 500 },
    );
  }

  const supabase = getServerSupabase();

  const scanRes = await supabase
    .from("business_card_scans")
    .select("id, image_url, is_test_data")
    .eq("id", scanId)
    .single();

  if (scanRes.error || !scanRes.data) {
    console.error(
      `${LOG} scan lookup failed scanId=${scanId} error=${scanRes.error?.message ?? "no data"}`,
    );
    return Response.json(
      { error: scanRes.error?.message ?? "Scan not found" },
      { status: 404 },
    );
  }

  const scan = scanRes.data;
  console.log(
    `${LOG} scan found scanId=${scanId} hasImageUrl=${Boolean(scan.image_url)} isTestData=${scan.is_test_data}`,
  );
  if (!scan.is_test_data) {
    console.error(`${LOG} scan rejected — is_test_data=false scanId=${scanId}`);
    return Response.json(
      { error: "AI extraction is restricted to test data" },
      { status: 403 },
    );
  }
  if (!scan.image_url) {
    console.error(`${LOG} scan rejected — missing image_url scanId=${scanId}`);
    return Response.json(
      { error: "Scan has no image_url" },
      { status: 422 },
    );
  }

  const procUpd = await supabase
    .from("business_card_scans")
    .update({ extraction_status: "processing", extraction_error: null })
    .eq("id", scanId)
    .select("id");
  if (procUpd.error) {
    console.error(
      `${LOG} mark-processing update failed scanId=${scanId} error=${procUpd.error.message}`,
    );
    return Response.json(
      {
        error: "Failed to mark scan as processing",
        details: procUpd.error.message,
        scanId,
      },
      { status: 500 },
    );
  }
  if (!procUpd.data || procUpd.data.length === 0) {
    console.error(
      `${LOG} mark-processing affected 0 rows scanId=${scanId} (likely RLS or missing row)`,
    );
    return Response.json(
      {
        error:
          "Update affected 0 rows when marking scan as processing — row may be missing or blocked by RLS",
        scanId,
      },
      { status: 500 },
    );
  }

  try {
    console.log(`${LOG} calling OpenAI scanId=${scanId}`);
    const extraction = await callOpenAI(scan.image_url, apiKey);
    console.log(
      `${LOG} OpenAI extraction parsed scanId=${scanId} confidence=${extraction.ai_confidence ?? "null"}`,
    );

    const upd = await supabase
      .from("business_card_scans")
      .update({
        ...extraction,
        extraction_status: "completed",
        extracted_at: new Date().toISOString(),
        extraction_error: null,
      })
      .eq("id", scanId)
      .select();

    if (upd.error) {
      throw new Error(`Supabase update failed: ${upd.error.message}`);
    }
    if (!upd.data || upd.data.length === 0) {
      throw new Error(
        `Supabase update affected 0 rows for scanId ${scanId} — row may have been deleted or blocked by RLS`,
      );
    }
    if (upd.data.length > 1) {
      throw new Error(
        `Supabase update affected ${upd.data.length} rows for scanId ${scanId} — expected exactly 1`,
      );
    }

    const updatedScan = upd.data[0];
    if (updatedScan.extraction_status !== "completed") {
      throw new Error(
        `Updated row has unexpected extraction_status "${updatedScan.extraction_status}" (expected "completed")`,
      );
    }

    console.log(`${LOG} completed scanId=${scanId}`);

    // Build 3: run the safe auto-approval rule now that extraction completed.
    // A failure here must not fail the request — extraction itself succeeded,
    // and the scan simply stays in needs_review for manual verification.
    let autoApproval = null;
    try {
      autoApproval = await maybeAutoApproveScan(
        supabase,
        updatedScan as unknown as ContactScan,
      );
      console.log(
        `${LOG} auto-approval scanId=${scanId} outcome=${autoApproval.outcome}`,
      );
    } catch (autoErr) {
      const autoMsg =
        autoErr instanceof Error ? autoErr.message : "Unknown error";
      console.error(
        `${LOG} auto-approval failed scanId=${scanId} error=${autoMsg}`,
      );
    }

    return Response.json({
      status: "completed",
      scanId,
      extraction,
      scan: updatedScan,
      autoApproval,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `${LOG} extraction failed scanId=${scanId} error=${message}`,
    );
    const failUpd = await supabase
      .from("business_card_scans")
      .update({
        extraction_status: "failed",
        extraction_error: message,
      })
      .eq("id", scanId)
      .select("id");
    if (failUpd.error) {
      console.error(
        `${LOG} write-failed-status update errored scanId=${scanId} error=${failUpd.error.message}`,
      );
    } else if (!failUpd.data || failUpd.data.length === 0) {
      console.error(
        `${LOG} write-failed-status affected 0 rows scanId=${scanId} (likely RLS)`,
      );
    }
    return Response.json(
      { status: "failed", scanId, error: message },
      { status: 500 },
    );
  }
}
