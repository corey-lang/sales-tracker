import Anthropic from "@anthropic-ai/sdk";

import type { CoverageAnswer } from "@/lib/coverage/answer-logic";
import { stateLabel } from "@/lib/coverage/answer-logic";

// ---------------------------------------------------------------------------
// Smitty Narrator — Anthropic formatting layer for grounded coverage answers.
//
// Receives already-validated facts from Coverage Intelligence and reformats
// them into AE-friendly prose. This module makes NO coverage decisions; it
// only narrates what the structured DB already confirmed. The narrator never
// receives general model context — only the approved fact packet below.
//
// Security constraints (verbatim from spec):
//   - ANTHROPIC_API_KEY is read from environment variables only; never logged.
//   - No secrets are logged.
//   - Fact validation happens in Coverage Intelligence BEFORE this call.
//   - Never create fake citations.
//   - Never answer from general model knowledge.
//   - Never make up pricing.
//   - Never say something is covered without naming the plan and limit.
//   - If no source is available, say admin verification is needed.
//   - Never infer coverage from blank cells unless explicitly "Not Covered."
//   - Never interpret legal coverage beyond the provided facts.
// ---------------------------------------------------------------------------

export type NarratedAnswer = {
  quickAnswer: string;
  details: string;
  aeNote: string;
};

const NARRATOR_SYSTEM = `You are Smitty, a coverage narrator for Elevate Home Warranty. Your ONLY job is to reformat already-validated coverage facts into AE-friendly language. You are NOT a decision-maker — coverage determination has already been made from the brochure database before you received this packet. You are a narrator only.

ABSOLUTE RULES (violating any of these breaks AE trust):
- Never add any fact not present in the provided coverage packet.
- Never answer from general home warranty knowledge.
- Never invent coverage, exclusions, pricing, or plan names not in the packet.
- Never create or invent citations — use only the source documents provided.
- Never say something is covered without naming the plan and the specific limit given.
- Never infer coverage from a blank or missing value — only state coverage when the structured data explicitly says so.
- Never interpret legal coverage language beyond what the structured facts state.
- Never make up pricing.
- If facts are insufficient for a section, write "Admin verification needed."

OUTPUT: Return ONLY a valid JSON object with exactly three string fields:
{
  "quickAnswer": "<one direct sentence: covered or not covered, which plan, key limit if given>",
  "details": "<2-4 sentences of additional facts from the packet: conditions, caps, exclusions>",
  "aeNote": "<one sentence tip for how the AE can use this in the sales conversation>"
}

No markdown fences, no preamble, no explanation outside the JSON object.`;

/**
 * Guards against a narrator output that semantically contradicts the grounded
 * source answer. Returns false when:
 *   - Original says "not covered / does not cover / no —" but narrator says "yes/covered".
 *   - Original says "covered / yes —" but narrator says "not covered / no".
 *   - Either field is empty (shouldn't happen — caller also checks length).
 * Conservative on purpose: a borderline case returns true (narrator survives).
 */
function isNarratorOutputSafe(
  originalText: string,
  narrated: NarratedAnswer,
): boolean {
  const orig = originalText.toLowerCase();
  const qa = narrated.quickAnswer.toLowerCase();

  const origNotCovered =
    orig.includes("not cover") ||
    orig.includes("does not cover") ||
    /\bno\s*[—–-]/.test(orig);

  const qaSaysCovered =
    /^yes\b/.test(qa) || qa.includes("is covered") || qa.includes("does cover");

  if (origNotCovered && qaSaysCovered) return false;

  const origCovered =
    /^yes\s*[—–-]/.test(orig) ||
    orig.includes("plan covers") ||
    orig.includes("does cover");

  const qaSaysNotCovered =
    /^no\b/.test(qa) && (qa.includes("not cover") || qa.includes("does not"));

  if (origCovered && qaSaysNotCovered) return false;

  return true;
}

/**
 * Calls the Anthropic narrator to reformat a grounded CoverageAnswer into
 * the 4-part AE-friendly shape. Returns null when:
 *   - ANTHROPIC_API_KEY is not set (graceful degradation — template answer shown as-is)
 *   - answer.confidence is "needs_review" (don't let narrator soften guardrail language)
 *   - Anthropic API call fails
 *   - Response JSON is malformed or missing required fields
 *   - Narrator output contradicts the original grounded answer
 *
 * Callers must treat null as "display the template answer" — this is fail-open.
 */
export async function callSmittyNarrator(
  answer: CoverageAnswer,
  question: string,
  stateCode: string,
): Promise<NarratedAnswer | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;

  // Never narrate needs_review answers — the guardrail language must not be softened.
  if (answer.confidence === "needs_review") return null;

  const state = stateLabel(stateCode);

  const sourcesText = answer.citations
    .map((c) => {
      const ver = c.version ? ` v${c.version}` : "";
      const pages = c.pages.length > 0 ? `, pp. ${c.pages.join(", ")}` : "";
      return `- ${c.brochure}${ver}${pages}`;
    })
    .join("\n");

  // Compact fact packet — ONLY what the narrator receives. No system context,
  // no general knowledge, no customer data. Claude sees the brochure facts and
  // nothing else.
  const userContent = [
    `State: ${state}`,
    ``,
    `AE question: ${question}`,
    ``,
    `Coverage facts extracted from ${state} plan documents:`,
    answer.text,
    ``,
    `Source documents:`,
    sourcesText || "(no page numbers recorded)",
  ].join("\n");

  const client = new Anthropic({ apiKey });

  let rawText: string;
  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: NARRATOR_SYSTEM,
      messages: [{ role: "user", content: userContent }],
    });
    const block = msg.content[0];
    if (!block || block.type !== "text") {
      console.warn("[smitty-narrator] unexpected content block type");
      return null;
    }
    rawText = block.text;
  } catch (err) {
    // Log sanitized error — never log raw provider messages that could contain
    // request details or sensitive fragments. Log code/name only.
    const statusSuffix =
      err instanceof Error && "status" in err
        ? `:${(err as { status?: unknown }).status}`
        : "";
    const code = err instanceof Error ? `${err.name}${statusSuffix}` : "unknown";
    console.warn(`[smitty-narrator] API call failed: ${code}`);
    return null;
  }

  try {
    const cleaned = rawText
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const quickAnswer =
      typeof parsed.quickAnswer === "string" ? parsed.quickAnswer.trim() : "";
    const details =
      typeof parsed.details === "string" ? parsed.details.trim() : "";
    const aeNote =
      typeof parsed.aeNote === "string" ? parsed.aeNote.trim() : "";

    if (!quickAnswer || !details || !aeNote) {
      console.warn(
        "[smitty-narrator] narrator JSON missing required fields — falling back to template",
      );
      return null;
    }

    const narrated = { quickAnswer, details, aeNote };

    // Safety check: reject narrator output that contradicts the grounded answer.
    if (!isNarratorOutputSafe(answer.text, narrated)) {
      console.warn(
        "[smitty-narrator] narrator output contradicts grounded answer — falling back to template",
      );
      return null;
    }

    return narrated;
  } catch {
    console.warn(
      "[smitty-narrator] failed to parse narrator JSON output — falling back to template",
    );
    return null;
  }
}
