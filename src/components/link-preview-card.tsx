"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

// Calm, premium link-preview card rendered beneath a Juice Box message
// whose body contains an http(s) URL. Fetches metadata from
// /api/link-preview on mount and caches results in a module-level Map so
// the same URL pasted across many messages only resolves once.
//
// Failure mode is "render nothing" — a missing preview should never look
// like an error to the user. The component returns null while loading
// (so a feed scroll-into-view doesn't reflow when the fetch resolves)
// and on any failure.

type LinkPreview = {
  url: string;
  title: string;
  description: string | null;
  image: string | null;
  domain: string;
};

type ResolvedEntry = LinkPreview | null;
type CacheEntry = ResolvedEntry | Promise<ResolvedEntry>;
const PREVIEW_CACHE = new Map<string, CacheEntry>();

/** Returns the synchronously-resolved cache hit (or "unresolved" sentinel). */
function readCacheSync(url: string): ResolvedEntry | "unresolved" {
  const entry = PREVIEW_CACHE.get(url);
  if (entry === undefined || entry instanceof Promise) return "unresolved";
  return entry;
}

/** Resolves the cached entry (or starts a fetch) and returns the eventual value. */
async function loadPreview(url: string): Promise<ResolvedEntry> {
  const existing = PREVIEW_CACHE.get(url);
  if (existing !== undefined) {
    return existing instanceof Promise ? existing : existing;
  }
  const promise = (async () => {
    try {
      const res = await apiFetch(
        `/api/link-preview?url=${encodeURIComponent(url)}`,
      );
      if (!res.ok) {
        // 404 = "no preview"; anything else also collapses to null so
        // the card just doesn't render.
        PREVIEW_CACHE.set(url, null);
        return null;
      }
      const payload = (await res.json().catch(() => null)) as {
        preview?: LinkPreview;
      } | null;
      const preview = payload?.preview ?? null;
      PREVIEW_CACHE.set(url, preview);
      return preview;
    } catch {
      PREVIEW_CACHE.set(url, null);
      return null;
    }
  })();
  PREVIEW_CACHE.set(url, promise);
  return promise;
}

/** Initial-state seed: resolved cache hit, or "loading" otherwise. */
function initialPreview(url: string): ResolvedEntry | "loading" {
  const cached = readCacheSync(url);
  return cached === "unresolved" ? "loading" : cached;
}

export function LinkPreviewCard({
  url,
  className,
}: {
  url: string;
  className?: string;
}) {
  // React 19's "adjust state during render" pattern: when the URL prop
  // changes we reset locally without bouncing through an effect, which
  // satisfies the react-hooks/set-state-in-effect rule and avoids a
  // wasted render cycle.
  const [prevUrl, setPrevUrl] = useState(url);
  const [preview, setPreview] = useState<ResolvedEntry | "loading">(() =>
    initialPreview(url),
  );
  const [imgFailed, setImgFailed] = useState(false);
  if (prevUrl !== url) {
    setPrevUrl(url);
    setPreview(initialPreview(url));
    setImgFailed(false);
  }

  useEffect(() => {
    // Only the async resolution lives in the effect. If the cache hit
    // already gave us a value, this still runs (idempotent — loadPreview
    // short-circuits to the cached value).
    let cancelled = false;
    void loadPreview(url).then((p) => {
      if (cancelled) return;
      setPreview(p);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (preview === "loading" || preview === null) return null;

  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={cn(
        // Calm preview surface — same border treatment as feed cards,
        // slightly lighter background so it reads as a child of the
        // message rather than a peer card. Tap-target stays generous.
        "group flex overflow-hidden rounded-lg border border-border bg-card/60 transition-colors hover:border-primary/40 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        className,
      )}
    >
      {preview.image && !imgFailed && (
        // Square-ish thumb on mobile, fixed-width column on wider rows.
        // Aspect ratio kept tight so the card stays compact on a busy feed.
        <div className="relative aspect-square w-20 shrink-0 overflow-hidden bg-muted sm:w-24">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview.image}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="size-full object-cover transition-opacity group-hover:opacity-95"
          />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3 py-2">
        <p className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">
          <span className="truncate">{preview.domain}</span>
          <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
        </p>
        <p className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">
          {preview.title}
        </p>
        {preview.description && (
          <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">
            {preview.description}
          </p>
        )}
      </div>
    </a>
  );
}
