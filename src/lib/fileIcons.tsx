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

/** Extension → icon+color for the file browser panes. */
const GROUPS: [LucideIcon, string, string[]][] = [
  [
    FileCode2,
    "text-accent",
    ["js", "jsx", "ts", "tsx", "rs", "py", "go", "c", "h", "cpp", "hpp", "cc",
     "java", "kt", "swift", "rb", "php", "cs", "vue", "svelte", "lua", "sql",
     "html", "htm", "css", "scss", "less"],
  ],
  [FileTerminal, "text-proto-local", ["sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd"]],
  [FileJson2, "text-warn", ["json", "jsonc", "json5"]],
  [
    FileCog,
    "text-ink-mid",
    ["yml", "yaml", "toml", "ini", "conf", "cfg", "env", "xml", "plist", "service", "lock"],
  ],
  [FileText, "text-ink-mid", ["txt", "md", "rst", "log", "rtf", "doc", "docx", "odt"]],
  [FileText, "text-err", ["pdf"]],
  [
    FileArchive,
    "text-warn",
    ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "tgz", "iso", "deb", "rpm", "jar"],
  ],
  [
    FileImage,
    "text-proto-serial",
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "tiff"],
  ],
  [FileMusic, "text-err", ["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"]],
  [FileVideo, "text-err", ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv"]],
  [FileSpreadsheet, "text-ok", ["xls", "xlsx", "csv", "tsv", "ods"]],
  [FileKey2, "text-warn", ["pem", "key", "crt", "cer", "pub", "pfx", "p12", "asc", "gpg", "ppk"]],
  [FileType2, "text-ink-mid", ["ttf", "otf", "woff", "woff2"]],
];

const BY_EXT = new Map<string, { Icon: LucideIcon; cls: string }>();
for (const [Icon, cls, exts] of GROUPS) {
  for (const ext of exts) BY_EXT.set(ext, { Icon, cls });
}

export function fileIconFor(name: string): { Icon: LucideIcon; cls: string } {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return BY_EXT.get(ext) ?? { Icon: File, cls: "text-ink-dim" };
}

export function FileTypeIcon({ name, size = 15 }: { name: string; size?: number }) {
  const { Icon, cls } = fileIconFor(name);
  return <Icon size={size} className={`shrink-0 ${cls}`} />;
}
