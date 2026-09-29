"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { apiFetchJson } from "@/lib/api-client";
import type { MeetingRecord } from "@/lib/one-on-one-meetings";

import { MeetingRecordView } from "../../_components/meeting-record";

// Admin → Weekly Focus → AE → one completed 1:1 (read-only history record).
// Rendered entirely from the frozen record returned by
// GET /api/admin/one-on-one-meetings/[id].

export default function MeetingRecordPage() {
  const { ae_id, meeting_id } = useParams<{ ae_id: string; meeting_id: string }>();
  const [record, setRecord] = useState<MeetingRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetchJson<MeetingRecord>(`/api/admin/one-on-one-meetings/${meeting_id}`)
      .then((r) => {
        if (cancelled) return;
        // A record must belong to the AE in the URL; anything else is a bad link.
        if (r.meeting.ae_id !== ae_id) setError("1:1 not found.");
        else setRecord(r);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load.");
      });
    return () => {
      cancelled = true;
    };
  }, [ae_id, meeting_id]);

  return (
    <div className="flex flex-col gap-4">
      <Link
        href={`/admin/coaching/${ae_id}`}
        className="inline-flex min-h-10 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to 1:1 workspace
      </Link>
      {error ? (
        <p className="text-sm text-destructive">Couldn&apos;t load: {error}</p>
      ) : !record ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : (
        <MeetingRecordView record={record} />
      )}
    </div>
  );
}
