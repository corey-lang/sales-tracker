import { z } from "zod";

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
