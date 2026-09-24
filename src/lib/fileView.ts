import { extOf, fileCategory, OTHER_CATEGORY } from "./fileIcons";
import type { RemoteFile } from "./types";
import { buildFilter } from "./utils";

/**
 * Sorting, grouping and filtering for the file browser panes. Pure functions
 * over a listing, so the remote and local panes (and recursive search results)
 * all arrange files the same way.
 */

export type SortKey = "name" | "type" | "size" | "modified";
export type SortDir = "asc" | "desc";
export type GroupBy = "none" | "type" | "date" | "size";

export interface FileViewPrefs {
  sortKey: SortKey;
  sortDir: SortDir;
  groupBy: GroupBy;
  /** Keep directories above files whatever the sort. */
  foldersFirst: boolean;
}

export const DEFAULT_VIEW: FileViewPrefs = {
  sortKey: "name",
  sortDir: "asc",
  groupBy: "none",
  foldersFirst: true,
};

export const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  type: "Type",
  size: "Size",
  modified: "Date modified",
};

export const GROUP_LABELS: Record<GroupBy, string> = {
  none: "None",
  type: "Type",
  date: "Date modified",
  size: "Size",
};

/** How each sort key reads its two directions, e.g. "Newest first". */
export const DIR_LABELS: Record<SortKey, Record<SortDir, string>> = {
  name: { asc: "A → Z", desc: "Z → A" },
  type: { asc: "A → Z", desc: "Z → A" },
  size: { asc: "Smallest first", desc: "Largest first" },
  modified: { asc: "Oldest first", desc: "Newest first" },
};

/**
 * The direction a column starts in when first picked. Newest and largest first
 * are what anyone sorting by date or size is looking for.
 */
const FIRST_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  type: "asc",
  size: "desc",
  modified: "desc",
};

/** Clicking the active key flips its direction; any other key starts fresh. */
export function nextSort(prefs: FileViewPrefs, key: SortKey): Partial<FileViewPrefs> {
  return key === prefs.sortKey
    ? { sortDir: prefs.sortDir === "asc" ? "desc" : "asc" }
    : { sortKey: key, sortDir: FIRST_DIR[key] };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural, case-insensitive name order ("file2" before "file10"), stable on ties. */
function byName(a: RemoteFile, b: RemoteFile): number {
  return collator.compare(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function byKey(key: SortKey, a: RemoteFile, b: RemoteFile): number {
  switch (key) {
    case "name":
      return 0;
    case "type":
      // Folders are a type of their own, ahead of every extension.
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.isDir ? 0 : collator.compare(extOf(a.name), extOf(b.name));
    case "size":
      // A directory's reported size (4096 on most Unix servers) says nothing
      // about its contents, so directories rank below every file.
      return (a.isDir ? -1 : a.size) - (b.isDir ? -1 : b.size);
    case "modified":
      return (a.modified ?? 0) - (b.modified ?? 0);
  }
}

export function sortFiles(files: RemoteFile[], prefs: FileViewPrefs): RemoteFile[] {
  const sign = prefs.sortDir === "asc" ? 1 : -1;
  return files.slice().sort((a, b) => {
    if (prefs.foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const primary = byKey(prefs.sortKey, a, b);
    if (primary !== 0) return primary * sign;
    // Name breaks ties, so equal sizes or dates don't reshuffle on refresh.
    // It follows the direction only when name is what's being sorted.
    return byName(a, b) * (prefs.sortKey === "name" ? sign : 1);
  });
}

/** Files whose name matches the query — substring, or wildcard once it has `*`. */
export function filterFiles(files: RemoteFile[], query: string): RemoteFile[] {
  const match = buildFilter(query);
  return match ? files.filter((f) => match(f.name)) : files;
}

export interface FileGroup {
  /** Stable across refreshes, so a collapsed group stays collapsed. */
  key: string;
  label: string;
  files: RemoteFile[];
}

/**
 * Where a file lands when grouped. `order` runs in the dimension's ascending
 * direction (older → newer, smaller → larger); `pin` holds a bucket at the top
 * or bottom whichever way the rest are ordered.
 */
interface Bucket {
  key: string;
  label: string;
  order: number;
  pin?: "first" | "last";
}

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** Explorer's size bands, which people already know how to read. */
const SIZE_BANDS: [number, string][] = [
  [16 * KB, "Tiny (< 16 KB)"],
  [MB, "Small (16 KB – 1 MB)"],
  [128 * MB, "Medium (1 – 128 MB)"],
  [GB, "Large (128 MB – 1 GB)"],
  [4 * GB, "Huge (1 – 4 GB)"],
];

const DAY = 86_400_000;

function dateBucket(modified: number | null, now: Date): Bucket {
  if (!modified) return { key: "none", label: "No date", order: 0, pin: "last" };
  const t = modified * 1000;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= midnight) return { key: "today", label: "Today", order: 6 };
  if (t >= midnight - DAY) return { key: "yesterday", label: "Yesterday", order: 5 };
  if (t >= midnight - 6 * DAY) return { key: "week", label: "Last 7 days", order: 4 };
  if (t >= midnight - 29 * DAY) return { key: "month", label: "Last 30 days", order: 3 };
  if (new Date(t).getFullYear() === now.getFullYear()) {
    return { key: "year", label: "Earlier this year", order: 2 };
  }
  return { key: "older", label: "Older", order: 1 };
}

function bucketOf(groupBy: Exclude<GroupBy, "none">, f: RemoteFile, now: Date): Bucket {
  switch (groupBy) {
    case "type": {
      if (f.isDir) return { key: "dir", label: "Folders", order: 0, pin: "first" };
      const category = fileCategory(f.name);
      return category === OTHER_CATEGORY
        ? { key: category, label: category, order: 0, pin: "last" }
        : { key: category, label: category, order: 0 };
    }
    case "date":
      return dateBucket(f.modified, now);
    case "size": {
      if (f.isDir) return { key: "dir", label: "Folders", order: 0, pin: "first" };
      if (f.size === 0) return { key: "empty", label: "Empty", order: 0 };
      const band = SIZE_BANDS.findIndex(([limit]) => f.size < limit);
      return band === -1
        ? { key: "gigantic", label: "Gigantic (> 4 GB)", order: SIZE_BANDS.length + 1 }
        : { key: `band${band}`, label: SIZE_BANDS[band][1], order: band + 1 };
    }
  }
}

/** The sort key each grouping mirrors, and the way its groups face otherwise. */
const GROUP_AXIS: Record<Exclude<GroupBy, "none">, [SortKey, SortDir]> = {
  type: ["type", "asc"],
  date: ["modified", "desc"],
  size: ["size", "desc"],
};

/**
 * Split an already-sorted list into groups, keeping the sort inside each one.
 * Groups follow the sort direction when grouping and sorting share an axis
 * (date groups oldest-first when sorted oldest-first); otherwise they take the
 * axis's natural reading — today first, largest first, types A → Z.
 */
export function groupFiles(
  sorted: RemoteFile[],
  prefs: FileViewPrefs,
  now: Date = new Date()
): FileGroup[] {
  const { groupBy } = prefs;
  if (groupBy === "none") return [{ key: "all", label: "", files: sorted }];

  const buckets = new Map<string, { bucket: Bucket; files: RemoteFile[] }>();
  for (const f of sorted) {
    const bucket = bucketOf(groupBy, f, now);
    const slot = buckets.get(bucket.key);
    if (slot) slot.files.push(f);
    else buckets.set(bucket.key, { bucket, files: [f] });
  }

  const [axis, naturalDir] = GROUP_AXIS[groupBy];
  const sign = (prefs.sortKey === axis ? prefs.sortDir : naturalDir) === "asc" ? 1 : -1;
  const pinRank = (b: Bucket) => (b.pin === "first" ? -1 : b.pin === "last" ? 1 : 0);
  return [...buckets.values()]
    .sort(
      (x, y) =>
        pinRank(x.bucket) - pinRank(y.bucket) ||
        (x.bucket.order - y.bucket.order) * sign ||
        collator.compare(x.bucket.label, y.bucket.label) * sign
    )
    .map(({ bucket, files }) => ({ key: `${groupBy}:${bucket.key}`, label: bucket.label, files }));
}

/** Filter, sort and group in one pass — what a pane actually renders. */
export function arrangeFiles(
  files: RemoteFile[],
  query: string,
  prefs: FileViewPrefs
): { groups: FileGroup[]; shown: number } {
  const matched = filterFiles(files, query);
  return { groups: groupFiles(sortFiles(matched, prefs), prefs), shown: matched.length };
}

/** Pick only known values out of stored prefs, so a stale or hand-edited entry can't wedge a pane. */
export function sanitizeView(raw: unknown): FileViewPrefs {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
  return {
    sortKey: pick(v.sortKey, ["name", "type", "size", "modified"], DEFAULT_VIEW.sortKey),
    sortDir: pick(v.sortDir, ["asc", "desc"], DEFAULT_VIEW.sortDir),
    groupBy: pick(v.groupBy, ["none", "type", "date", "size"], DEFAULT_VIEW.groupBy),
    foldersFirst: typeof v.foldersFirst === "boolean" ? v.foldersFirst : DEFAULT_VIEW.foldersFirst,
  };
}

/**
 * `path`'s parent directory relative to `root`, for labelling search results:
 * "a/b" for /root/a/b/file, "." for a direct child of root.
 */
export function relativeDir(root: string, path: string): string {
  const parent = path.slice(0, path.lastIndexOf("/"));
  const base = root.replace(/\/+$/, "");
  if (parent === base || parent === "") return ".";
  return parent.startsWith(base + "/") ? parent.slice(base.length + 1) : parent;
}

/** Parent directory of a remote path, "/" at the top. */
export function parentDir(path: string): string {
  return path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
}
