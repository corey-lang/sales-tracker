import { z } from "zod";

import {
  AGENT_FIELD_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
  AGENT_NOTES_MAX_LENGTH,
  GOLD_LIST_ACTIVITY_TYPE_KEYS,
  OUTCOME_NOTE_MAX_LENGTH,
} from "@/lib/gold-list";

export const descriptionSchema = z
  .string()
  .trim()
  .min(1, "Activity description is required.")
  .max(500);
/**
 * The OPTIONAL note on a SCHEDULED activity — its plan/purpose. Distinct from
 * the agent's standing `notes` and from the completion `outcome_note`; each has
 * its own column, its own form field and its own schema. Empty string and null
 * both mean "no note" (the routes coerce "" to null before writing).
 */
export const activityNoteSchema = z
  .string()
  .trim()
  .max(2000, "Keep the activity note under 2000 characters.")
  .nullish();
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T12:00:00Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, "Choose a real calendar date.");
export const emailSchema = z
  .union([z.string().trim().max(160).email(), z.literal(""), z.null()])
  .optional();
export const phoneSchema = z
  .string()
  .trim()
  .max(160)
  .refine(
    (value) =>
      !value ||
      (/^\+?[\d\s().-]+$/.test(value) && value.replace(/\D/g, "").length >= 7),
    "Enter a valid phone number.",
  )
  .nullish();

const normalizeName = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .sort()
    .join(" ");
const normalizePhone = (value?: string | null) =>
  (value ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
type Contact = {
  agent_name: string;
  email?: string | null;
  phone?: string | null;
};
export function possibleDuplicate(a: Contact, b: Contact): boolean {
  const email = a.email?.trim().toLowerCase();
  const phone = normalizePhone(a.phone);
  const name = normalizeName(a.agent_name);
  const other = normalizeName(b.agent_name);
  return Boolean(
    (email && email === b.email?.trim().toLowerCase()) ||
    (phone && phone === normalizePhone(b.phone)) ||
    (name &&
      (name === other ||
        (name.length > 5 &&
          other.length > 5 &&
          (name.includes(other) || other.includes(name))))),
  );
}

/**
 * Body of "schedule an activity" — shared by the AE route
 * (POST /api/gold-list/agents/:id/activities) and the manager 1:1 route, so
 * both accept exactly the same fields and limits.
 */
export const createActivitySchema = z.object({
  activity_type: z.enum(GOLD_LIST_ACTIVITY_TYPE_KEYS).default("other"),
  description: descriptionSchema,
  /** OPTIONAL plan note for this touch. Never the completion outcome — that is
   *  written later, to `outcome_note`, by the PATCH route. */
  activity_note: activityNoteSchema,
  request_id: z.string().uuid().optional(),
  /** A yyyy-mm-dd date that also parses to a real calendar date. */
  scheduled_for: dateSchema,
});

/**
 * Body of "complete / reschedule / cancel an activity" — shared by the AE
 * route (PATCH /api/gold-list/agents/:id/activities/:aid) and the manager 1:1
 * route.
 */
export const updateActivitySchema = z.object({
  status: z.enum(["scheduled", "completed", "cancelled"]).optional(),
  /** Optional outcome captured on completion; null clears a previous note. */
  outcome_note: z.string().trim().max(OUTCOME_NOTE_MAX_LENGTH).nullish(),
  /** The scheduled activity's plan note. Editable only while the activity is
   *  still scheduled — the shared writer and the DB's
   *  `protect_gold_list_activity_history` trigger both refuse a finished row,
   *  so a completed activity's note is as immutable as its outcome. */
  activity_note: activityNoteSchema,
  activity_type: z.enum(GOLD_LIST_ACTIVITY_TYPE_KEYS).optional(),
  description: descriptionSchema.optional(),
  scheduled_for: dateSchema.optional(),
});

const optionalAgentField = z.string().trim().max(AGENT_FIELD_MAX_LENGTH).nullish();

/**
 * Body of "add an agent" — shared by the AE route (POST /api/gold-list/agents)
 * and the manager 1:1 route, so both accept exactly the same fields and limits.
 * The owner is never in the body: the AE route uses the caller, the manager
 * route the 1:1's AE.
 */
export const createAgentSchema = z.object({
  confirm_duplicate: z.boolean().default(false),
  request_id: z.string().uuid().optional(),
  agent_name: z
    .string()
    .trim()
    .min(1, "Agent name is required.")
    .max(AGENT_NAME_MAX_LENGTH),
  brokerage: optionalAgentField,
  phone: phoneSchema,
  email: emailSchema,
  notes: z.string().trim().max(AGENT_NOTES_MAX_LENGTH).nullish(),
});

/**
 * Body of "edit an agent". Omitted field = leave as-is; explicit null (or "")
 * = clear it; only `agent_name` cannot be cleared. `archived` exists on the AE
 * route only — the manager 1:1 route uses `managerUpdateAgentSchema`.
 */
export const updateAgentSchema = z.object({
  agent_name: z
    .string()
    .trim()
    .min(1, "Agent name cannot be empty.")
    .max(AGENT_NAME_MAX_LENGTH)
    .optional(),
  brokerage: optionalAgentField,
  phone: phoneSchema,
  email: emailSchema,
  notes: z.string().trim().max(AGENT_NOTES_MAX_LENGTH).nullish(),
  /** true = archive, false = restore. Omit to leave the archive state alone. */
  archived: z.boolean().optional(),
});

/** A manager editing the AE's agent from a 1:1 can change details, not archive. */
export const managerUpdateAgentSchema = updateAgentSchema.omit({ archived: true });
