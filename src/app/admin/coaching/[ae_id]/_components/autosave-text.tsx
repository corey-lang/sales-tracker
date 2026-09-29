"use client";

import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";

import { apiFetch } from "@/lib/api-client";
import {
  DraftAutosave,
  DraftConflictError,
  type FieldSaver,
  type FieldStatus,
} from "@/lib/draft-autosave";
import type { DraftConflictBody } from "@/lib/one-on-one-meetings";
import { cn } from "@/lib/utils";

// Autosaving text fields for the 1:1 draft.
//
// Every field's text, save queue, and status live in ONE DraftAutosave
// coordinator for the page (lib/draft-autosave.ts), keyed by a stable field
// key — not in this component. So:
//   * collapsing a Gold List card (unmounting its note field) loses nothing
//     and doesn't drop the field from Complete's flush;
//   * saves per field are serialized, and a server response never rewrites
//     what's on screen;
//   * while Complete 1:1 runs, the coordinator is locked and every field
//     (and meeting action) here is disabled.
// Status feedback stays quiet and inline: "Saving…" / "Saved" /
// "Not saved · Retry". A save refused because another tab/device saved newer
// text shows both versions and lets the manager keep theirs or keep mine —
// the typed text is never silently discarded.

export const DraftContext = createContext<DraftAutosave | null>(null);

export function useDraft(): DraftAutosave {
  const draft = useContext(DraftContext);
  if (!draft) throw new Error("useDraft() needs a <DraftContext.Provider>.");
  return draft;
}

/** Re-renders whenever the draft changes (lock state, any field). */
function useDraftVersion(draft: DraftAutosave): number {
  return useSyncExternalStore(draft.subscribe, draft.getVersion, draft.getVersion);
}

const noopSubscribe = () => () => undefined;
const zero = () => 0;

/**
 * The page's draft coordinator if this component is inside one (null
 * otherwise), re-rendering on its changes. For components also used
 * outside a 1:1.
 */
export function useOptionalDraft(): DraftAutosave | null {
  const draft = useContext(DraftContext);
  useSyncExternalStore(
    draft ? draft.subscribe : noopSubscribe,
    draft ? draft.getVersion : zero,
    draft ? draft.getVersion : zero,
  );
  return draft;
}

/** True while Complete 1:1 is running — meeting inputs must be disabled. */
export function useDraftLocked(): boolean {
  const draft = useDraft();
  useDraftVersion(draft);
  return draft.locked;
}

/**
 * Sends a revision-checked draft save and resolves to the new revision.
 * A 409 carrying `conflict` becomes DraftConflictError (another tab/device
 * saved newer text); anything else non-2xx is a plain failure (retryable).
 */
export async function revisionedSave(
  url: string,
  method: "PATCH" | "PUT",
  body: Record<string, unknown>,
  revisionOf: (json: unknown) => number,
): Promise<number> {
  const res = await apiFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  if (res.status === 409 && json && typeof json === "object" && "conflict" in json) {
    const { conflict } = json as DraftConflictBody;
    throw new DraftConflictError(conflict.value ?? "", conflict.revision);
  }
  if (!res.ok) {
    const message =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : `Save failed (${res.status}).`;
    throw new Error(message);
  }
  return revisionOf(json);
}

/**
 * Binds one draft field. `initial` / `revision` seed it only the first time
 * the key is seen; `save` is refreshed every render so it closes over
 * current props.
 */
export function useDraftField(
  fieldKey: string,
  initial: string | null,
  save: FieldSaver,
  revision = 0,
) {
  const draft = useDraft();
  // Idempotent and emits nothing — safe during render.
  draft.ensure(fieldKey, initial ?? "", save, revision);
  useDraftVersion(draft);
  const snap = draft.get(fieldKey)!;

  useEffect(() => {
    if (snap.status !== "saved") return;
    const t = window.setTimeout(() => draft.settle(fieldKey), 1600);
    return () => window.clearTimeout(t);
  }, [snap.status, draft, fieldKey]);

  return {
    value: snap.value,
    status: snap.status,
    conflict: snap.conflict,
    locked: draft.locked,
    set: (v: string) => draft.set(fieldKey, v),
    flush: () => draft.flush(fieldKey),
    resolve: (choice: "mine" | "theirs") => draft.resolveConflict(fieldKey, choice),
  };
}

export const TEXTAREA_CLASS =
  "w-full resize-y rounded-md border border-border bg-background/40 px-3 py-2 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-70 sm:text-sm";

export function AutosaveText({
  fieldKey,
  label,
  value,
  revision = 0,
  placeholder,
  save,
  disabled,
  multiline = true,
  rows = 3,
  maxLength,
  hint,
  labelClassName,
}: {
  /** Stable coordinator key, e.g. `${meetingId}:wins`. */
  fieldKey: string;
  label: string;
  /** Server value — seeds the field the first time only. */
  value: string | null;
  /** Server revision of `value` — seeds the field the first time only. */
  revision?: number;
  placeholder?: string;
  /** Persists the value on top of a revision; resolves to the new revision. */
  save: FieldSaver;
  disabled?: boolean;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  /** Small helper line under the label (e.g. last time's focus). */
  hint?: React.ReactNode;
  labelClassName?: string;
}) {
  const field = useDraftField(fieldKey, value, save, revision);
  const off = disabled || field.locked;
  const common = {
    value: field.value,
    disabled: off,
    maxLength,
    placeholder,
    onBlur: () => {
      if (!off) void field.flush();
    },
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      field.set(e.target.value);
    },
  };

  return (
    <label className="block">
      <span
        className={cn(
          "flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground",
          labelClassName,
        )}
      >
        <span>{label}</span>
        <SaveStatusPill status={field.status} onRetry={() => void field.flush()} />
      </span>
      {hint ? (
        <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
      ) : null}
      {multiline ? (
        <textarea {...common} rows={rows} className={cn(TEXTAREA_CLASS, "mt-1")} />
      ) : (
        <input
          {...common}
          type="text"
          className={cn(TEXTAREA_CLASS, "mt-1 min-h-10 resize-none")}
        />
      )}
      {field.conflict ? (
        <ConflictNotice
          theirs={field.conflict.value}
          disabled={field.locked}
          onKeepMine={() => void field.resolve("mine")}
          onUseTheirs={() => void field.resolve("theirs")}
        />
      ) : null}
    </label>
  );
}

/**
 * Shown when another tab/device saved this field first. The manager's text
 * stays in the box above (unsent) until they choose.
 */
function ConflictNotice({
  theirs,
  disabled,
  onKeepMine,
  onUseTheirs,
}: {
  theirs: string;
  disabled: boolean;
  onKeepMine: () => void;
  onUseTheirs: () => void;
}) {
  return (
    <span
      role="alert"
      className="mt-1.5 block rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-sm"
    >
      <span className="block font-medium text-amber-800 dark:text-amber-300">
        This was changed in another tab or device. Your text above is not saved yet.
      </span>
      <span className="mt-1 block text-xs text-muted-foreground">Their version:</span>
      <span className="block whitespace-pre-wrap rounded bg-background/60 px-2 py-1 text-foreground/80">
        {theirs || "(empty)"}
      </span>
      <span className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => {
            e.preventDefault();
            onKeepMine();
          }}
          className="min-h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Keep mine
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => {
            e.preventDefault();
            onUseTheirs();
          }}
          className="min-h-9 rounded-md border border-border px-3 text-sm disabled:opacity-50"
        >
          Use theirs
        </button>
      </span>
    </span>
  );
}

export function SaveStatusPill({
  status,
  onRetry,
}: {
  status: FieldStatus;
  onRetry?: () => void;
}) {
  if (status === "idle") return null;
  if (status === "saving") {
    return (
      <span className="text-[10px] font-medium normal-case tracking-normal text-muted-foreground/70">
        Saving…
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="text-[10px] font-medium normal-case tracking-normal text-green-600 dark:text-green-400">
        Saved
      </span>
    );
  }
  if (status === "conflict") {
    return (
      <span className="text-[10px] font-medium normal-case tracking-normal text-amber-700 dark:text-amber-400">
        Changed elsewhere
      </span>
    );
  }
  return (
    <span
      role="alert"
      className="inline-flex items-center gap-1 text-[10px] font-medium normal-case tracking-normal text-destructive"
    >
      Not saved
      {onRetry ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            onRetry();
          }}
          className="rounded px-1 underline underline-offset-2"
        >
          Retry
        </button>
      ) : null}
    </span>
  );
}

/** A plain section shell used by every workspace section. */
export function Section({
  title,
  description,
  action,
  children,
  id,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-4 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10 sm:p-5"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{title}</h3>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
