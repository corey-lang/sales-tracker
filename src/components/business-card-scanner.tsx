"use client";

import { useState } from "react";
import { Camera } from "lucide-react";

import { isTestAccount } from "@/lib/permissions";
import type { StoredSalesperson } from "@/lib/use-salesperson";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Status = "idle" | "captured" | "processing" | "saved";

const STATUS_LABEL: Record<Exclude<Status, "idle">, string> = {
  captured: "Image captured",
  processing: "Processing card…",
  saved: "Saved for verification",
};

const STATUS_PROGRESS: Record<Exclude<Status, "idle">, string> = {
  captured: "33%",
  processing: "66%",
  saved: "100%",
};

type Props = {
  salesperson: StoredSalesperson;
};

// UI skeleton only — no upload, no OCR, no DB write, no record creation. Even
// for the test account this stays strictly client-side: nothing here must ever
// produce CRM, export, leaderboard, or metric data.
export function BusinessCardScanner({ salesperson }: Props) {
  const enabled = isTestAccount(salesperson);

  if (!enabled) {
    return <ComingSoonCard />;
  }

  return <ActiveScanner />;
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

function ActiveScanner() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");

  const runFakePipeline = () => {
    setStatus("captured");
    setTimeout(() => setStatus("processing"), 700);
    setTimeout(() => setStatus("saved"), 1800);
  };

  const close = () => {
    setOpen(false);
    setStatus("idle");
  };

  const scanAnother = () => {
    setStatus("idle");
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Scan Business Card</CardTitle>
        <CardDescription>
          Preview only — no image is uploaded or saved yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === "idle" ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" onClick={runFakePipeline}>
              Upload image
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={runFakePipeline}
            >
              Capture photo
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-base font-medium">{STATUS_LABEL[status]}</p>
            <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-all duration-500"
                style={{ width: STATUS_PROGRESS[status] }}
              />
            </div>
            {status === "saved" && (
              <p className="text-sm text-muted-foreground">
                A reviewer will confirm the details.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {status === "saved" && (
            <Button type="button" variant="outline" onClick={scanAnother}>
              Scan another
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={close}>
            {status === "saved" ? "Close" : "Cancel"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
