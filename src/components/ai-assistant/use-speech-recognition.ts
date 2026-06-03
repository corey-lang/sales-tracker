"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Minimal typings for the Web Speech API. The webkit-prefixed constructor and
// (on some targets) the unprefixed one are not in the standard lib.dom types,
// so we describe only the surface we use and treat `window` as untrusted.

type SpeechRecognitionAlternativeLike = { transcript: string };

type SpeechRecognitionResultLike = {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
};

type SpeechRecognitionResultListLike = {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
};

type SpeechRecognitionEventLike = {
  readonly results: SpeechRecognitionResultListLike;
};

type SpeechRecognitionErrorEventLike = { readonly error?: string };

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Resolves the platform's SpeechRecognition constructor, or null when the
 *  browser doesn't support the Web Speech API (e.g. iOS Safari/PWA). */
function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type UseSpeechRecognitionOptions = {
  /** Called with the full transcript of the current utterance as it grows.
   *  Never auto-sends — the caller decides what to do with the text. */
  onTranscript: (fullTranscript: string) => void;
  /** Called with a user-safe message when recognition fails. */
  onError?: (message: string) => void;
};

/**
 * Thin wrapper around the Web Speech API for one-shot voice-to-text.
 *
 * - `supported` is resolved on mount (client-only) to avoid SSR hydration
 *   mismatch; render the mic affordance off this flag.
 * - Microphone permission is NOT requested until `start()` is called (the
 *   browser prompts on `recognition.start()`), satisfying the "don't ask for
 *   the mic until the user taps it" requirement.
 * - `stop()` ends listening cleanly; the hook also aborts on unmount so a
 *   closing modal never leaves the mic hot.
 */
export function useSpeechRecognition({
  onTranscript,
  onError,
}: UseSpeechRecognitionOptions) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // Keep the latest callbacks in refs so start() doesn't need to be
  // re-created (and event handlers stay current) as the caller re-renders.
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
  }, [onTranscript, onError]);

  useEffect(() => {
    // Client-only capability probe — avoids SSR/CSR hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(getSpeechRecognitionCtor() !== null);
  }, []);

  const stop = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        // already stopped / never started — nothing to do
      }
    }
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      onErrorRef.current?.(
        "Voice input isn't available on this device yet. You can still type your message.",
      );
      return;
    }

    // Abort any in-flight session before starting a fresh one.
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }

    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = true;

    rec.onresult = (event) => {
      // Concatenate every result (interim + final) so the caller always
      // receives the complete utterance-so-far and can replace the typed
      // draft cleanly rather than appending fragments.
      let full = "";
      for (let i = 0; i < event.results.length; i++) {
        const alt = event.results[i]?.[0];
        if (alt?.transcript) full += alt.transcript;
      }
      onTranscriptRef.current(full.trim());
    };

    rec.onerror = (event) => {
      setListening(false);
      // "no-speech" / "aborted" are normal flow (user said nothing or
      // tapped stop) — stay quiet. Surface anything else as a safe message.
      const code = event.error;
      if (code === "no-speech" || code === "aborted") return;
      if (code === "not-allowed" || code === "service-not-allowed") {
        onErrorRef.current?.(
          "Microphone access was blocked. Enable it in your browser settings to use voice input.",
        );
        return;
      }
      onErrorRef.current?.(
        "Voice input didn't work that time. You can try again or type your message.",
      );
    };

    rec.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
      recognitionRef.current = null;
      onErrorRef.current?.(
        "Voice input didn't start. You can try again or type your message.",
      );
    }
  }, []);

  // Belt-and-braces cleanup: abort on unmount so a closing sheet never leaves
  // the microphone listening.
  useEffect(
    () => () => {
      const rec = recognitionRef.current;
      if (rec) {
        try {
          rec.abort();
        } catch {
          // ignore
        }
      }
    },
    [],
  );

  return { supported, listening, start, stop };
}
