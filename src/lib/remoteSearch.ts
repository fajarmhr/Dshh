import type { Listing, RemoteFile } from "./types";
import { buildFilter } from "./utils";

/**
 * Recursive file-name search over a remote tree, built on the same listing
 * command the browser already uses — a breadth-first walk, so nearby matches
 * show up first and a stopped search has still covered the closest folders.
 */

/** Enough to scan through by eye; past this the query wants narrowing, not paging. */
export const MAX_RESULTS = 2000;
/** Guards a walk started at `/` on a big server from running all afternoon. */
export const MAX_DIRS = 20000;
/** Symlinks aren't followed, so this only catches pathological nesting. */
const MAX_DEPTH = 24;
/**
 * Kernel pseudo-filesystems: huge, unreadable in places, and never where a
 * file you're looking for lives. Skipped when reached by recursion only — a
 * search started inside one still searches it.
 */
const SKIP_DIRS = new Set(["/proc", "/sys", "/dev", "/run"]);
/** Progress pushed to the UI at most this often. */
const PAINT_MS = 150;

export interface SearchProgress {
  results: RemoteFile[];
  /** Folders listed so far. */
  scanned: number;
  /** Folders the server refused to list (permissions, vanished mid-walk). */
  failed: number;
  /** Folder being listed, for the "searching in …" line. */
  current: string;
}

export type SearchEnd = "done" | "cancelled" | "limit";

export async function searchTree({
  root,
  query,
  list,
  concurrency,
  isCancelled,
  onProgress,
}: {
  root: string;
  query: string;
  list: (path: string) => Promise<Listing>;
  /** Listings in flight at once. SFTP pipelines requests; FTP has one control channel. */
  concurrency: number;
  isCancelled: () => boolean;
  onProgress: (p: SearchProgress) => void;
}): Promise<SearchProgress & { end: SearchEnd }> {
  const match = buildFilter(query);
  const results: RemoteFile[] = [];
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  const seen = new Set<string>([root]);
  let scanned = 0;
  let failed = 0;
  let current = root;
  let active = 0;
  let painted = 0;

  const atLimit = () => results.length >= MAX_RESULTS || scanned >= MAX_DIRS;
  const snapshot = (): SearchProgress => ({
    results: results.slice(0, MAX_RESULTS),
    scanned,
    failed,
    current,
  });
  const paint = () => {
    if (Date.now() - painted < PAINT_MS) return;
    painted = Date.now();
    onProgress(snapshot());
  };

  const worker = async () => {
    for (;;) {
      if (isCancelled() || atLimit()) return;
      const job = queue.shift();
      if (!job) {
        // Queue drained, but a listing still in flight may refill it.
        if (active === 0) return;
        await new Promise((r) => setTimeout(r, 15));
        continue;
      }
      active++;
      current = job.path;
      paint();
      try {
        // A listing that lands after a stop is still counted: it cost the
        // round trip already. The loop's own check stops anything new.
        const listing = await list(job.path);
        scanned++;
        for (const f of listing.files) {
          if (!match || match(f.name)) results.push(f);
          if (
            f.isDir &&
            job.depth < MAX_DEPTH &&
            !seen.has(f.path) &&
            !SKIP_DIRS.has(f.path)
          ) {
            seen.add(f.path);
            queue.push({ path: f.path, depth: job.depth + 1 });
          }
        }
      } catch {
        failed++;
      } finally {
        active--;
      }
      paint();
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  const end: SearchEnd = isCancelled() ? "cancelled" : atLimit() ? "limit" : "done";
  return { ...snapshot(), current: "", end };
}
