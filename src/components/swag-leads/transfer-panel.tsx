"use client";

import { useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { SWAG_LEAD_REASON_MAX, type SwagAeOption, type SwagLeadView } from "@/lib/swag-leads";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { SELECT_CLASS, errorText } from "./shared";

// Transfer a lead to another AE, or to OOA (Out of Area); management can also
// move an OOA lead back to an AE. The server decides who may — this panel is
// only shown to the lead's current owner and to management, and every attempt
// is re-checked (and recorded) in the database.

export function TransferPanel({
  lead,
  aeOptions,
  onDone,
  onCancel,
}: {
  lead: SwagLeadView;
  aeOptions: SwagAeOption[];
  /** Called once the lead has moved. (The response may be just a receipt: the
   *  former owner no longer sees the lead's details.) */
  onDone: () => void;
  onCancel: () => void;
}) {
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Real leads go to real AEs, test leads to test AEs; never back to the
  // current owner. OOA is offered unless the lead is already there.
  const targets = aeOptions.filter((o) => o.is_test === lead.is_test_data && o.id !== lead.assigned_to);

  const submit = async () => {
    if (!to || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/swag-leads/${lead.id}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(to === "ooa" ? { to_ooa: true } : { to_assigned_to: to }),
          reason: reason.trim() || null,
          expected_revision: lead.revision,
        }),
      });
      if (!res.ok) {
        setError(await errorText(res, "Couldn't transfer"));
        return;
      }
      onDone();
    } catch {
      setError("Couldn't reach the server — nothing was changed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
      <p className="text-sm font-semibold">
        Transfer {lead.name} <span className="font-normal text-muted-foreground">(now with {lead.assigned_label})</span>
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Move to</span>
        <select value={to} disabled={busy} onChange={(e) => setTo(e.target.value)} className={SELECT_CLASS}>
          <option value="">Choose an AE or OOA…</option>
          {targets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.first_name}
              {o.is_test ? " (test)" : ""}
            </option>
          ))}
          {!lead.is_ooa ? <option value="ooa">OOA — Out of Area</option> : null}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Reason (optional)</span>
        <Input
          value={reason}
          maxLength={SWAG_LEAD_REASON_MAX}
          disabled={busy}
          placeholder="e.g. Outside my territory"
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void submit()} disabled={!to || busy} className="min-h-11">
          {busy ? "Transferring…" : "Transfer lead"}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={busy} className="min-h-11">
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The lead itself moves — nothing is copied — and the transfer is recorded in its history.
      </p>
    </div>
  );
}
