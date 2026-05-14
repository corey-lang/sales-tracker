"use client";

import { useState } from "react";
import { Camera } from "lucide-react";

import { isTestAccount } from "@/lib/permissions";
import { supabase } from "@/lib/supabase/client";
import type { StoredSalesperson } from "@/lib/use-salesperson";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const BUCKET = "business-card-scans";

type Status =
  | "idle"
  | "sim-step1"
  | "sim-step2"
  | "sim-done"
  | "uploading"
  | "saved"
  | "error";

type Props = {
  salesperson: StoredSalesperson;
};

// Phase 3: real scan intake for the Test account only. Normal AEs still see
// the "Coming Soon" card. Even for Test, this writes ONLY to
// business_card_scans + the business-card-scans storage bucket — it must
// never produce CRM, export, leaderboard, or metric data.
export function BusinessCardScanner({ salesperson }: Props) {
  const enabled = isTestAccount(salesperson);

  if (!enabled) {
    return <ComingSoonCard />;
  }

  return <ActiveScanner salesperson={salesperson} />;
}

function ComingSoonCard() {
  return (
    <Card aria-label="Scan Business Card — coming soon">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Camera aria-hidden="true" className="size-5 text-primary" />
          <CardTitle className="text-xl">Scan Business Card</CardTitle>
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            Coming Soon
          </span>
        </div>
        <CardDescription>
          AI-powered contact capture for office visits and networking.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function sanitizeFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = (dot === -1 ? name : name.slice(0, dot))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "card";
  const ext =
    dot === -1
      ? "jpg"
      : name
          .slice(dot + 1)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 5) || "jpg";
  return `${base}.${ext}`;
}

function ActiveScanner({ salesperson }: { salesperson: StoredSalesperson }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const runSimulatedCapture = () => {
    // Placeholder for the future camera-capture path. Intentionally does NOT
    // persist anything — Phase 3 only saves when a real file is uploaded.
    // Labels here must never claim "Image captured" or "Saved for
    // verification": those phrases are reserved for the real upload flow so
    // testers can't mistake a simulation for a real save.
    setErrorMessage(null);
    setStatus("sim-step1");
    setTimeout(() => setStatus("sim-step2"), 700);
    setTimeout(() => setStatus("sim-done"), 1800);
  };

  const handleFile = async (file: File) => {
    setErrorMessage(null);
    setStatus("uploading");

    const ext = sanitizeFilename(file.name);
    const path = `${salesperson.id}/${Date.now()}-${ext}`;

    const upload = await supabase.storage
      .from(BUCKET)
      .upload(path, file, {
        contentType: file.type || "image/jpeg",
        upsert: false,
      });

    if (upload.error) {
      setErrorMessage(`Upload failed: ${upload.error.message}`);
      setStatus("error");
      return;
    }

    const { data: publicUrl } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(upload.data.path);

    const insert = await supabase.from("business_card_scans").insert({
      salesperson_id: salesperson.id,
      salesperson_name: salesperson.first_name,
      image_url: publicUrl.publicUrl,
      status: "processing",
      is_test_data: true,
    });

    if (insert.error) {
      setErrorMessage(`Save failed: ${insert.error.message}`);
      setStatus("error");
      return;
    }

    setStatus("saved");
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file again re-fires onChange.
    e.target.value = "";
    if (!file) return;
    void handleFile(file);
  };

  const close = () => {
    setOpen(false);
    setStatus("idle");
    setErrorMessage(null);
  };

  const reset = () => {
    setStatus("idle");
    setErrorMessage(null);
  };

  if (!open) {
    return (
      <Button
        type="button"
        size="lg"
        className="w-full text-base font-semibold sm:w-auto sm:self-start"
        onClick={() => setOpen(true)}
      >
        <Camera aria-hidden="true" className="size-5" />
        Scan Business Card
      </Button>
    );
  }

  const isSim =
    status === "sim-step1" ||
    status === "sim-step2" ||
    status === "sim-done";

  const showProgress = isSim || status === "uploading" || status === "saved";

  const progressLabel =
    status === "uploading"
      ? "Uploading…"
      : status === "saved"
        ? "Saved for verification"
        : status === "sim-step1"
          ? "Simulation: step 1 of 3"
          : status === "sim-step2"
            ? "Simulation: step 2 of 3"
            : status === "sim-done"
              ? "Simulation complete — no file was uploaded or stored"
              : "";

  const progressPercent =
    status === "uploading"
      ? "66%"
      : status === "saved"
        ? "100%"
        : status === "sim-step1"
          ? "33%"
          : status === "sim-step2"
            ? "66%"
            : status === "sim-done"
              ? "100%"
              : "0%";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Scan Business Card</CardTitle>
        <CardDescription>
          Test account only. Uploaded images are saved for later verification —
          no OCR, no leaderboard impact.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === "idle" && (
          <div className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFileChange}
                className="block text-sm"
              />
              <Button
                type="button"
                variant="outline"
                onClick={runSimulatedCapture}
                aria-label="Capture photo — demo (simulated, not saved)"
              >
                Capture photo — demo
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The file input opens your camera or photo library and saves the
              chosen image. <strong>Capture photo — demo</strong> is a
              simulation only — nothing is uploaded or stored.
            </p>
          </div>
        )}

        {showProgress && (
          <div className="space-y-2">
            <p className="text-base font-medium">{progressLabel}</p>
            <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-all duration-500"
                style={{ width: progressPercent }}
              />
            </div>
            {status === "saved" && (
              <p className="text-sm text-muted-foreground">
                A reviewer will confirm the details.
              </p>
            )}
          </div>
        )}

        {status === "error" && errorMessage && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {errorMessage}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {(status === "saved" ||
            status === "sim-done" ||
            status === "error") && (
            <Button type="button" variant="outline" onClick={reset}>
              Scan another
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={close}>
            {status === "saved" || status === "sim-done" ? "Close" : "Cancel"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
