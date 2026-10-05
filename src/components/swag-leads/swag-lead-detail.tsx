"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRightLeft } from "lucide-react";

import { apiFetch, apiFetchJson } from "@/lib/api-client";
import { formatDateMDY, formatTaskMoment } from "@/lib/dates";
import {
  SWAG_FIELD_LABELS,
  describeEvent,
  type SwagLeadDetailResponse,
  type SwagLeadEvent,
  type SwagLeadView,
} from "@/lib/swag-leads";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

import { SwagLeadForm, fieldsFromValues, valuesFromLead, type LeadFormValues } from "./swag-lead-form";
import { TransferPanel } from "./transfer-panel";
import { errorText, messageOf } from "./shared";

// One lead: every spreadsheet field (editable where the viewer may edit), the
// Transfer action, and the full immutable history. A save carries the lead's
// revision; if someone else changed it first the server refuses, and this
// screen shows the newer version instead of overwriting it.

const shown = (field: string, v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return formatDateMDY(String(v));
  return String(v);
};

function EventRow({ e }: { e: SwagLeadEvent }) {
  const changes = Object.entries(e.changes ?? {});
  return (
    <li className="border-l-2 border-border pl-3">
      <p className="text-sm font-medium">{describeEvent(e)}</p>
      <p className="text-xs text-muted-foreground">
        {e.actor_name} · {formatTaskMoment(e.occurred_at)}
      </p>
      {e.reason ? <p className="mt-0.5 text-sm">Reason: {e.reason}</p> : null}
      {changes.length ? (
        <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
          {changes.map(([field, c]) => (
            <li key={field}>
              <span className="font-medium text-foreground">{SWAG_FIELD_LABELS[field] ?? field}</span>
              {c.changed ? ": edited" : `: ${shown(field, c.from)} → ${shown(field, c.to)}`}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function SwagLeadDetail({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<SwagLeadDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  // Re-key the form after a refetch so it shows the server's latest values.
  const [formKey, setFormKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await apiFetchJson<SwagLeadDetailResponse>(`/api/swag-leads/${id}`));
      setFormKey((k) => k + 1);
      setError(null);
    } catch (err) {
      setError(messageOf(err, "Couldn't load this lead."));
    }
  }, [id]);

  // Initial fetch (state is set in the promise callbacks, after the request).
  useEffect(() => {
    let cancelled = false;
    apiFetchJson<SwagLeadDetailResponse>(`/api/swag-leads/${id}`)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setFormKey((k) => k + 1);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageOf(err, "Couldn't load this lead."));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="flex flex-col gap-3">
        <Back />
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </div>
    );
  }
  if (!data) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>;
  }
  const { lead, events, permissions, ae_options } = data;

  const save = async (v: LeadFormValues) => {
    setBusy(true);
    setSaveError(null);
    setNotice(null);
    const all = fieldsFromValues(v);
    // Send only what changed; the server ignores a no-op and records the rest.
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(all)) {
      if (JSON.stringify(val) !== JSON.stringify((lead as unknown as Record<string, unknown>)[k])) patch[k] = val;
    }
    if (Object.keys(patch).length === 0) {
      setNotice("Nothing to save — no changes.");
      setBusy(false);
      return;
    }
    try {
      const res = await apiFetch(`/api/swag-leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_revision: lead.revision, patch }),
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        await load();
        setSaveError(
          `${body?.error ?? "This lead changed."} Your edits were not saved — the latest version is shown; re-enter them if you still need them.`,
        );
        return;
      }
      if (!res.ok) {
        setSaveError(await errorText(res, "Couldn't save"));
        return;
      }
      await load();
      setNotice("Saved.");
    } catch {
      setSaveError("Couldn't reach the server — nothing was saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 [overflow-wrap:anywhere]">
      <Back />
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{lead.name}</h1>
        <p className="text-sm text-muted-foreground">
          Assigned to <span className="font-medium text-foreground">{lead.assigned_label}</span>
          {lead.territories.length ? ` · ${lead.territories.join(", ")}` : ""} · received {formatDateMDY(lead.date_lead_received)}
        </p>
        {lead.attention ? (
          <p className="text-sm font-medium text-destructive">
            {lead.attention === "needs_first_contact" ? "Needs first contact" : "Contacted — no follow-up logged yet"}
          </p>
        ) : null}
      </header>

      {permissions.can_transfer ? (
        <div className="flex flex-col gap-2">
          {transferOpen ? (
            <TransferPanel
              lead={lead as SwagLeadView}
              aeOptions={ae_options}
              onCancel={() => setTransferOpen(false)}
              onDone={() => {
                setTransferOpen(false);
                // An AE who handed the lead off no longer owns it (it would 404
                // here): go back to their list. Management still sees it.
                if (!permissions.can_edit_identity) router.push("/swag-leads");
                else void load();
              }}
            />
          ) : (
            <div>
              <Button variant="outline" className="min-h-11" onClick={() => setTransferOpen(true)}>
                <ArrowRightLeft aria-hidden="true" />
                Transfer lead
              </Button>
            </div>
          )}
        </div>
      ) : null}

      <Card>
        <CardContent className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{permissions.can_edit ? "Lead details" : "Lead details (read-only)"}</h2>
          {permissions.can_edit ? (
            <SwagLeadForm
              key={formKey}
              mode="edit"
              initial={valuesFromLead(lead)}
              canEditIdentity={permissions.can_edit_identity}
              busy={busy}
              error={saveError}
              onSubmit={(v) => void save(v)}
            />
          ) : (
            <p className="text-sm text-muted-foreground">You can view this lead but not change it.</p>
          )}
          {notice ? (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">History</h2>
          <p className="text-xs text-muted-foreground">
            Every transfer and important change, newest first. History can&apos;t be edited.
          </p>
          <ul className="flex flex-col gap-4">
            {events.map((e) => (
              <EventRow key={e.id} e={e} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function Back() {
  return (
    <Link
      href="/swag-leads"
      className="inline-flex min-h-10 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      Swag Leads
    </Link>
  );
}
