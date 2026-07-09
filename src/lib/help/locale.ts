// Lightweight bilingual + "beginner mode" state, both persisted in localStorage.
// Kept dependency-free so the primitives work in any route.
import { useEffect, useState, useCallback } from "react";
import type { Bilingual, Locale } from "./types";

const LOCALE_KEY = "pluto:help:locale";
const BEGINNER_KEY = "pluto:help:beginner";

// Default to Bangla because the initial target market is Bangladesh + South
// Asia; user can flip via BeginnerModeToggle → LocaleSwitch.
const DEFAULT_LOCALE: Locale = "bn";
const DEFAULT_BEGINNER = true;

function readLS<T>(key: string, fallback: T, parse: (v: string) => T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}

function writeLS(key: string, value: string) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
}

// --- locale -----------------------------------------------------------------

export function useLocale(): [Locale, (l: Locale) => void] {
  // SSR-safe: start with default, sync from localStorage after mount to avoid
  // hydration mismatch.
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  useEffect(() => {
    setLocale(readLS(LOCALE_KEY, DEFAULT_LOCALE, (v) => (v === "en" ? "en" : "bn")));
  }, []);
  const update = useCallback((l: Locale) => {
    setLocale(l);
    writeLS(LOCALE_KEY, l);
    window.dispatchEvent(new CustomEvent("pluto:help:locale", { detail: l }));
  }, []);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<Locale>).detail;
      if (d === "bn" || d === "en") setLocale(d);
    };
    window.addEventListener("pluto:help:locale", on);
    return () => window.removeEventListener("pluto:help:locale", on);
  }, []);
  return [locale, update];
}

export function pick(text: Bilingual | undefined, locale: Locale): string {
  if (!text) return "";
  return text[locale] || text.bn || text.en || "";
}

// --- beginner mode ----------------------------------------------------------

export function useBeginnerMode(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(DEFAULT_BEGINNER);
  useEffect(() => {
    setOn(readLS(BEGINNER_KEY, DEFAULT_BEGINNER, (v) => v === "1"));
  }, []);
  const update = useCallback((v: boolean) => {
    setOn(v);
    writeLS(BEGINNER_KEY, v ? "1" : "0");
    window.dispatchEvent(new CustomEvent("pluto:help:beginner", { detail: v }));
  }, []);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<boolean>).detail;
      setOn(Boolean(d));
    };
    window.addEventListener("pluto:help:beginner", on);
    return () => window.removeEventListener("pluto:help:beginner", on);
  }, []);
  return [on, update];
}
