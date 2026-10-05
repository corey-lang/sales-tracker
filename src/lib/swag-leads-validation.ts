import { z } from "zod";

import { todayInAppTimezone } from "@/lib/dates";
import { dateSchema } from "@/lib/gold-list-validation";
import {
  SWAG_LEAD_CONTACT_MAX,
  SWAG_LEAD_COUNT_MAX,
  SWAG_LEAD_FOLLOW_UP_MAX,
  SWAG_LEAD_NAME_MAX,
  SWAG_LEAD_NOTES_MAX,
  SWAG_LEAD_REASON_MAX,
} from "@/lib/swag-leads";

// Request validation for the Swag Leads routes. The database re-checks the same
// rules (CHECK constraints + the write functions); this layer exists to give a
// readable 400 before a write is attempted.

function todayIso(): string {
  const d = todayInAppTimezone();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A real calendar date that is not in the future (Denver calendar). */
const pastDate = dateSchema.refine((v) => v <= todayIso(), "That date is in the future.");

const count = (max: number) => z.number().int("Use a whole number.").min(0, "Can't be negative.").max(max);

const name = z.string().trim().min(1, "A lead needs a name.").max(SWAG_LEAD_NAME_MAX);
const contact = z.string().max(SWAG_LEAD_CONTACT_MAX).nullable();
const notes = z.string().max(SWAG_LEAD_NOTES_MAX).nullable();

/** Every editable spreadsheet field (name + date received are management-only edits). */
const fields = {
  name,
  contact_info: contact,
  confirmed_realtor: z.boolean(),
  transactions_last_12_months: count(SWAG_LEAD_COUNT_MAX).nullable(),
  date_lead_received: pastDate,
  date_first_contact: pastDate.nullable(),
  follow_up_attempts: count(SWAG_LEAD_FOLLOW_UP_MAX),
  swag_delivered: z.boolean(),
  met_in_person: z.boolean(),
  orders_received: z.boolean(),
  orders_count: count(SWAG_LEAD_COUNT_MAX).nullable(),
  notes,
};

type Consistency = {
  date_lead_received?: string | null;
  date_first_contact?: string | null;
  orders_received?: boolean;
  orders_count?: number | null;
};

function addConsistencyIssues(v: Consistency, ctx: z.RefinementCtx, today = todayIso()) {
  const received = v.date_lead_received ?? today;
  if (v.date_first_contact && v.date_first_contact < received) {
    ctx.addIssue({
      code: "custom",
      path: ["date_first_contact"],
      message: "First contact can't be before the lead was received.",
    });
  }
  if (v.orders_count && v.orders_count > 0 && v.orders_received === false) {
    ctx.addIssue({
      code: "custom",
      path: ["orders_count"],
      message: "Orders can't be counted when 'Any orders received?' is No.",
    });
  }
}

export const createLeadSchema = z
  .object({
    name: fields.name,
    contact_info: fields.contact_info.optional(),
    confirmed_realtor: fields.confirmed_realtor.optional(),
    transactions_last_12_months: fields.transactions_last_12_months.optional(),
    date_lead_received: fields.date_lead_received.optional(),
    date_first_contact: fields.date_first_contact.optional(),
    follow_up_attempts: fields.follow_up_attempts.optional(),
    swag_delivered: fields.swag_delivered.optional(),
    met_in_person: fields.met_in_person.optional(),
    orders_received: fields.orders_received.optional(),
    orders_count: fields.orders_count.optional(),
    notes: fields.notes.optional(),
    /** Owner: an AE id, or ooa=true. An AE's own creates ignore/forbid others. */
    assigned_to: z.string().uuid().optional(),
    ooa: z.boolean().optional(),
    /** Idempotency key: a double-tapped Save replays instead of duplicating. */
    request_id: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((v, ctx) => addConsistencyIssues(v, ctx));

export const updateLeadSchema = z
  .object({
    expected_revision: z.number().int().min(0),
    patch: z
      .object({
        name: fields.name.optional(),
        contact_info: fields.contact_info.optional(),
        confirmed_realtor: fields.confirmed_realtor.optional(),
        transactions_last_12_months: fields.transactions_last_12_months.optional(),
        date_lead_received: fields.date_lead_received.optional(),
        date_first_contact: fields.date_first_contact.optional(),
        follow_up_attempts: fields.follow_up_attempts.optional(),
        swag_delivered: fields.swag_delivered.optional(),
        met_in_person: fields.met_in_person.optional(),
        orders_received: fields.orders_received.optional(),
        orders_count: fields.orders_count.optional(),
        notes: fields.notes.optional(),
      })
      .strict()
      .refine((p) => Object.keys(p).length > 0, "Nothing to update.")
      .superRefine((p, ctx) =>
        // Only the dates present in THIS patch can be cross-checked here; the
        // database checks the merged row.
        addConsistencyIssues(
          { ...p, date_lead_received: p.date_lead_received ?? undefined },
          ctx,
          "0000-01-01",
        ),
      ),
  })
  .strict();

export const transferSchema = z
  .object({
    to_assigned_to: z.string().uuid().nullish(),
    to_ooa: z.boolean().optional(),
    reason: z.string().trim().max(SWAG_LEAD_REASON_MAX).nullish(),
    expected_revision: z.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.to_ooa) !== Boolean(v.to_assigned_to),
    "Choose exactly one of an AE or OOA.",
  );

const yesNo = z.enum(["yes", "no"]);
export const listQuerySchema = z.object({
  scope: z.string().optional(),
  metric: z.string().optional(),
  q: z.string().max(200).optional(),
  confirmed_realtor: yesNo.optional(),
  contacted: yesNo.optional(),
  met_in_person: yesNo.optional(),
  swag_delivered: yesNo.optional(),
  orders_received: yesNo.optional(),
  territory: z.string().max(200).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});
