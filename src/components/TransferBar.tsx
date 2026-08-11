import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import type { TransferProgress } from "../lib/api";
import { formatBytes } from "../lib/utils";

/** A transfer in flight, as tracked by the file browser and the SCP dialog. */
export interface Transfer extends TransferProgress {
  /** File being moved; shown as-is. */
  name: string;
  dir: "up" | "down";
  /** Position in a multi-file batch, e.g. `[2, 5]`. Omitted for a single file. */
  batch?: [number, number];
}

/**
 * Progress bar for one file transfer. A server that won't report a size gives
 * `total: 0` — the bar then runs as an indeterminate sweep and the label falls
 * back to bytes moved so far, because a percentage would be a lie.
 *
 * Framing is the caller's: this draws the row only, so it can sit in a status
 * strip or inside a dialog without a doubled border.
 */
export function TransferBar({ transfer }: { transfer: Transfer }) {
  const { name, dir, done, total, batch } = transfer;
  const known = total > 0;
  const pct = known ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const Icon = dir === "up" ? ArrowUpFromLine : ArrowDownToLine;

  return (
    <div className="px-3 py-1.5">
      <div className="flex items-center gap-2 font-mono text-[10.5px] text-ink-mid">
        <Icon size={11} className="shrink-0 text-accent" />
        <span className="truncate text-ink-hi">{name}</span>
        {batch && (
          <span className="shrink-0 text-ink-dim">
            {batch[0]}/{batch[1]}
          </span>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-ink-dim">
          {known ? `${formatBytes(done)} / ${formatBytes(total)}` : formatBytes(done)}
        </span>
        {known && <span className="w-9 shrink-0 text-right tabular-nums">{pct}%</span>}
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-inset">
        {known ? (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-transfer-sweep rounded-full bg-accent" />
        )}
      </div>
    </div>
  );
}
