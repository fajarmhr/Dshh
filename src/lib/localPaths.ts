/** Characters Windows won't allow in a file name, swapped for "_" on download. */
export const safeLocalName = (name: string) => name.replace(/[<>:"|?*\\\x00-\x1f]/g, "_");

/**
 * Where a remote entry lands when a selection is downloaded into `dir`: under
 * its selected root's own name, keeping the folder structure below it —
 * `/srv/site/assets/app.js` with `/srv/site` selected becomes
 * `<dir>\site\assets\app.js`.
 */
export function downloadPath(
  dir: string,
  roots: { path: string; name: string }[],
  remotePath: string
): string {
  const sep = /^[A-Za-z]:/.test(dir) || dir.includes("\\") ? "\\" : "/";
  const root = roots.find((r) => remotePath === r.path || remotePath.startsWith(`${r.path}/`));
  const rel = root
    ? root.name + remotePath.slice(root.path.length)
    : remotePath.split("/").pop() ?? remotePath;
  const parts = rel.split("/").filter(Boolean).map(safeLocalName);
  return dir.replace(/[\\/]+$/, "") + sep + parts.join(sep);
}
