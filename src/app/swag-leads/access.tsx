"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { landingPathFor } from "@/lib/role-routing";
import { useLivePermissions } from "@/lib/use-live-permissions";
import { useSalesperson, type StoredSalesperson } from "@/lib/use-salesperson";

// Route guard for the Swag Leads pages — CHROME ONLY. The real boundary is
// /api/swag-leads/*, which re-checks the caller on every request.
//
//   * signed out                       -> sign-in screen
//   * ae / admin                       -> in (an AE sees their own leads)
//   * assistant / juice_box_only       -> in only if the live permission read says
//                                         they were granted Swag Leads management
//                                         (Tonja, Faith); otherwise bounced home.
export function useSwagLeadsGate(): { salesperson: StoredSalesperson | null; ready: boolean } {
  const router = useRouter();
  const { salesperson, loaded } = useSalesperson();
  const { permissions, loaded: permsLoaded } = useLivePermissions();

  const needsGrant =
    salesperson != null && salesperson.role !== "ae" && salesperson.role !== "admin";
  const granted = permsLoaded && permissions?.can_manage_swag_leads === true;
  const ready = loaded && salesperson != null && (!needsGrant || granted);

  useEffect(() => {
    if (!loaded) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    if (needsGrant && permsLoaded && !granted) router.replace(landingPathFor(salesperson));
  }, [loaded, salesperson, needsGrant, permsLoaded, granted, router]);

  return { salesperson, ready };
}
