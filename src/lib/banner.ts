import type { Connection, Protocol } from "./types";

/**
 * MobaXterm's login banner, rebuilt for Dshh: a boxed, coloured summary of what
 * this tab is attached to, printed into the terminal the moment the session
 * comes up.
 *
 * It is written as terminal text rather than app chrome on purpose — it scrolls
 * away with the session it describes, so a long-lived tab isn't permanently
 * spending rows on it, and it lands in a saved log where it dates the transcript.
 */

/** SGR helpers. Colours are the palette's own 16, so every theme stays coherent. */
const DIM = "\x1b[38;5;244m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

interface BannerRow {
  label: string;
  value: string;
  /** SGR prefix for the value; the label is always dim. */
  color?: string;
}

/** Printable width of a string once SGR sequences are stripped. */
function width(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

const PROTOCOL_TITLES: Record<Protocol, string> = {
  ssh: "SSH session to",
  sftp: "SFTP session to",
  ftp: "FTP session to",
  telnet: "Telnet session to",
  serial: "Serial session on",
  local: "Local shell",
  vnc: "VNC session to",
};

/** The lines of the connect banner, without trailing newlines. */
export function connectBanner(conn: Connection, protocol: Protocol): string[] {
  const target =
    protocol === "serial"
      ? String(conn.serialPort ?? "serial port")
      : protocol === "local"
        ? (conn.shell ?? "shell")
        : `${conn.username ? `${conn.username}@` : ""}${conn.host ?? ""}`;

  const rows: BannerRow[] = [];
  if (protocol === "serial") {
    rows.push({ label: "baud", value: String(conn.baudRate ?? 9600) });
  } else if (protocol === "local") {
    if (conn.cwd) rows.push({ label: "folder", value: conn.cwd });
    if (conn.admin) rows.push({ label: "elevated", value: "yes", color: YELLOW });
  } else {
    rows.push({ label: "port", value: String(conn.port ?? "") });
    rows.push({ label: "auth", value: conn.authMethod ?? "password" });
    if (conn.jumpHost) {
      rows.push({
        label: "jump host",
        value: `${conn.jumpUsername ? `${conn.jumpUsername}@` : ""}${conn.jumpHost}:${conn.jumpPort ?? 22}`,
        color: YELLOW,
      });
    }
  }
  const forwards = conn.tunnels?.length ?? 0;
  if (forwards) {
    rows.push({
      label: "forwards",
      value: `${forwards} saved`,
      color: YELLOW,
    });
  }
  if (conn.runOnConnect?.trim()) {
    rows.push({ label: "on login", value: conn.runOnConnect.trim(), color: YELLOW });
  }

  const headline = `${CYAN}▸ ${PROTOCOL_TITLES[protocol]} ${YELLOW}${target}${RESET}`;
  // Labels are padded to one column so the values line up under each other.
  const labelWidth = Math.max(0, ...rows.map((r) => r.label.length));
  const detail = rows.map(
    (r) =>
      `   ${DIM}${r.label.padEnd(labelWidth)} :${RESET} ${r.color ?? GREEN}${r.value}${RESET}`
  );

  // No product masthead: the app's own name and version are already in the
  // window, and a session that scrolls this back wants the target, not an ad.
  const body = [headline, ...detail];
  const inner = Math.max(...body.map(width)) + 2;
  const pad = (line: string) =>
    `${DIM}│${RESET} ${line}${" ".repeat(Math.max(0, inner - width(line) - 1))}${DIM}│${RESET}`;

  return [
    `${DIM}┌${"─".repeat(inner)}┐${RESET}`,
    ...body.map(pad),
    `${DIM}└${"─".repeat(inner)}┘${RESET}`,
  ];
}
