"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  MapPin,
  X,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import {
  GEOCODE_DEBOUNCE_MS,
  GEOCODE_MIN_QUERY_LENGTH,
  type GeocodeResult,
} from "@/lib/geocode";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// OfficeFormModal — Add Office + Edit Office shared modal.
//
// Drives two flows over the same form UI:
//
//   ADD mode: empty initialValues, parent's onSubmit POSTs
//   /api/offices, navigates to the new office's detail page.
//
//   EDIT mode: initialValues pre-populated from the existing office
//   row. Parent's onSubmit PATCHes /api/offices/[id] with only the
//   fields that changed. The detail page applies the returned row
//   in place.
//
// Pattern is inverted-control: the modal collects state + calls
// `onSubmit(payload)` and waits for the parent's promise. The parent
// returns either `{ ok: true }` (modal closes) or `{ ok: false,
// error }` (modal stays open and surfaces the error inline). This
// keeps API call shapes + post-success side effects out of the
// modal, which is purely a form.
//
// `picked` tracks whether the user selected a Geoapify suggestion
// during this session. Manual typing after a pick clears it — the
// typed text no longer matches the geocoded location, so shipping
// those coords would be wrong. The parent receives `picked` in the
// submit payload and decides what to do with it.
//
// In EDIT mode, an `addressTextChanged` flag also surfaces to the
// parent — set true when the address differs from `initialValues.
// address` after trim. The parent uses this to decide whether to
// include `street` in the PATCH body (PATCH semantics: only-touched
// fields).
// ---------------------------------------------------------------------------

export type OfficeFormInitialValues = {
  name: string;
  /** Display-equivalent of `offices.street` — what the user sees in
   *  the Address field. */
  address: string;
  phone: string;
  email: string;
  notes: string;
  nextAction: string;
};

export type OfficeFormPayload = {
  name: string;
  /** Trimmed text from the Address field. */
  address: string;
  /** Non-null when the user picked a Geoapify suggestion in this
   *  session. Parent decides whether to ship its coords / city /
   *  state / zip to the server. */
  picked: GeocodeResult | null;
  /** EDIT mode helper: true when the address field differs from
   *  `initialValues.address` after trim. Always true in ADD mode
   *  (no initial value to diff against). */
  addressTextChanged: boolean;
  phone: string;
  email: string;
  notes: string;
  nextAction: string;
};

export type OfficeFormSubmitResult =
  | { ok: true }
  | { ok: false; error: string };

export type OfficeFormMode = "add" | "edit";

const EMPTY_VALUES: OfficeFormInitialValues = {
  name: "",
  address: "",
  phone: "",
  email: "",
  notes: "",
  nextAction: "",
};

/** Convenience export so callers spread an empty form in ADD mode
 *  without re-declaring the shape locally. */
export const EMPTY_OFFICE_FORM_VALUES = EMPTY_VALUES;

export function OfficeFormModal({
  mode,
  initialValues,
  onSubmit,
  onClose,
}: {
  mode: OfficeFormMode;
  initialValues: OfficeFormInitialValues;
  onSubmit: (payload: OfficeFormPayload) => Promise<OfficeFormSubmitResult>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialValues.name);
  const [address, setAddress] = useState(initialValues.address);
  const [picked, setPicked] = useState<GeocodeResult | null>(null);
  const [phone, setPhone] = useState(initialValues.phone);
  const [email, setEmail] = useState(initialValues.email);
  const [notes, setNotes] = useState(initialValues.notes);
  const [nextAction, setNextAction] = useState(initialValues.nextAction);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Microtask defer so iOS reliably opens the keyboard on first
    // paint. For EDIT mode focusing the (already-populated) name
    // input also highlights it for quick replacement — still nice
    // even though there's text there.
    const id = window.setTimeout(() => nameRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [saving, onClose]);

  const trimmedName = name.trim();
  const trimmedAddress = address.trim();
  const canSubmit =
    trimmedName.length > 0 && trimmedAddress.length > 0 && !saving;

  // Address-text change detection — drives the helper-text branch in
  // EDIT mode + signals the parent's PATCH builder.
  const initialAddressTrimmed = initialValues.address.trim();
  const addressTextChanged = trimmedAddress !== initialAddressTrimmed;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const result = await onSubmit({
      name: trimmedName,
      address: trimmedAddress,
      picked,
      addressTextChanged: mode === "add" ? true : addressTextChanged,
      phone: phone.trim(),
      email: email.trim(),
      notes: notes.trim(),
      nextAction: nextAction.trim(),
    });
    setSaving(false);
    if (result.ok) {
      onClose();
    } else {
      setError(result.error);
    }
  }

  const title = mode === "add" ? "Add Office" : "Edit Office";
  const saveButtonLabel =
    mode === "add"
      ? saving
        ? "Adding…"
        : "Add Office"
      : saving
        ? "Saving…"
        : "Save Changes";

  // Helper-text branches.
  //   Add: "captured" when picked, "manual won't show on Map" otherwise.
  //   Edit: "captured" when picked, "manual edit keeps the existing
  //         pin" when the address text changed without picking,
  //         no helper when nothing changed.
  const showCoordsCaptured = picked !== null;
  const showAddManualWarning =
    mode === "add" && !picked && trimmedAddress.length > 0;
  const showEditManualWarning =
    mode === "edit" && !picked && addressTextChanged;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="office-form-title"
      // z-50 sits above the bottom nav (z-40). The /offices map wrapper
      // uses `isolate` so Leaflet's internal z-indexes (200-1000) stay
      // contained — the modal at z-50 layers cleanly above the map.
      className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center"
      style={{
        paddingTop: "calc(0.75rem + env(safe-area-inset-top))",
        paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
      }}
    >
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => {
          if (!saving) onClose();
        }}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm focus:outline-none"
      />
      <Card
        size="sm"
        className="relative w-full max-w-md overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150"
      >
        <CardContent className="space-y-3 px-4 py-3">
          <header className="flex items-start justify-between gap-2">
            <h2 id="office-form-title" className="text-base font-semibold">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              aria-label="Close"
              className="-mr-1 -mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </header>
          <p className="text-xs text-muted-foreground">
            {mode === "add"
              ? "Required: name + address. Start typing an address to pick a real location — that captures the coordinates so the office appears on the Map right away. Manual entry is fine too; manual addresses may not appear on the Map until coordinates are added. After saving, you'll open the new office detail page; the office will also appear in your List right away."
              : "Edit the office's name, address, or contact info. Pick an address suggestion to move this office's pin on the Map; manual edits keep the existing pin until you do."}
          </p>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1">
              <label
                htmlFor="office-form-name"
                className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                Name <span className="text-destructive">*</span>
              </label>
              <Input
                id="office-form-name"
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Smith & Co Realty"
                disabled={saving}
                maxLength={200}
                required
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="office-form-address"
                className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                Address <span className="text-destructive">*</span>
              </label>
              <AddressAutocomplete
                value={address}
                onChange={(v) => {
                  setAddress(v);
                  // Manual edits invalidate any previously locked
                  // geocode pick — the typed text no longer matches
                  // the original lat/lng.
                  if (picked) setPicked(null);
                }}
                onPick={(result) => {
                  setAddress(result.formatted);
                  setPicked(result);
                }}
                disabled={saving}
                inputId="office-form-address"
                placeholder="e.g. 12 Main St, Orem, UT 84057"
              />
              {showCoordsCaptured && (
                <p className="inline-flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400">
                  <CheckCircle2 aria-hidden="true" className="size-3" />
                  {mode === "add"
                    ? "Coordinates captured — this office will show on the Map right away."
                    : "New location picked — this office's map pin will move when you save."}
                </p>
              )}
              {showAddManualWarning && (
                <p className="text-[11px] text-muted-foreground">
                  Manual addresses may not appear on the Map until
                  coordinates are added.
                </p>
              )}
              {showEditManualWarning && (
                <p className="text-[11px] text-muted-foreground">
                  Manual edits keep the existing map pin. Pick a
                  suggestion to move it.
                </p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label
                  htmlFor="office-form-phone"
                  className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  Phone (optional)
                </label>
                <Input
                  id="office-form-phone"
                  type="tel"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="e.g. (801) 555-1234"
                  disabled={saving}
                  maxLength={64}
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="office-form-email"
                  className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  Email (optional)
                </label>
                <Input
                  id="office-form-email"
                  type="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="e.g. front@office.com"
                  disabled={saving}
                  maxLength={254}
                />
              </div>
            </div>
            {/* Office notes + Next action only in ADD mode. In EDIT
                mode they're owned by the detail page's dedicated
                cards (preview + Edit toggle), so surfacing them here
                would offer a second, conflicting editor. */}
            {mode === "add" && (
              <>
                <div className="space-y-1">
                  <label
                    htmlFor="office-form-notes"
                    className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    Office notes (optional)
                  </label>
                  <textarea
                    id="office-form-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="e.g. Broker is Sarah · Office meetings Tuesdays at 10am"
                    disabled={saving}
                    rows={2}
                    className="w-full min-h-[64px] rounded-md border border-input bg-background p-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="office-form-next-action"
                    className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    Next action (optional)
                  </label>
                  <Input
                    id="office-form-next-action"
                    value={nextAction}
                    onChange={(e) => setNextAction(e.target.value)}
                    placeholder="e.g. Drop off donuts next Friday"
                    disabled={saving}
                    maxLength={2000}
                  />
                </div>
              </>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {saveButtonLabel}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddressAutocomplete — typeahead backed by /api/geocode/search
// ---------------------------------------------------------------------------
//
// Behavior contract:
//   * `value` is the input's current text.
//   * `onChange(v)` fires on every keystroke / paste.
//   * `onPick(result)` fires when the user taps a suggestion.
//     Callers should update `value` to `result.formatted` AND stash
//     the lat/lng + structured address parts from the result.
//   * Manual typing AFTER a pick is the caller's responsibility to
//     handle (clear the stashed coords). This component doesn't
//     track the picked state internally.
//
// Suggestion fetch:
//   * Debounced by GEOCODE_DEBOUNCE_MS (500 ms) to stay under the
//     upstream provider's rate-limit guidance.
//   * Skipped when value < GEOCODE_MIN_QUERY_LENGTH (4 chars).
//   * Cancellable: a fresh keystroke invalidates the in-flight
//     request so a slow first query can't overwrite a faster
//     later one.
//
// Dropdown:
//   * Opens on focus and on every typed change.
//   * Closes on outside-tap (mousedown/touchstart on the document),
//     Escape, or after a suggestion is picked.
//   * Renders "Searching…" while loading, "No matches" when empty,
//     "Couldn't load suggestions." on error.
// ---------------------------------------------------------------------------
function AddressAutocomplete({
  value,
  onChange,
  onPick,
  disabled,
  inputId,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (result: GeocodeResult) => void;
  disabled?: boolean;
  inputId?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<GeocodeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [debouncedValue, setDebouncedValue] = useState(value);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setTimeout(
      () => setDebouncedValue(value),
      GEOCODE_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(t);
  }, [value]);

  useEffect(() => {
    const trimmed = debouncedValue.trim();
    if (trimmed.length < GEOCODE_MIN_QUERY_LENGTH) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSuggestions([]);
      setLoading(false);
      setHasError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setHasError(false);
    void apiFetch(`/api/geocode/search?q=${encodeURIComponent(trimmed)}`)
      .then(async (res) => {
        if (cancelled) return;
        const data = (await res.json().catch(() => null)) as
          | { results?: GeocodeResult[] }
          | null;
        if (!res.ok) {
          setHasError(true);
          setSuggestions([]);
          return;
        }
        setSuggestions(Array.isArray(data?.results) ? data.results : []);
      })
      .catch(() => {
        if (cancelled) return;
        setHasError(true);
        setSuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedValue]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shouldShowDropdown =
    open &&
    (loading ||
      hasError ||
      suggestions.length > 0 ||
      debouncedValue.trim().length >= GEOCODE_MIN_QUERY_LENGTH);

  return (
    <div ref={wrapRef} className="relative">
      <Input
        id={inputId}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (value.trim().length >= GEOCODE_MIN_QUERY_LENGTH) {
            setOpen(true);
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={500}
        required
        autoComplete="off"
      />
      {shouldShowDropdown && (
        <div
          role="listbox"
          aria-label="Address suggestions"
          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
        >
          {loading && (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Searching…
            </p>
          )}
          {!loading && hasError && (
            <p className="px-3 py-2 text-xs text-destructive">
              Couldn&apos;t load suggestions. Try again or enter the
              address manually.
            </p>
          )}
          {!loading && !hasError && suggestions.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No matches. You can still enter the address manually.
            </p>
          )}
          {!loading &&
            !hasError &&
            suggestions.map((s, i) => (
              <button
                key={`${s.latitude},${s.longitude},${i}`}
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => {
                  onPick(s);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              >
                <MapPin
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1">{s.formatted}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
