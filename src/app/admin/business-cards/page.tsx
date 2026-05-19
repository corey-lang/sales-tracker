"use client";

import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { VerificationCenter } from "@/components/verification-center";

// Business Card Verification — its own admin page. The review workflow
// (needs-review / duplicates / approved / rejected / exported, retry AI,
// approve / edit / reject / mark-duplicate, card thumbnails, AE attribution,
// extracted contact info and bucket) all lives in the shared VerificationCenter
// component, which is also shown on the assistant's (Tonja's) dashboard.

export default function AdminBusinessCardsPage() {
  useScrollToTop();
  return <VerificationCenter />;
}
