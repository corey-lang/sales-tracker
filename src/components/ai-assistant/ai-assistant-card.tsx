"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";

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

import { AiAssistantSheet } from "./ai-assistant-sheet";

/**
 * Home-dashboard entry point for the Test-AE-only AI Assistant beta.
 *
 * Renders nothing for anyone but the test account, so it's safe to drop into
 * the shared dashboard unconditionally — the visibility decision lives here,
 * in one place, keyed on the same `salespeople.is_test` flag the server route
 * enforces (`requireTestAccount`). When the beta opens to more users, widen
 * this single check rather than touching the dashboard. Intentionally not
 * added to global navigation yet.
 */
export function AiAssistantCard({
  salesperson,
}: {
  salesperson: StoredSalesperson;
}) {
  const [open, setOpen] = useState(false);

  if (!isTestAccount(salesperson)) return null;

  return (
    <>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="size-4 text-primary" />
            AI Assistant
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              Beta
            </span>
          </CardTitle>
          <CardDescription>
            Your sales sidekick — coaching, objection handling, follow-up
            wording, weekly planning, and app help. Type or speak your question.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" onClick={() => setOpen(true)}>
            Open AI Assistant
          </Button>
        </CardContent>
      </Card>
      {open && <AiAssistantSheet onClose={() => setOpen(false)} />}
    </>
  );
}
