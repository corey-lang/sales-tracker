"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Send, Smile } from "lucide-react";

import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { BottomNav, BOTTOM_NAV_SPACER, canSeeJuiceBox } from "@/components/bottom-nav";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Juice Box — the team's live social feed. First pass is intentionally
// frontend-only: no Supabase tables, no realtime, no uploads, no push.
//
// Access during this test rollout is strictly limited to admins and test
// accounts. The bottom nav hides the tab for everyone else, and this page
// additionally redirects non-eligible users straight to /dashboard so the
// feature stays invisible until we ship it to the whole team.

export default function JuiceBoxPage() {
  const router = useRouter();
  const { salesperson, loaded } = useSalesperson();
  useScrollToTop();

  // Two gates, single effect:
  //   1. Not signed in -> /
  //   2. Signed in but not admin/test -> /dashboard (no "Coming soon" page)
  useEffect(() => {
    if (!loaded) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    if (!canSeeJuiceBox(salesperson)) {
      router.replace("/dashboard");
    }
  }, [loaded, salesperson, router]);

  if (!loaded || !salesperson || !canSeeJuiceBox(salesperson)) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <>
      <main
        className={`mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-4 ${BOTTOM_NAV_SPACER}`}
      >
        <header className="space-y-1 pt-1">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Juice Box 🍊
          </h1>
          <p className="text-sm text-muted-foreground">Live team feed</p>
        </header>

        <Composer firstName={salesperson.first_name} />
        <Feed firstName={salesperson.first_name} />
      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}

function Composer({ firstName }: { firstName: string }) {
  return (
    <Card size="sm">
      <CardContent className="space-y-3">
        <div className="flex items-start gap-3">
          <Avatar name={firstName} />
          <textarea
            disabled
            placeholder="Share a win, intro, or shoutout…"
            rows={2}
            className="flex-1 resize-none rounded-md border border-input bg-background/40 px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed"
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 text-muted-foreground">
            <button
              type="button"
              disabled
              aria-label="Add image"
              className="rounded-md p-1.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ImagePlus aria-hidden="true" className="size-4" />
            </button>
            <button
              type="button"
              disabled
              aria-label="Add reaction"
              className="rounded-md p-1.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Smile aria-hidden="true" className="size-4" />
            </button>
          </div>
          <Button size="sm" disabled className="gap-1.5">
            <Send aria-hidden="true" className="size-3.5" />
            Post
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Feed({ firstName }: { firstName: string }) {
  // Placeholder structure: one example card + empty state hint, so the layout
  // is visible before the data layer exists. Replaced with real posts once
  // the backend ships.
  return (
    <section className="space-y-3">
      <h2 className="px-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Feed
      </h2>
      <FeedCard
        author="Tonja"
        timeAgo="2m"
        body="🎉 Closed Acme Co — 24-month plan. Big assist from Ryan on the demo last week."
      />
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          You&apos;re all caught up, {firstName}. New posts will appear here.
        </CardContent>
      </Card>
    </section>
  );
}

function FeedCard({
  author,
  timeAgo,
  body,
}: {
  author: string;
  timeAgo: string;
  body: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <Avatar name={author} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{author}</p>
            <p className="text-xs text-muted-foreground">{timeAgo} ago</p>
          </div>
        </div>
        <p className="text-sm leading-relaxed">{body}</p>
      </CardContent>
    </Card>
  );
}

function Avatar({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary ring-1 ring-primary/30"
    >
      {initial}
    </div>
  );
}
