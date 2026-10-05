"use client";

import { useState } from "react";

import { SWAG_FIELD_LABELS, type SwagAeOption, type SwagLead } from "@/lib/swag-leads";
import {
  SWAG_LEAD_CONTACT_MAX,
  SWAG_LEAD_NAME_MAX,
  SWAG_LEAD_NOTES_MAX,
} from "@/lib/swag-leads";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { FIELD_CLASS, SELECT_CLASS, todayIso } from "./shared";

// The lead form — used to ADD a lead and to EDIT one. The labels are the
// spreadsheet's own column headings, because the spreadsheet is the source of
// truth and the AEs know it by those words:
//
//   NAME · Contact info · Confirmed realtor? · Transactions in last 12 months ·
//   Date Lead Received · Date of first contact · # of follow up attempts ·
//   Swag delivered? · Did you meet in person? · Any orders received? · How many? ·
//   Notes
//
// "Any orders received?" / "How many?" mean business the AGENT has sent to
// Elevate — not swag quantities — and the hints say so.

export type LeadFormValues = {
  name: string;
  contact_info: string;
  confirmed_realtor: boolean;
  transactions_last_12_months: string;
  date_lead_received: string;
  date_first_contact: string;
  follow_up_attempts: string;
  swag_delivered: boolean;
  met_in_person: boolean;
  orders_received: boolean;
  orders_count: string;
  notes: string;
};

export function emptyFormValues(): LeadFormValues {
  return {
    name: "",
    contact_info: "",
    confirmed_realtor: false,
    transactions_last_12_months: "",
    date_lead_received: todayIso(),
    date_first_contact: "",
    follow_up_attempts: "0",
    swag_delivered: false,
    met_in_person: false,
    orders_received: false,
    orders_count: "",
    notes: "",
  };
}

export function valuesFromLead(l: SwagLead): LeadFormValues {
  return {
    name: l.name,
    contact_info: l.contact_info ?? "",
    confirmed_realtor: l.confirmed_realtor,
    transactions_last_12_months: l.transactions_last_12_months?.toString() ?? "",
    date_lead_received: l.date_lead_received,
    date_first_contact: l.date_first_contact ?? "",
    follow_up_attempts: String(l.follow_up_attempts),
    swag_delivered: l.swag_delivered,
    met_in_person: l.met_in_person,
    orders_received: l.orders_received,
    orders_count: l.orders_count?.toString() ?? "",
    notes: l.notes ?? "",
  };
}

const intOrNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));

/** The request fields for these values (the server re-validates everything). */
export function fieldsFromValues(v: LeadFormValues): Record<string, unknown> {
  return {
    name: v.name.trim(),
    contact_info: v.contact_info.trim() === "" ? null : v.contact_info,
    confirmed_realtor: v.confirmed_realtor,
    transactions_last_12_months: intOrNull(v.transactions_last_12_months),
    date_lead_received: v.date_lead_received,
    date_first_contact: v.date_first_contact === "" ? null : v.date_first_contact,
    follow_up_attempts: v.follow_up_attempts.trim() === "" ? 0 : Number(v.follow_up_attempts),
    swag_delivered: v.swag_delivered,
    met_in_person: v.met_in_person,
    orders_received: v.orders_received,
    // "How many?" is only meaningful when the agent has sent us business.
    orders_count: v.orders_received ? intOrNull(v.orders_count) : null,
    notes: v.notes.trim() === "" ? null : v.notes,
  };
}

function Check({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-start gap-3 rounded-md border border-border/70 px-3 py-2.5 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-primary"
      />
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

function Labeled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function SwagLeadForm({
  mode,
  initial,
  canEditIdentity,
  aeOptions,
  assignment,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  initial: LeadFormValues;
  /** Name + Date Lead Received are source-of-truth fields: management edits them. */
  canEditIdentity: boolean;
  /** Create by management only: who the lead is assigned to. */
  aeOptions?: SwagAeOption[];
  assignment?: { value: string; onChange: (v: string) => void };
  busy: boolean;
  error: string | null;
  onSubmit: (values: LeadFormValues) => void;
  onCancel?: () => void;
}) {
  const [v, setV] = useState<LeadFormValues>(initial);
  const set = <K extends keyof LeadFormValues>(k: K, val: LeadFormValues[K]) =>
    setV((prev) => ({ ...prev, [k]: val }));
  const identityLocked = mode === "edit" && !canEditIdentity;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onSubmit(v);
      }}
    >
      {assignment && aeOptions ? (
        <Labeled label="Assigned to" hint="You can transfer it later; every transfer is recorded.">
          <select
            required
            value={assignment.value}
            onChange={(e) => assignment.onChange(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="">Choose an AE or OOA…</option>
            {aeOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.first_name}
                {o.is_test ? " (test)" : ""}
              </option>
            ))}
            <option value="ooa">OOA — Out of Area</option>
          </select>
        </Labeled>
      ) : null}

      <Labeled label={SWAG_FIELD_LABELS.name}>
        <Input
          required
          value={v.name}
          maxLength={SWAG_LEAD_NAME_MAX}
          disabled={identityLocked || busy}
          onChange={(e) => set("name", e.target.value)}
        />
      </Labeled>
      <Labeled label={SWAG_FIELD_LABELS.contact_info} hint="Phone, email, social handle — whatever you have.">
        <Input
          value={v.contact_info}
          maxLength={SWAG_LEAD_CONTACT_MAX}
          disabled={busy}
          onChange={(e) => set("contact_info", e.target.value)}
        />
      </Labeled>

      <div className="grid gap-3 sm:grid-cols-2">
        <Labeled label={SWAG_FIELD_LABELS.date_lead_received}>
          <Input
            type="date"
            required
            max={todayIso()}
            value={v.date_lead_received}
            disabled={identityLocked || busy}
            onChange={(e) => set("date_lead_received", e.target.value)}
          />
        </Labeled>
        <Labeled label={SWAG_FIELD_LABELS.date_first_contact} hint="Leave blank until you've reached out.">
          <Input
            type="date"
            min={v.date_lead_received || undefined}
            max={todayIso()}
            value={v.date_first_contact}
            disabled={busy}
            onChange={(e) => set("date_first_contact", e.target.value)}
          />
        </Labeled>
        <Labeled label={SWAG_FIELD_LABELS.follow_up_attempts}>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={v.follow_up_attempts}
            disabled={busy}
            onChange={(e) => set("follow_up_attempts", e.target.value)}
          />
        </Labeled>
        <Labeled label={SWAG_FIELD_LABELS.transactions_last_12_months} hint="The lead's production.">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={v.transactions_last_12_months}
            disabled={busy}
            onChange={(e) => set("transactions_last_12_months", e.target.value)}
          />
        </Labeled>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Check
          label={SWAG_FIELD_LABELS.confirmed_realtor}
          checked={v.confirmed_realtor}
          disabled={busy}
          onChange={(c) => set("confirmed_realtor", c)}
        />
        <Check
          label={SWAG_FIELD_LABELS.swag_delivered}
          checked={v.swag_delivered}
          disabled={busy}
          onChange={(c) => set("swag_delivered", c)}
        />
        <Check
          label={SWAG_FIELD_LABELS.met_in_person}
          checked={v.met_in_person}
          disabled={busy}
          onChange={(c) => set("met_in_person", c)}
        />
        <Check
          label={SWAG_FIELD_LABELS.orders_received}
          hint="Has this agent sent business to Elevate?"
          checked={v.orders_received}
          disabled={busy}
          onChange={(c) => set("orders_received", c)}
        />
      </div>
      {v.orders_received ? (
        <Labeled label={SWAG_FIELD_LABELS.orders_count} hint="How many orders this agent has sent us.">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={v.orders_count}
            disabled={busy}
            onChange={(e) => set("orders_count", e.target.value)}
          />
        </Labeled>
      ) : null}

      <Labeled label={SWAG_FIELD_LABELS.notes}>
        <textarea
          rows={4}
          value={v.notes}
          maxLength={SWAG_LEAD_NOTES_MAX}
          disabled={busy}
          onChange={(e) => set("notes", e.target.value)}
          className={FIELD_CLASS}
        />
      </Labeled>

      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="lg" disabled={busy} className="min-h-11">
          {busy ? "Saving…" : mode === "create" ? "Add lead" : "Save changes"}
        </Button>
        {onCancel ? (
          <Button type="button" size="lg" variant="outline" onClick={onCancel} disabled={busy} className="min-h-11">
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
