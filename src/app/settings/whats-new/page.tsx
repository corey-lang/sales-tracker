"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { format, parseISO } from "date-fns";

import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { WHATS_NEW, type WhatsNewItem } from "@/lib/whatsNew";
import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// "What's New" — a lightweight, mobile-first in-app training feed that explains
// recently-shipped features to AEs. V1 is read-only and fully static (content
// lives in src/lib/whatsNew.ts) — no backend, read-tracking, or analytics.
// Reached from the More tab's "What's New" link.

function formatReleased(iso: string): string {
  return format(parseISO(iso), "MMM d, yyyy");
}

/** Small uppercase section label, matching the muted-label style used elsewhere. */
function SectionLabel({ children }: { children: string }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

function FeatureCard({ item }: { item: WhatsNewItem }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="text-2xl leading-none">
              {item.icon}
            </span>
            <div className="space-y-0.5">
              <CardTitle>{item.title}</CardTitle>
              <CardDescription className="text-xs">
                {formatReleased(item.releasedAt)}
              </CardDescription>
            </div>
          </div>
          {item.isNew && (
            <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
              New
            </span>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="space-y-1">
          <SectionLabel>What it does</SectionLabel>
          <p className="text-sm text-foreground/90">{item.whatItDoes}</p>
        </div>

        <div className="space-y-1">
          <SectionLabel>Why it matters</SectionLabel>
          <p className="text-sm text-foreground/90">{item.whyItMatters}</p>
        </div>

        <div className="space-y-1">
          <SectionLabel>How to use it</SectionLabel>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground/90 marker:text-muted-foreground">
            {item.howToUseIt.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>

        {item.proTip && (
          <div className="rounded-lg bg-primary/5 p-3 ring-1 ring-primary/15">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">
              💡 Pro Tip
            </p>
            <p className="mt-1 text-sm text-foreground/90">{item.proTip}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function WhatsNewPage() {
  const router = useRouter();
  const { salesperson, loaded } = useSalesperson();
  useScrollToTop();

  useEffect(() => {
    if (loaded && !salesperson) router.replace("/");
  }, [loaded, salesperson, router]);

  if (!loaded || !salesperson) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <>
      <main
        className={`pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-4 ${BOTTOM_NAV_SPACER}`}
      >
        <header className="space-y-1 pt-1">
          <p className="text-sm text-muted-foreground">Settings</p>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            ✨ What&apos;s New
          </h1>
          <p className="text-sm text-muted-foreground">
            New features and tips to help you sell more.
          </p>
        </header>

        <div className="flex flex-col gap-4">
          {WHATS_NEW.map((item) => (
            <FeatureCard key={item.id} item={item} />
          ))}
        </div>
      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}
