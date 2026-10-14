import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeftRight,
  Cable,
  ClipboardPaste,
  FolderInput,
  FolderTree,
  Fullscreen,
  Keyboard,
  LifeBuoy,
  Monitor,
  MonitorPlay,
  Network,
  RadioTower,
  Search,
  Settings,
  SquareTerminal,
  Terminal,
  X,
} from "lucide-react";
import { overlayDismiss, cn } from "../lib/utils";

interface Topic {
  id: string;
  title: string;
  icon: typeof Terminal;
  /** What the feature is for, in a sentence or two. */
  what: string;
  /** How to use it, step by step. */
  how: ReactNode[];
  tips?: ReactNode[];
}

const Key = ({ children }: { children: ReactNode }) => (
  <kbd className="rounded border border-edge bg-bg-elev px-1.5 py-px font-mono text-[10.5px] text-ink-hi">
    {children}
  </kbd>
);

const TOPICS: Topic[] = [
  {
    id: "start",
    title: "Getting started",
    icon: LifeBuoy,
    what: "Dshh keeps your servers as saved sessions in the sidebar and opens each one in a tab — SSH, SFTP, FTP, Telnet, Serial, VNC or a local shell, all inside this one app.",
    how: [
      <>Press <b>+</b> at the top of the sidebar, pick a protocol, and fill in the host, port, user and how to log in.</>,
      <>Save it, then <b>double-click</b> it in the sidebar to open it in a new tab.</>,
      <>Type in the sidebar's filter box (<Key>Ctrl+Shift+P</Key>) to find a session by name, host, tag or group; <Key>*</Key> works as a wildcard.</>,
      <>Click a tab to switch to it; hover a tab for its split-pane and close buttons.</>,
    ],
    tips: [
      "If a server rejects the saved password, Dshh asks again instead of leaving a dead tab — and keeps the one that works.",
    ],
  },
  {
    id: "groups",
    title: "Saved sessions & groups",
    icon: FolderInput,
    what: "Groups fold related sessions together in the sidebar — Production, Lab, a customer — so a long list stays easy to scan.",
    how: [
      <>Hover a saved session and click the <b>folder</b> button to put it in a group: pick an existing group from the list, or type a new name and choose <b>Create</b>.</>,
      <>The same picker is the <b>Group</b> field when you add or edit a connection. <b>No group</b> takes it out again.</>,
      "Click a group's header to fold or unfold it.",
      <>The other hover buttons <b>edit</b>, <b>duplicate</b> and <b>delete</b> the session; on SSH sessions one more opens its files over SFTP.</>,
    ],
    tips: [
      "Give a session an accent colour in its form (red for production, say): it marks the sidebar row, its tab and its toolbar.",
      "Settings › General can start every group folded.",
    ],
  },
  {
    id: "terminal",
    title: "SSH & terminals",
    icon: Terminal,
    what: "A full terminal for SSH, Telnet, Serial and local shells, with search, logging and highlighting built in.",
    how: [
      <>Right-click copies the selection, or pastes when nothing is selected. Pasting two or more lines asks first and lists them — every line break is an Enter.</>,
      <><Key>Ctrl+F</Key> searches the scrollback; <b>Log</b> writes the session to a file as it runs; the save button saves the whole scrollback.</>,
      <><Key>Ctrl</Key>+scroll zooms the text; <Key>Ctrl+0</Key> resets it. The zoom is remembered per connection.</>,
      <>SSH logins can use a password, a key file, or <b>agent</b> (Windows OpenSSH agent, then Pageant). A <b>jump host</b> in the form reaches servers behind a bastion.</>,
      <>On an SSH tab, <b>Files</b> opens the server over SFTP, <b>Tunnels</b> sets up port forwarding and <b>SCP</b> copies single files where SFTP is turned off.</>,
    ],
    tips: [
      "Settings › Output & logs colours keywords such as fatal, refused or timeout as they scroll by.",
    ],
  },
  {
    id: "local",
    title: "Local terminal",
    icon: SquareTerminal,
    what: "Command Prompt, PowerShell, Git Bash or WSL in a tab, next to your remote sessions.",
    how: [
      <>Click the terminal button with the small arrow at the top of the sidebar and pick a shell.</>,
      <>The <b>Administrator</b> entries ask Windows for permission (UAC) and open in a separate window — an elevated shell can't share this app's window.</>,
      <>To keep one, save a connection with protocol <b>Local</b>, its shell and starting folder.</>,
    ],
  },
  {
    id: "serial",
    title: "Serial & Telnet",
    icon: Cable,
    what: "Console ports on switches, routers and boards over a COM port, and old-style Telnet devices.",
    how: [
      <>Add a connection with protocol <b>Serial</b>, choose the COM port (refresh the list if you just plugged it in) and the baud rate.</>,
      <>For Telnet, add a <b>Telnet</b> connection with the host and port (23 by default).</>,
    ],
  },
  {
    id: "files",
    title: "Files (SFTP & FTP)",
    icon: FolderTree,
    what: "Browse, upload, download and edit files on a server, one file or hundreds at a time.",
    how: [
      <>Open an SFTP or FTP connection, or <b>Files</b> on an SSH tab. Type a path in the path bar and press <Key>Enter</Key> to jump there.</>,
      "Drag files from Explorer onto the list to upload them. Double-click a file to open it in your local editor — every save uploads it back.",
      <>The filter box narrows the folder as you type; <Key>Enter</Key> searches every subfolder on the server.</>,
      "Click a column header, or the sort menu, to sort; the same menu groups files by type, date or size.",
      <>Tick files (or <Key>Ctrl</Key>/<Key>Shift</Key>+click, <Key>Ctrl+A</Key>) to download, delete, change permissions or, over SFTP, owner and group — all at once. <Key>Del</Key> deletes, <Key>Esc</Key> clears the selection.</>,
    ],
  },
  {
    id: "split",
    title: "Split view & server-to-server copy",
    icon: ArrowLeftRight,
    what: "See two sessions side by side, or copy files straight between two servers without them passing through your PC.",
    how: [
      <>Hover a tab and click its <b>split</b> button to show it on the right half next to the active tab; click again to close the split.</>,
      <>In a file browser, the <b>split view</b> button (far left of its toolbar) opens a second pane with this PC — or, from its source menu, another saved server.</>,
      "Drag files between the two panes. Server to server, the first server fetches them itself (sftp or curl over SSH), with progress and a Stop that really stops it.",
    ],
  },
  {
    id: "fullscreen",
    title: "Full screen",
    icon: Fullscreen,
    what: "Give the open session the whole monitor — any kind of session, and both halves of a split view.",
    how: [
      <>Press <Key>Ctrl+Alt+Enter</Key>, or the full-screen button at the right end of the tab bar or in any session's toolbar.</>,
      "The sidebar, tab bar and bottom bar step aside; each session keeps its own toolbar.",
      "Touch the very top edge of the screen with the mouse to slide the tab bar down — to switch sessions or leave full screen.",
      <>Press <Key>Ctrl+Alt+Enter</Key> again to go back. It never reaches the remote machine.</>,
    ],
    tips: ["A VNC screen goes edge to edge; its controls slide down with the tab bar."],
  },
  {
    id: "broadcast",
    title: "Broadcast, quick commands & macros",
    icon: RadioTower,
    what: "Type once, run on many servers; keep the commands you use every day one click away.",
    how: [
      <><b>Broadcast</b> on a terminal toolbar sends what you type to every connected terminal at once. Click it again to stop.</>,
      <>The bottom bar's compose box (<Key>Ctrl+K</Key>) sends a line to the active terminal, or to all of them while broadcasting.</>,
      "Quick command chips in the bottom bar send a saved command with one click.",
      <><b>Macro</b> on a terminal records the commands you type; name it, and replay it into any session from its chip.</>,
    ],
  },
  {
    id: "tunnels",
    title: "Port forwarding",
    icon: Network,
    what: "Reach services behind a server (local forward), expose one of yours to it (remote forward), or browse through it (dynamic SOCKS proxy).",
    how: [
      <>On an SSH tab click <b>Tunnels</b>, add a forward — local (<code>ssh -L</code>), remote (<code>ssh -R</code>) or dynamic (<code>ssh -D</code>) — and start it.</>,
      "Each tunnel shows live byte counters, so you can tell a busy one from an idle one.",
    ],
  },
  {
    id: "vnc",
    title: "VNC remote desktop",
    icon: Monitor,
    what: "A remote machine's screen in a tab, with keyboard, mouse and clipboard.",
    how: [
      <>Add a connection with protocol <b>VNC</b>: host, port (5900) and the VNC password. <b>Route through</b> a saved SSH session to tunnel it.</>,
      <><b>Fit</b> scales the screen to the tab; click for 1:1, or <Key>Ctrl</Key>+scroll to zoom.</>,
      <><b>View only</b> watches without sending keys or mouse; <b>Ctrl+Alt+Del</b> sends that combination to the machine.</>,
      "While the screen has focus every key goes to the remote machine — Tab, F5, Windows shortcuts included.",
    ],
  },
  {
    id: "console",
    title: "VM console links",
    icon: MonitorPlay,
    what: "Open an OpenStack or Huawei FusionSphere VM console link (vnc_auto.html?token=…) in a tab — no browser needed.",
    how: [
      <>Copy the console link, click the <b>monitor</b> button at the top of the sidebar — it picks the link up from the clipboard — and press <b>Open console</b>.</>,
      "To keep the proxy, save it as a VNC connection in console mode (its host can be picked from a saved SSH session); then only the token is asked for each time.",
      "An open console stays connected while the tab is open, even untouched. If it drops, Dshh reconnects with the same token while the proxy still accepts it, and asks for a fresh link once it doesn't.",
    ],
  },
  {
    id: "vnctext",
    title: "Paste & copy text on VNC",
    icon: ClipboardPaste,
    what: "Get text into a machine that has no clipboard (BIOS, Linux console, login screen) — and back out of it.",
    how: [
      <><b>Paste</b> opens your clipboard in a box you can edit first. It shows how many Enters it will press and which characters a US keyboard can't type. <b>Type it</b> (<Key>Ctrl+Enter</Key>) types it in; <b>Send as clipboard</b> is for machines that share one.</>,
      <><b>Copy text</b>, then drag a box over the text on the remote screen. Windows reads it (OCR); check and fix it in the box, then <b>Copy</b> puts it on your clipboard. <Key>Esc</Key> cancels.</>,
    ],
    tips: ["OCR can mix up 0/O, 1/l/I and spacing — that's what the check box is for."],
  },
  {
    id: "settings",
    title: "Settings, security & updates",
    icon: Settings,
    what: "Make Dshh yours, protect saved passwords, and keep it current.",
    how: [
      <><b>General</b>: password retry, session colours and status bar, groups, updates, and the window backdrop (Mica or acrylic on Windows 11).</>,
      <><b>Terminal</b>: font, size, colour theme, scrollback, and the multi-line paste warning.</>,
      <><b>Output &amp; logs</b>: keyword highlighting and where session logs are written.</>,
      <><b>Security</b>: a master password that encrypts saved passwords, and a sessions folder that mirrors your connections to <code>connections.json</code> — also how you carry them to another PC.</>,
    ],
    tips: [
      "Dshh is portable: settings live in the data folder next to dshh.exe, so the whole folder can be copied to another machine.",
    ],
  },
  {
    id: "keys",
    title: "Keyboard shortcuts",
    icon: Keyboard,
    what: "The shortcuts Dshh adds. Inside a terminal or a VNC screen, other keys go to the remote side.",
    how: [],
  },
];

const SHORTCUTS: [string, string][] = [
  ["Ctrl+Alt+Enter", "Full screen on / off"],
  ["Ctrl+Shift+P", "Filter saved sessions"],
  ["Ctrl+K", "Compose a command in the bottom bar"],
  ["Ctrl+F", "Search the terminal's scrollback"],
  ["Ctrl + scroll", "Zoom the terminal, file list or VNC screen"],
  ["Ctrl+0", "Reset the zoom"],
  ["Ctrl+A", "Select every file in the folder"],
  ["Del", "Delete the selected files"],
  ["Esc", "Clear the selection, close a dialog, cancel Copy text"],
  ["Ctrl+Enter", "Type / copy from the VNC Paste and Copy text boxes"],
];

/** Plain text of a topic, for the search box. */
function topicText(t: Topic): string {
  const flat = (n: ReactNode): string =>
    typeof n === "string"
      ? n
      : Array.isArray(n)
        ? n.map(flat).join(" ")
        : n && typeof n === "object" && "props" in n
          ? flat((n as { props: { children?: ReactNode } }).props.children)
          : "";
  const extra = t.id === "keys" ? SHORTCUTS.flat().join(" ") : "";
  return [t.title, t.what, ...t.how.map(flat), ...(t.tips ?? []).map(flat), extra]
    .join(" ")
    .toLowerCase();
}

/** What each feature does and how to use it, opened from Settings. */
export function HelpModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(TOPICS[0].id);
  const texts = useMemo(() => new Map(TOPICS.map((t) => [t.id, topicText(t)])), []);
  const q = query.trim().toLowerCase();
  const shown = q
    ? TOPICS.filter((t) => q.split(/\s+/).every((w) => texts.get(t.id)!.includes(w)))
    : TOPICS;
  const topic = shown.find((t) => t.id === selected) ?? shown[0];

  return (
    <div className="modal-overlay" {...overlayDismiss(onClose)}>
      <div
        className="modal-shell flex h-[78vh] w-[860px] max-w-[94vw] flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-edge px-5 py-3">
          <div className="flex items-center gap-2">
            <LifeBuoy size={15} className="text-accent" />
            <h2 className="text-sm font-semibold text-ink-hi">Help — what Dshh can do</h2>
          </div>
          <button onClick={onClose} className="tb-btn" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-60 shrink-0 flex-col border-r border-edge">
            <div className="p-2">
              <div className="flex items-center gap-2 rounded-md border border-edge bg-bg-inset px-2 py-1.5 focus-within:border-accent/60">
                <Search size={12} className="shrink-0 text-ink-dim" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search help"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent text-[12px] text-ink-hi outline-none placeholder:text-ink-dim"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {shown.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelected(t.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition",
                    t.id === topic?.id
                      ? "bg-accent/15 text-ink-hi"
                      : "text-ink-mid hover:bg-bg-hover hover:text-ink-hi"
                  )}
                >
                  <t.icon size={14} className={t.id === topic?.id ? "text-accent" : "text-ink-dim"} />
                  <span className="truncate">{t.title}</span>
                </button>
              ))}
              {shown.length === 0 && (
                <div className="px-2.5 py-2 font-mono text-[11px] text-ink-dim">nothing matches</div>
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
            {topic && (
              <article className="max-w-[560px] space-y-4 text-[13px] leading-relaxed text-ink-mid">
                <div className="flex items-center gap-2.5">
                  <topic.icon size={18} className="text-accent" />
                  <h3 className="text-base font-semibold text-ink-hi">{topic.title}</h3>
                </div>
                <p className="text-ink-hi">{topic.what}</p>
                {topic.how.length > 0 && (
                  <div>
                    <div className="micro-label mb-2">How to use it</div>
                    <ol className="space-y-2">
                      {topic.how.map((step, i) => (
                        <li key={i} className="flex gap-3">
                          <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-elev font-mono text-[10px] text-ink-dim">
                            {i + 1}
                          </span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {topic.id === "keys" && (
                  <table className="w-full border-separate border-spacing-y-1.5">
                    <tbody>
                      {SHORTCUTS.map(([keys, does]) => (
                        <tr key={keys}>
                          <td className="w-40 pr-4 align-top">
                            <Key>{keys}</Key>
                          </td>
                          <td>{does}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {topic.tips && (
                  <div className="rounded-lg border border-edge bg-bg-inset px-4 py-3">
                    <div className="micro-label mb-1.5">Good to know</div>
                    <ul className="list-disc space-y-1 pl-4">
                      {topic.tips.map((tip, i) => (
                        <li key={i}>{tip}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
