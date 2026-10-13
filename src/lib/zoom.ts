import { useEffect, useRef } from "react";
import { useStore } from "../store";
import type { Connection } from "./types";

/**
 * Wheel travel per zoom step: one mouse notch, which is 100px in WebView2.
 * A touchpad pinch arrives as many small Ctrl+wheel events and accumulates.
 */
const STEP_DELTA = 100;

/**
 * Turn Ctrl+wheel events into whole zoom steps (+1 in, -1 out), carrying
 * the remainder so touchpads zoom smoothly instead of in jumps.
 */
export function wheelSteps(acc: { v: number }, e: WheelEvent): number {
  const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
  acc.v += -e.deltaY * unit;
  const steps = Math.trunc(acc.v / STEP_DELTA);
  acc.v -= steps * STEP_DELTA;
  return steps;
}

/**
 * Save a zoom level to the connection once the wheel goes quiet, rather
 * than rewriting the saved list on every notch. A level still waiting when
 * the tab closes is saved then.
 */
export function useSaveConnectionPref(connId: string) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Partial<Connection> | null>(null);
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current) {
      useStore.getState().setConnectionPrefs(connId, pending.current);
      pending.current = null;
    }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);
  return (patch: Partial<Connection>) => {
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  };
}
