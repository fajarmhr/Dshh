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

/** Compact local timestamp for log filenames, e.g. 20260702-211530. */
export function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
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

/** Short local date-time for file listings, e.g. "2026-07-03 14:22". */
export function formatDate(epochSeconds: number | null): string {
  if (!epochSeconds) return "—";
  const d = new Date(epochSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
