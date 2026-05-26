"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

// Calm, premium link-preview card rendered beneath a Juice Box message
// whose body contains an http(s) URL. Fetches metadata from
// /api/link-preview on mount and caches results in a module-level Map so
// the same URL pasted across many messages only resolves once.
//
// Two render modes:
//   * Rich card — title / description / image / domain when metadata
//     fetches successfully.
//   * Fallback card — domain + URL only, used when metadata fails
//     (private host, non-HTML, OG-blocked site, timeout, etc.). Keeps
//     the link clickable so a paste of e.g. an Instagram URL never
//     looks "broken" — it just falls back to a calmer card.
//
// Loading state still renders `null` so the feed doesn't reflow when a
// fetch resolves mid-scroll.

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
        // 404 = "no preview" (expected for sites without OG metadata,
        // private hosts, non-HTML, timeouts). Anything else also
        // collapses to null so the card falls back to the simple form.
        // Intentionally no client-side warn: the URL is the user's
        // pasted content (may carry query strings / tracking params)
        // and redacting it client-side just to log a status code adds
        // noise. The route logs the structural digest server-side
        // (Vercel function logs, [link-preview] prefix), and DevTools
        // Network tab shows the response inline if a developer needs
        // to debug a misconfigured deployment.
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
      // Same reasoning as the non-OK branch: no client-side log of the
      // raw URL or error. Silent failure → fallback card renders.
      PREVIEW_CACHE.set(url, null);
      return null;
    }
  })();
  PREVIEW_CACHE.set(url, promise);
  return promise;
}

/** Best-effort hostname extraction for the fallback card. */
function safeDomain(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./i, "");
  } catch {
    return raw;
  }
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

  if (preview === "loading") return null;

  if (preview === null) {
    return <LinkFallbackCard url={url} className={className} />;
  }

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

/**
 * Calm fallback rendered when /api/link-preview can't produce metadata
 * (404, blocked host, OG-stripped page, etc.). Shows the domain + URL
 * so the link is still clearly clickable, with the same outer surface
 * as the rich card so the visual rhythm of the feed doesn't change.
 */
function LinkFallbackCard({
  url,
  className,
}: {
  url: string;
  className?: string;
}) {
  const domain = useMemo(() => safeDomain(url), [url]);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      title={url}
      className={cn(
        "group flex items-center gap-2 overflow-hidden rounded-lg border border-border bg-card/60 px-3 py-2 transition-colors hover:border-primary/40 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">
          <span className="truncate">{domain}</span>
          <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
        </p>
        <p className="truncate text-sm font-medium text-foreground">{url}</p>
      </div>
    </a>
  );
}
