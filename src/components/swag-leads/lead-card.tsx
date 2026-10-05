"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRightLeft, Check, Phone } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { formatDateMDY } from "@/lib/dates";
import type { SwagAeOption, SwagLeadView } from "@/lib/swag-leads";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";

import { TransferPanel } from "./transfer-panel";
import { errorText, todayIso } from "./shared";

// One lead in the list: who it is, who owns it, what needs doing, the
// spreadsheet outcomes at a glance, and the two quick actions an AE uses on a
// phone — log a follow-up / mark first contact — plus Transfer.

function Chip({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
        on
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground",
      )}
    >
      {on ? <Check aria-hidden="true" className="size-3" /> : null}
      {children}
    </span>
  );
}

export function LeadCard({
  lead,
  viewerId,
  isManager,
  aeOptions,
  onChanged,
}: {
  lead: SwagLeadView;
  viewerId: string;
  isManager: boolean;
  aeOptions: SwagAeOption[];
  /** Called with the fresh lead after any change (or null to just refetch). */
  onChanged: (lead: SwagLeadView | null) => void;
}) {
  const [transferOpen, setTransferOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const owner = lead.assigned_to !== null && lead.assigned_to === viewerId;
  const canAct = isManager || owner;

  const patch = async (p: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/swag-leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_revision: lead.revision, patch: p }),
      });
      if (res.status === 409) {
        // Someone changed it first: show their version, let the user retry.
        const body = (await res.json().catch(() => null)) as { conflict?: SwagLeadView; error?: string } | null;
        if (body?.conflict) onChanged(body.conflict);
        setError(body?.error ?? "This lead changed — review it and try again.");
        return;
      }
      if (!res.ok) {
        setError(await errorText(res, "Couldn't save"));
        return;
      }
      onChanged(((await res.json()) as { lead: SwagLeadView }).lead);
    } catch {
      setError("Couldn't reach the server — nothing was changed.");
    } finally {
      setBusy(false);
    }
  };

  const needsFirst = lead.attention === "needs_first_contact";
  const needsFollow = lead.attention === "needs_follow_up";

  return (
    <li className="rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/swag-leads/${lead.id}`} className="text-base font-semibold underline-offset-2 hover:underline">
            {lead.name}
          </Link>
          {lead.contact_info ? (
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              <Phone aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{lead.contact_info}</span>
            </p>
          ) : null}
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-xs font-medium",
            lead.is_ooa ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-muted text-foreground",
          )}
        >
          {lead.assigned_label}
          {lead.territories.length ? ` · ${lead.territories.join(", ")}` : ""}
        </span>
      </div>

      {needsFirst || needsFollow ? (
        <p
          className={cn(
            "mt-2 rounded-md px-2.5 py-1.5 text-sm font-medium",
            needsFirst ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-800 dark:text-amber-200",
          )}
        >
          {needsFirst ? "Needs first contact" : "Contacted — no follow-up logged yet"}
        </p>
      ) : null}

      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Received</dt>
          <dd>{formatDateMDY(lead.date_lead_received)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">First contact</dt>
          <dd>{lead.date_first_contact ? formatDateMDY(lead.date_first_contact) : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Follow-ups</dt>
          <dd className="font-medium tabular-nums">{lead.follow_up_attempts}</dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Chip on={lead.confirmed_realtor}>Realtor</Chip>
        <Chip on={lead.met_in_person}>Met in person</Chip>
        <Chip on={lead.swag_delivered}>Swag delivered</Chip>
        <Chip on={lead.orders_received}>
          {lead.orders_received
            ? `Sent business${lead.orders_count != null ? ` · ${lead.orders_count} order${lead.orders_count === 1 ? "" : "s"}` : ""}`
            : "No orders yet"}
        </Chip>
        {lead.transactions_last_12_months != null ? (
          <Chip on={false}>{lead.transactions_last_12_months} transactions / 12 mo</Chip>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}

      {canAct ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {needsFirst ? (
            <Button
              size="sm"
              className="min-h-11"
              disabled={busy}
              onClick={() => void patch({ date_first_contact: todayIso() })}
            >
              Contacted today
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => void patch({ follow_up_attempts: lead.follow_up_attempts + 1 })}
            >
              Log follow-up
            </Button>
          )}
          <Button size="sm" variant="outline" className="min-h-11" onClick={() => setTransferOpen((o) => !o)}>
            <ArrowRightLeft aria-hidden="true" />
            Transfer
          </Button>
          <Link
            href={`/swag-leads/${lead.id}`}
            className="inline-flex min-h-11 items-center px-2 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Details & history
          </Link>
        </div>
      ) : null}

      {transferOpen ? (
        <div className="mt-3">
          <TransferPanel
            lead={lead}
            aeOptions={aeOptions}
            onCancel={() => setTransferOpen(false)}
            onDone={() => {
              setTransferOpen(false);
              onChanged(null); // refetch: the lead may have left this view
            }}
          />
        </div>
      ) : null}
    </li>
  );
}
