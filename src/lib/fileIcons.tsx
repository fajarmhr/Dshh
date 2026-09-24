import type { LucideIcon } from "lucide-react";
import {
  File,
  FileArchive,
  FileCode2,
  FileCog,
  FileImage,
  FileJson2,
  FileKey2,
  FileMusic,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType2,
  FileVideo,
} from "lucide-react";

/**
 * Extension → icon, colour and the category a file groups under ("Group by
 * type" in the file browser). One table, so an extension's icon and its group
 * can never disagree.
 */
const GROUPS: [LucideIcon, string, string, string[]][] = [
  [
    FileCode2,
    "text-accent",
    "Code",
    ["js", "jsx", "ts", "tsx", "rs", "py", "go", "c", "h", "cpp", "hpp", "cc",
     "java", "kt", "swift", "rb", "php", "cs", "vue", "svelte", "lua", "sql",
     "html", "htm", "css", "scss", "less"],
  ],
  [FileTerminal, "text-proto-local", "Scripts", ["sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd"]],
  [FileJson2, "text-warn", "Data", ["json", "jsonc", "json5"]],
  [
    FileCog,
    "text-ink-mid",
    "Config",
    ["yml", "yaml", "toml", "ini", "conf", "cfg", "env", "xml", "plist", "service", "lock"],
  ],
  [FileText, "text-ink-mid", "Documents", ["txt", "md", "rst", "log", "rtf", "doc", "docx", "odt"]],
  [FileText, "text-err", "Documents", ["pdf"]],
  [
    FileArchive,
    "text-warn",
    "Archives",
    ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "tgz", "iso", "deb", "rpm", "jar"],
  ],
  [
    FileImage,
    "text-proto-serial",
    "Images",
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "tiff"],
  ],
  [FileMusic, "text-err", "Audio", ["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"]],
  [FileVideo, "text-err", "Video", ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv"]],
  [FileSpreadsheet, "text-ok", "Spreadsheets", ["xls", "xlsx", "csv", "tsv", "ods"]],
  [
    FileKey2,
    "text-warn",
    "Keys & certificates",
    ["pem", "key", "crt", "cer", "pub", "pfx", "p12", "asc", "gpg", "ppk"],
  ],
  [FileType2, "text-ink-mid", "Fonts", ["ttf", "otf", "woff", "woff2"]],
];

/** Category for anything the table doesn't know, including extensionless files. */
export const OTHER_CATEGORY = "Other";

const BY_EXT = new Map<string, { Icon: LucideIcon; cls: string; category: string }>();
for (const [Icon, cls, category, exts] of GROUPS) {
  for (const ext of exts) BY_EXT.set(ext, { Icon, cls, category });
}

/** Lower-cased extension without the dot; "" for none. A leading dot (".bashrc") is not one. */
export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileIconFor(name: string): { Icon: LucideIcon; cls: string } {
  return BY_EXT.get(extOf(name)) ?? { Icon: File, cls: "text-ink-dim" };
}

export function fileCategory(name: string): string {
  return BY_EXT.get(extOf(name))?.category ?? OTHER_CATEGORY;
}

export function FileTypeIcon({ name, size = 15 }: { name: string; size?: number }) {
  const { Icon, cls } = fileIconFor(name);
  return <Icon size={size} className={`shrink-0 ${cls}`} />;
}
