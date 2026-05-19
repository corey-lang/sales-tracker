"use client";

import { useState } from "react";
import { Camera, X } from "lucide-react";

import { isTestAccount } from "@/lib/permissions";
import type { StoredSalesperson } from "@/lib/use-salesperson";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BusinessCardScanner } from "@/components/business-card-scanner";
import { PhoneContactScanner } from "@/components/phone-contact-scanner";

// Entry point for the AE business card area. Lets the AE pick between the two
// paths, then hands off to the matching scanner:
//
//   "Send Card to Admin"           -> BusinessCardScanner  (existing flow,
//                                     unchanged — AI reads it, Tonja reviews)
//   "Scan & Add to Phone Contact"  -> PhoneContactScanner  (new AE flow —
//                                     review the contact, save it to phone)

type Props = {
  salesperson: StoredSalesperson;
  /** Closes the whole panel — the dashboard owns the open/closed state. */
  onClose: () => void;
};

type Mode = "menu" | "admin" | "phone";

export function BusinessCardPanel({ salesperson, onClose }: Props) {
  // TEMPORARY — limited live testing before rollout.
  // "Scan & Add to Phone Contact" is gated to the test account only; everyone
  // else keeps the existing "Send Card to Admin" flow exactly as before. The
  // gate reuses the app's existing isTestAccount() helper (first_name "test").
  // Remove this gate (show the chooser to all AEs) when the feature ships.
  const canUsePhoneFlow = isTestAccount(salesperson);

  // Non-test AEs skip the chooser entirely and land on the admin scanner —
  // their experience is unchanged from before this feature existed.
  const [mode, setMode] = useState<Mode>(canUsePhoneFlow ? "menu" : "admin");

  if (mode === "admin") {
    return <BusinessCardScanner salesperson={salesperson} onClose={onClose} />;
  }
  if (mode === "phone") {
    return <PhoneContactScanner salesperson={salesperson} onClose={onClose} />;
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base">Business Cards</CardTitle>
        <CardDescription>Pick what to do with a card.</CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        <PanelOption
          label="Send Card to Admin"
          description="AI reads the card and Tonja reviews it for the CRM."
          onClick={() => setMode("admin")}
        />
        {/* TEMPORARY — test account only, see canUsePhoneFlow above. */}
        {canUsePhoneFlow && (
          <PanelOption
            label="Scan & Add to Phone Contact"
            description="Review the contact yourself and save it to your phone."
            onClick={() => setMode("phone")}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** A full-width option tile in the chooser. */
function PanelOption({
  label,
  description,
  onClick,
}: {
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-3 text-left transition-colors hover:border-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <Camera aria-hidden="true" className="size-5 shrink-0 text-primary" />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-primary">
          {label}
        </span>
        <span className="block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}
