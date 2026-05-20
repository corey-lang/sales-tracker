"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LogOut, ShieldCheck } from "lucide-react";

import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// "More" tab — a minimal account/links page so the bottom nav has a sensible
// fourth destination. Intentionally lightweight: profile summary, an Admin
// link when applicable, and Log out. Anything else (settings, preferences,
// help) can land here later without changing the nav surface.

export default function MorePage() {
  const router = useRouter();
  const { salesperson, clear, loaded } = useSalesperson();
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

  const handleLogout = () => {
    clear();
    router.push("/");
  };

  return (
    <>
      <main
        className={`mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-4 ${BOTTOM_NAV_SPACER}`}
      >
        <header className="space-y-1 pt-1">
          <p className="text-sm text-muted-foreground">Account</p>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            More
          </h1>
        </header>

        <Card>
          <CardContent className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Signed in as
            </p>
            <p className="text-lg font-semibold">{salesperson.first_name}</p>
            <p className="text-xs text-muted-foreground">
              {salesperson.is_admin
                ? "Admin"
                : salesperson.role === "assistant"
                  ? "Assistant"
                  : "Account Executive"}
            </p>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-2">
          {salesperson.is_admin && (
            <Link
              href="/admin"
              className={buttonVariants({ variant: "outline" })}
            >
              <ShieldCheck aria-hidden="true" className="size-4" />
              Admin
            </Link>
          )}
          <Button variant="outline" onClick={handleLogout}>
            <LogOut aria-hidden="true" className="size-4" />
            Log out
          </Button>
        </div>
      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}
