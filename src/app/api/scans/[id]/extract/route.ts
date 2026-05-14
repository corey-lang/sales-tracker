import { getServerSupabase } from "@/lib/supabase/server";

// Phase 5: AI extraction for a single business_card_scans row.
// POST /api/scans/[id]/extract
//
// Test-account only: rows only land in business_card_scans for the seeded
// Test rep (see business-card-scanner.tsx + isTestAccount), and this handler
// additionally rejects any row where is_test_data is false. No duplicate
// checking, no CRM export — just OCR + structured field extraction.

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

  if (!res.ok) {
    const body = await res.text();
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

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return Response.json({ error: "Missing scan id" }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "OPENAI_API_KEY is not configured on the server" },
      { status: 500 },
    );
  }

  const supabase = getServerSupabase();

  const scanRes = await supabase
    .from("business_card_scans")
    .select("id, image_url, is_test_data")
    .eq("id", id)
    .single();

  if (scanRes.error || !scanRes.data) {
    return Response.json(
      { error: scanRes.error?.message ?? "Scan not found" },
      { status: 404 },
    );
  }

  const scan = scanRes.data;
  if (!scan.is_test_data) {
    return Response.json(
      { error: "AI extraction is restricted to test data" },
      { status: 403 },
    );
  }

  await supabase
    .from("business_card_scans")
    .update({ extraction_status: "processing", error_message: null })
    .eq("id", id);

  try {
    const extraction = await callOpenAI(scan.image_url, apiKey);

    const upd = await supabase
      .from("business_card_scans")
      .update({
        ...extraction,
        extraction_status: "completed",
        processed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", id);

    if (upd.error) {
      throw new Error(`Supabase update failed: ${upd.error.message}`);
    }

    return Response.json({ status: "completed", extraction });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await supabase
      .from("business_card_scans")
      .update({
        extraction_status: "failed",
        error_message: message,
        processed_at: new Date().toISOString(),
      })
      .eq("id", id);
    return Response.json(
      { status: "failed", error: message },
      { status: 500 },
    );
  }
}
