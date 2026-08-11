import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { MouseEvent } from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${units[i]}`;
}

/** Elapsed time in the status bar's compact form: 42s, 7m 05s, 3h 12m. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const p = (n: number) => String(n).padStart(2, "0");
  if (hours) return `${hours}h ${p(minutes)}m`;
  if (minutes) return `${minutes}m ${p(seconds)}s`;
  return `${seconds}s`;
}

/** Compact local timestamp for log filenames, e.g. 20260702-211530. */
export function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Keep a numeric field inside sane bounds. A cleared number input reads as
 * `NaN`, which would otherwise be persisted and break the terminal on reload,
 * so that case falls back to `fallback` rather than to a bound.
 */
export function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Make a connection name safe to embed in a filename. */
export function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "session";
}

/**
 * Backdrop props that dismiss a modal only on a real backdrop press.
 * `onClick` is wrong here: selecting text inside a field and releasing the
 * mouse outside the dialog makes the browser fire click on the backdrop,
 * which closed the dialog mid-edit. Pressing down is the honest signal.
 */
export function overlayDismiss(onClose: () => void) {
  return {
    onMouseDown: (e: MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
  };
}

/**
 * Build a predicate for MobaXterm-style "quick connect" filtering: a plain
 * case-insensitive substring match, upgraded to a wildcard match as soon as
 * the query contains `*` (so `prod-*-01` and `10.0.*` both work).
 *
 * Returns `null` for an empty query, letting callers skip filtering entirely
 * rather than run every row through a match that always succeeds.
 */
export function buildFilter(query: string): ((haystack: string) => boolean) | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  if (!q.includes("*")) return (h) => h.toLowerCase().includes(q);
  const pattern = q
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return (h) => h.toLowerCase().includes(q);
  }
  return (h) => re.test(h.toLowerCase());
}

/**
 * The lines a paste would send, as the shell will see them: CR/CRLF normalised,
 * and one trailing newline dropped — that one submits the last line rather than
 * starting another, so counting it would overstate what runs.
 */
export function splitPasteLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
}

/** Short local date-time for file listings, e.g. "2026-07-03 14:22". */
export function formatDate(epochSeconds: number | null): string {
  if (!epochSeconds) return "—";
  const d = new Date(epochSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
