import { Database, FolderOpen, LifeBuoy, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { nanoid } from "nanoid";
import {
  useStore,
  adoptSessionsDir,
  applyWindowEffect,
  changeMaster,
  disableMaster,
  enableMaster,
  unlockMaster,
  type WindowEffect,
} from "../store";
import {
  appVersion,
  defaultLogDir,
  openUrl,
  portableDataDir,
  updateApply,
  updateCheck,
  updateRestart,
  type UpdateInfo,
} from "../lib/api";
import { THEME_ORDER } from "../lib/themes";
import type { CursorStyle, HighlightColor, HighlightRule } from "../lib/types";
import { clamp, cn, overlayDismiss } from "../lib/utils";
import { HelpModal } from "./HelpModal";

type TabId = "general" | "terminal" | "output" | "security";

const TABS: { id: TabId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "terminal", label: "Terminal" },
  { id: "output", label: "Output & logs" },
  { id: "security", label: "Security" },
];

/**
 * The bundled face, always offered and always last in the stack so a missing
 * system font degrades to something that ships with the app.
 */
const BUNDLED_FONT = "JetBrains Mono Variable";

/**
 * Monospace faces worth offering. Everything except the bundled one is only
 * listed when actually installed — a menu entry that silently falls back to a
 * different face is worse than no entry at all.
 */
const FONT_CANDIDATES = [
  BUNDLED_FONT,
  "Cascadia Code",
  "Cascadia Mono",
  "Consolas",
  "Fira Code",
  "Hack",
  "IBM Plex Mono",
  "JetBrains Mono",
  "Roboto Mono",
  "Source Code Pro",
  "Ubuntu Mono",
  "Courier New",
  "Lucida Console",
];

/** The first family in a CSS font stack, without quotes. */
function primaryFamily(stack: string): string {
  return (stack.split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "");
}

/**
 * Line-height presets. A number input would be the obvious control, but
 * Chromium renders it with the *locale* decimal separator — "1,2" on an
 * Indonesian machine — and a half-typed value parses as garbage. Fixed steps
 * cover every useful spacing anyway.
 */
const LINE_HEIGHTS = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2];

const GENERICS = ["monospace", "serif", "sans-serif"];
const FONT_PROBE = "MMMMMMMMMMlli1234567890";

/**
 * Which of `families` are really installed.
 *
 * `document.fonts.check()` is no use for this: it answers "can this text be
 * rendered", and since fallback always renders, it returns true for every name
 * you give it. The reliable test is to measure a probe string in the candidate
 * face backed by each generic family — an installed font shifts the width away
 * from at least one generic, a missing one matches all three exactly.
 */
function installedFonts(families: string[]): string[] {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return families;
  const baseline = GENERICS.map((g) => {
    ctx.font = `72px ${g}`;
    return ctx.measureText(FONT_PROBE).width;
  });
  return families.filter((family) =>
    GENERICS.some((g, i) => {
      ctx.font = `72px "${family}", ${g}`;
      return ctx.measureText(FONT_PROBE).width !== baseline[i];
    })
  );
}

/** Turn a chosen face into a stack that always has somewhere to fall back to. */
function fontStack(family: string): string {
  const quoted = /\s/.test(family) ? `"${family}"` : family;
  return family === BUNDLED_FONT
    ? `"${BUNDLED_FONT}", monospace`
    : `${quoted}, "${BUNDLED_FONT}", monospace`;
}

const WINDOW_EFFECTS: { id: WindowEffect; label: string; blurb: string }[] = [
  { id: "opaque", label: "Opaque", blurb: "Solid panels — works everywhere." },
  { id: "mica", label: "Mica", blurb: "Desktop wallpaper, softly tinted." },
  { id: "acrylic", label: "Acrylic", blurb: "Blurs whatever sits behind." },
];

const HL_COLORS: Record<HighlightColor, string> = {
  red: "#f26d78",
  yellow: "#e8a54c",
  green: "#3ecf8e",
  blue: "#5b8cff",
  magenta: "#b78af7",
  cyan: "#4cc9e8",
};

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [newPattern, setNewPattern] = useState("");
  const [newColor, setNewColor] = useState<HighlightColor>("red");
  const [sessionsNote, setSessionsNote] = useState("");
  const [effectNote, setEffectNote] = useState("");
  const [tab, setTab] = useState<TabId>("general");
  const [helpOpen, setHelpOpen] = useState(false);

  /** Candidate fonts that are actually present on this machine. */
  const [fonts, setFonts] = useState<string[]>([BUNDLED_FONT]);
  useEffect(() => {
    let alive = true;
    // Wait for the bundled webfonts to load, or they'd measure as missing and
    // be filtered out of their own menu.
    document.fonts.ready.then(() => {
      if (!alive) return;
      const found = installedFonts(FONT_CANDIDATES);
      // The bundled face ships with the app, so it belongs in the list even if
      // the probe is inconclusive about it.
      setFonts(found.includes(BUNDLED_FONT) ? found : [BUNDLED_FONT, ...found]);
    });
    return () => {
      alive = false;
    };
  }, []);

  const currentFont = primaryFamily(settings.fontFamily);
  // Keep a hand-written stack selectable rather than silently replacing it.
  const fontOptions = fonts.includes(currentFont) ? fonts : [currentFont, ...fonts];
  // Likewise for a spacing typed into the old free-number field.
  const lineHeights = LINE_HEIGHTS.includes(settings.lineHeight)
    ? LINE_HEIGHTS
    : [...LINE_HEIGHTS, settings.lineHeight].sort((a, b) => a - b);

  /**
   * Try the material before committing the preference, so an unsupported one
   * says so instead of silently storing a setting that does nothing.
   */
  const pickWindowEffect = async (effect: WindowEffect) => {
    const error = await applyWindowEffect(effect);
    setEffectNote(error ?? "");
    setSettings({ windowEffect: error ? "opaque" : effect });
  };

  const [version, setVersion] = useState("");
  /** Portable data folder, or "" when settings live in the user profile. */
  const [dataDir, setDataDir] = useState("");
  const [updState, setUpdState] = useState<
    "idle" | "checking" | "none" | "found" | "downloading" | "ready" | "error"
  >("idle");
  const [updInfo, setUpdInfo] = useState<UpdateInfo | null>(null);
  const [updError, setUpdError] = useState("");

  /** Folder logs fall back to when none is chosen; "" when non-portable. */
  const [logDefault, setLogDefault] = useState("");

  useEffect(() => {
    appVersion().then(setVersion).catch(() => {});
    portableDataDir().then(setDataDir).catch(() => {});
    defaultLogDir().then(setLogDefault).catch(() => {});
  }, []);

  const masterLocked = useStore((s) => s.masterLocked);
  const masterSet = !!settings.masterSalt;
  const [secCurrent, setSecCurrent] = useState("");
  const [secNew, setSecNew] = useState("");
  const [secConfirm, setSecConfirm] = useState("");
  const [secNote, setSecNote] = useState("");
  const [secError, setSecError] = useState("");
  const [secBusy, setSecBusy] = useState(false);

  const resetSecFields = () => {
    setSecCurrent("");
    setSecNew("");
    setSecConfirm("");
  };

  const runSec = async (fn: () => Promise<void>) => {
    setSecBusy(true);
    setSecError("");
    setSecNote("");
    try {
      await fn();
      resetSecFields();
    } catch (e) {
      setSecError(String(e));
    } finally {
      setSecBusy(false);
    }
  };

  const secEnable = () =>
    runSec(async () => {
      if (secNew.length < 4) throw new Error("Use at least 4 characters.");
      if (secNew !== secConfirm) throw new Error("Passwords do not match.");
      await enableMaster(secNew);
      setSecNote("Master password enabled — saved passwords are now encrypted.");
    });

  const secUnlock = () =>
    runSec(async () => {
      if (!(await unlockMaster(secCurrent))) throw new Error("Wrong master password.");
      setSecNote("Unlocked.");
    });

  const secChange = () =>
    runSec(async () => {
      if (secNew.length < 4) throw new Error("Use at least 4 characters.");
      if (secNew !== secConfirm) throw new Error("Passwords do not match.");
      if (!(await changeMaster(secCurrent, secNew)))
        throw new Error("Wrong current master password.");
      setSecNote("Master password changed.");
    });

  const secDisable = () =>
    runSec(async () => {
      if (!(await disableMaster(secCurrent)))
        throw new Error("Wrong master password.");
      setSecNote("Master password removed — passwords are stored as plain text again.");
    });

  const checkUpdates = async () => {
    setUpdState("checking");
    setUpdError("");
    try {
      const info = await updateCheck();
      setUpdInfo(info);
      setUpdState(info.updateAvailable ? "found" : "none");
    } catch (e) {
      setUpdError(String(e));
      setUpdState("error");
    }
  };

  const installUpdate = async () => {
    if (!updInfo) return;
    if (!updInfo.assetUrl) {
      openUrl(updInfo.releaseUrl).catch(() => {});
      return;
    }
    setUpdState("downloading");
    setUpdError("");
    try {
      await updateApply(updInfo.assetUrl);
      setUpdState("ready");
    } catch (e) {
      setUpdError(String(e));
      setUpdState("error");
    }
  };

  const pickDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (picked && !Array.isArray(picked)) setSettings({ logDir: picked });
  };

  const applySessionsDir = async (dir: string) => {
    const clean = dir.trim();
    setSettings({ sessionsDir: clean });
    if (!clean) {
      setSessionsNote("");
      return;
    }
    try {
      const loaded = await adoptSessionsDir(clean);
      setSessionsNote(
        loaded
          ? "Loaded saved sessions from this folder."
          : "Folder adopted — your sessions are now mirrored there."
      );
    } catch (e) {
      setSessionsNote(`Could not use folder: ${String(e)}`);
    }
  };

  const pickSessionsDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (picked && !Array.isArray(picked)) await applySessionsDir(picked);
  };

  const setRules = (highlightRules: HighlightRule[]) => setSettings({ highlightRules });

  const addRule = () => {
    if (!newPattern.trim()) return;
    setRules([
      ...settings.highlightRules,
      { id: nanoid(), pattern: newPattern.trim(), color: newColor },
    ]);
    setNewPattern("");
  };

  return (
    <div className="modal-overlay" {...overlayDismiss(onClose)}>
      <div className="modal-shell w-[480px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="text-sm font-semibold text-ink-hi">Settings</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setHelpOpen(true)}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
              title="What each feature does, and how to use it"
            >
              <LifeBuoy size={14} />
              Help
            </button>
            <button onClick={onClose} className="tb-btn">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex gap-1 border-b border-edge px-3 pt-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "rounded-t-md border-b-2 px-3 py-1.5 text-xs transition",
                tab === t.id
                  ? "border-accent text-ink-hi"
                  : "border-transparent text-ink-dim hover:text-ink-mid"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="max-h-[70vh] space-y-6 overflow-y-auto px-5 py-4">
          {tab === "general" && (
            <>
              <div>
                <div className="micro-label mb-2">Updates</div>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm text-ink-hi">
                    Dshh {version ? `v${version}` : ""}
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                      {updState === "none" && "You are on the latest version."}
                      {updState === "found" && updInfo && `v${updInfo.latest} is available.`}
                      {updState === "ready" && "Update staged — restart to apply."}
                      {(updState === "idle" || updState === "checking") &&
                        "Checked automatically at startup; new versions show a notification."}
                      {updState === "downloading" && "Downloading update…"}
                      {updState === "error" && "Update failed."}
                    </span>
                  </div>
                  {updState === "found" || updState === "downloading" ? (
                    <button
                      onClick={installUpdate}
                      disabled={updState === "downloading"}
                      className="btn-primary shrink-0 disabled:pointer-events-none disabled:opacity-40"
                    >
                      {updState === "downloading" ? "Downloading…" : "Install"}
                    </button>
                  ) : updState === "ready" ? (
                    <button onClick={() => updateRestart()} className="btn-primary shrink-0">
                      Restart now
                    </button>
                  ) : (
                    <button
                      onClick={checkUpdates}
                      disabled={updState === "checking"}
                      className="flex shrink-0 items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi disabled:pointer-events-none disabled:opacity-40"
                    >
                      <RefreshCw size={13} className={updState === "checking" ? "animate-spin" : ""} />
                      {updState === "checking" ? "Checking…" : "Check for updates"}
                    </button>
                  )}
                </div>
                {updError && (
                  <p className="mt-1.5 rounded-md border border-err/40 bg-err/10 px-2 py-1.5 font-mono text-[10.5px] text-err">
                    {updError}
                  </p>
                )}
              </div>

              <div>
                <div className="micro-label mb-2">Interface</div>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={settings.collapseGroupsByDefault}
                    onChange={(e) =>
                      setSettings({ collapseGroupsByDefault: e.target.checked })
                    }
                  />
                  <span className="text-sm text-ink-hi">
                    Start with connection groups collapsed
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                      Keeps the sidebar to a short list of group headers on launch.
                      Expanding a group lasts until the app is restarted.
                    </span>
                  </span>
                </label>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={settings.statusBar}
                    onChange={(e) => setSettings({ statusBar: e.target.checked })}
                  />
                  <span className="text-sm text-ink-hi">
                    Show the terminal status bar
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                      A thin bar under each terminal with the target, time connected,
                      grid size and encoding, plus indicators for logging, macro
                      recording and running forwards.
                    </span>
                  </span>
                </label>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={settings.saveRetriedCredentials}
                    onChange={(e) =>
                      setSettings({ saveRetriedCredentials: e.target.checked })
                    }
                  />
                  <span className="text-sm text-ink-hi">
                    Save a corrected password to the session
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                      When a saved session is rejected, Dshh asks for the password
                      (or key passphrase) and keeps the one that works, along with a
                      username the session was missing. Only ever written after the
                      server accepts it. Off means the retry is one-time.
                    </span>
                  </span>
                </label>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={settings.colorStatusBar}
                    disabled={!settings.statusBar}
                    onChange={(e) => setSettings({ colorStatusBar: e.target.checked })}
                  />
                  <span className="text-sm text-ink-hi">
                    Colour the status bar
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                      Draws the bar as MobaXterm-style segments — green when connected,
                      red on error — and adds a clock. Off leaves the plain dim row.
                    </span>
                  </span>
                </label>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={settings.tintByConnection}
                    onChange={(e) => setSettings({ tintByConnection: e.target.checked })}
                  />
                  <span className="text-sm text-ink-hi">
                    Tint session chrome with the connection colour
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                      The accent picked on a connection also colours that session's
                      toolbar and status bar, so prod doesn't look like staging.
                    </span>
                  </span>
                </label>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={settings.connectBanner}
                    onChange={(e) => setSettings({ connectBanner: e.target.checked })}
                  />
                  <span className="text-sm text-ink-hi">
                    Print a connect banner in the terminal
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                      A coloured box on connect with the target, port, auth method and
                      jump host — MobaXterm's login header. It scrolls away with the
                      session and lands in the log.
                    </span>
                  </span>
                </label>

                <div className="mt-2 px-1">
                  <label className="field-label">Window backdrop</label>
                  <div className="flex gap-1.5">
                    {WINDOW_EFFECTS.map((e) => (
                      <button
                        key={e.id}
                        onClick={() => pickWindowEffect(e.id)}
                        className={cn(
                          "flex-1 rounded-md border px-3 py-2 text-left transition active:scale-[0.99]",
                          settings.windowEffect === e.id
                            ? "border-accent/50 bg-accent/10"
                            : "border-edge hover:border-edge-bright hover:bg-bg-hover"
                        )}
                      >
                        <span className="block text-sm text-ink-hi">{e.label}</span>
                        <span className="mt-0.5 block text-[10.5px] leading-snug text-ink-dim">
                          {e.blurb}
                        </span>
                      </button>
                    ))}
                  </div>
                  {effectNote && (
                    <p className="mt-1.5 font-mono text-[11px] text-warn">{effectNote}</p>
                  )}
                  <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim">
                    Mica and acrylic are Windows 11 materials. The terminal itself stays
                    opaque either way — output over a blurred desktop is unreadable.
                  </p>
                </div>

                <p className="mt-2 px-1 text-[11px] leading-relaxed text-ink-dim">
                  {dataDir ? (
                    <>
                      Running portably — settings, connections and logs live in{" "}
                      <span className="break-all font-mono text-ink-mid">{dataDir}</span>.
                      Move that folder and everything comes with it.
                    </>
                  ) : (
                    <>
                      Settings are stored in your Windows user profile. To keep them
                      beside the executable instead, run Dshh from a folder it can
                      write to.
                    </>
                  )}
                </p>
              </div>
            </>
          )}

          {tab === "terminal" && (
            <>
              <div>
                <div className="micro-label mb-2">Terminal appearance</div>

                <label className="field-label">Colour scheme</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {THEME_ORDER.map((t) => {
                    const active = settings.themeId === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() => setSettings({ themeId: t.id })}
                        title={t.label}
                        className={`rounded-md border px-2 py-1.5 text-left transition ${
                          active
                            ? "border-accent/70 bg-accent/10"
                            : "border-edge hover:border-edge-bright hover:bg-bg-hover"
                        }`}
                      >
                        <span className="flex gap-0.5">
                          {t.preview.map((c, i) => (
                            <span
                              key={i}
                              className="h-3 flex-1 rounded-sm"
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </span>
                        <span
                          className={`mt-1 block truncate text-[10.5px] ${
                            active ? "text-ink-hi" : "text-ink-dim"
                          }`}
                        >
                          {t.label}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div>
                    <label className="field-label">Font</label>
                    <select
                      value={currentFont}
                      onChange={(e) => setSettings({ fontFamily: fontStack(e.target.value) })}
                      className="w-full rounded-md border border-edge bg-bg-inset px-2 py-1.5 font-mono text-[12px] text-ink-hi outline-none transition focus:border-accent/60"
                    >
                      {fontOptions.map((f) => (
                        <option key={f} value={f} style={{ fontFamily: fontStack(f) }}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="field-label">Cursor</label>
                    <select
                      value={settings.cursorStyle}
                      onChange={(e) =>
                        setSettings({ cursorStyle: e.target.value as CursorStyle })
                      }
                      className="w-full rounded-md border border-edge bg-bg-inset px-2 py-1.5 font-mono text-[12px] text-ink-hi outline-none transition focus:border-accent/60"
                    >
                      <option value="block">block</option>
                      <option value="bar">bar</option>
                      <option value="underline">underline</option>
                    </select>
                  </div>
                </div>

                <div className="mt-2 grid grid-cols-3 gap-2">
                  <div>
                    <label className="field-label">Size</label>
                    <input
                      type="number"
                      min={8}
                      max={28}
                      className="field-input w-full font-mono text-[12px]"
                      value={settings.fontSize}
                      onChange={(e) =>
                        setSettings({
                          fontSize: clamp(Number(e.target.value), 8, 28, 13),
                        })
                      }
                    />
                  </div>
                  <div>
                    <label className="field-label">Line height</label>
                    <select
                      className="w-full rounded-md border border-edge bg-bg-inset px-2 py-1.5 font-mono text-[12px] text-ink-hi outline-none transition focus:border-accent/60"
                      value={String(settings.lineHeight)}
                      onChange={(e) =>
                        setSettings({
                          lineHeight: clamp(Number(e.target.value), 1, 2, 1.2),
                        })
                      }
                    >
                      {lineHeights.map((h) => (
                        <option key={h} value={String(h)}>
                          {h.toFixed(2)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="field-label">Scrollback</label>
                    <input
                      type="number"
                      min={200}
                      max={200000}
                      step={1000}
                      className="field-input w-full font-mono text-[12px]"
                      value={settings.scrollback}
                      onChange={(e) =>
                        setSettings({
                          scrollback: clamp(Number(e.target.value), 200, 200000, 10000),
                        })
                      }
                    />
                  </div>
                </div>

                <label className="mt-1 flex cursor-pointer items-center gap-2.5 rounded-md px-1 py-2">
                  <input
                    type="checkbox"
                    checked={settings.cursorBlink}
                    onChange={(e) => setSettings({ cursorBlink: e.target.checked })}
                  />
                  <span className="text-sm text-ink-hi">Blink the cursor</span>
                </label>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={settings.pasteWarnMultiline}
                    onChange={(e) => setSettings({ pasteWarnMultiline: e.target.checked })}
                  />
                  <span className="text-sm text-ink-hi">
                    Confirm multi-line pastes
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                      Pasting two or more lines shows them first — every newline is
                      an Enter, so a stray copy would run commands.
                    </span>
                  </span>
                </label>

                <p className="text-[11px] leading-relaxed text-ink-dim">
                  Applies to every open terminal immediately. A connection can
                  override the scheme and size for itself in its edit dialog.
                </p>
              </div>
            </>
          )}

          {tab === "output" && (
            <>
              <div>
                <div className="micro-label mb-2">Output highlighting</div>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={settings.highlightEnabled}
                    onChange={(e) => setSettings({ highlightEnabled: e.target.checked })}
                  />
                  <span className="text-sm text-ink-hi">
                    Colorize keywords in terminal output
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                      Case-insensitive. Applied live to SSH and serial output, like
                      XShell highlight sets.
                    </span>
                  </span>
                </label>

                <div
                  className={`mt-1 space-y-1.5 ${
                    settings.highlightEnabled ? "" : "pointer-events-none opacity-40"
                  }`}
                >
                  {settings.highlightRules.map((r) => (
                    <div key={r.id} className="flex items-center gap-2">
                      <select
                        value={r.color}
                        onChange={(e) =>
                          setRules(
                            settings.highlightRules.map((x) =>
                              x.id === r.id
                                ? { ...x, color: e.target.value as HighlightColor }
                                : x
                            )
                          )
                        }
                        className="w-28 rounded-md border border-edge bg-bg-inset px-2 py-1.5 font-mono text-[11px] outline-none transition focus:border-accent/60"
                        style={{ color: HL_COLORS[r.color] }}
                      >
                        {(Object.keys(HL_COLORS) as HighlightColor[]).map((c) => (
                          <option key={c} value={c} style={{ color: HL_COLORS[c] }}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <input
                        className="field-input flex-1 !py-1.5 font-mono text-[12px]"
                        value={r.pattern}
                        onChange={(e) =>
                          setRules(
                            settings.highlightRules.map((x) =>
                              x.id === r.id ? { ...x, pattern: e.target.value } : x
                            )
                          )
                        }
                      />
                      <button
                        onClick={() =>
                          setRules(settings.highlightRules.filter((x) => x.id !== r.id))
                        }
                        className="rounded p-1.5 text-ink-dim transition hover:bg-bg-hover hover:text-err"
                        title="Remove rule"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}

                  <div className="flex items-center gap-2 pt-1">
                    <select
                      value={newColor}
                      onChange={(e) => setNewColor(e.target.value as HighlightColor)}
                      className="w-28 rounded-md border border-edge bg-bg-inset px-2 py-1.5 font-mono text-[11px] outline-none transition focus:border-accent/60"
                      style={{ color: HL_COLORS[newColor] }}
                    >
                      {(Object.keys(HL_COLORS) as HighlightColor[]).map((c) => (
                        <option key={c} value={c} style={{ color: HL_COLORS[c] }}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <input
                      className="field-input flex-1 !py-1.5 font-mono text-[12px]"
                      placeholder="keyword, e.g. timeout"
                      value={newPattern}
                      onChange={(e) => setNewPattern(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addRule()}
                    />
                    <button
                      onClick={addRule}
                      disabled={!newPattern.trim()}
                      className="rounded-md border border-edge p-1.5 text-ink-mid transition hover:border-accent/50 hover:text-ink-hi active:scale-[0.97] disabled:pointer-events-none disabled:opacity-30"
                      title="Add rule"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <div className="micro-label mb-2">Session logging</div>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={settings.autoLog}
                    onChange={(e) => setSettings({ autoLog: e.target.checked })}
                  />
                  <span className="text-sm text-ink-hi">
                    Auto-log every session
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                      Each SSH / serial session is recorded to a timestamped .log file
                      in the folder below, automatically on connect.
                    </span>
                  </span>
                </label>

                <div className="mt-2">
                  <label className="field-label">Logs folder</label>
                  <div className="flex gap-2">
                    <input
                      className="field-input flex-1 font-mono text-[12.5px]"
                      placeholder={logDefault || "Choose where logs are saved…"}
                      value={settings.logDir}
                      onChange={(e) => setSettings({ logDir: e.target.value })}
                    />
                    <button
                      onClick={pickDir}
                      className="flex items-center gap-1.5 rounded-md border border-edge px-3 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
                    >
                      <FolderOpen size={14} />
                      Browse
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim">
                    Also used as the default target for the per-tab{" "}
                    <span className="text-ink-mid">Log</span> button.{" "}
                    {logDefault ? (
                      <>
                        Leave it empty and logs go to{" "}
                        <span className="break-all font-mono text-ink-mid">
                          {logDefault}
                        </span>
                        , so they travel with the portable folder.
                      </>
                    ) : (
                      <>If empty, Log asks where to save each time.</>
                    )}
                  </p>
                </div>
              </div>
            </>
          )}

          {tab === "security" && (
            <>
              <div>
                <div className="micro-label mb-2">Security</div>
                {!masterSet ? (
                  <>
                    <p className="mb-2 text-[11px] leading-relaxed text-ink-dim">
                      Set a master password to encrypt saved connection passwords and
                      key passphrases (AES-256, key derived with Argon2id). You will
                      be asked for it once each time the app starts.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        className="field-input flex-1 font-mono text-[12.5px]"
                        placeholder="new master password"
                        value={secNew}
                        onChange={(e) => setSecNew(e.target.value)}
                      />
                      <input
                        type="password"
                        className="field-input flex-1 font-mono text-[12.5px]"
                        placeholder="confirm"
                        value={secConfirm}
                        onChange={(e) => setSecConfirm(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && secEnable()}
                      />
                      <button
                        onClick={secEnable}
                        disabled={secBusy || !secNew}
                        className="btn-primary shrink-0 disabled:pointer-events-none disabled:opacity-40"
                      >
                        Enable
                      </button>
                    </div>
                  </>
                ) : masterLocked ? (
                  <div className="flex gap-2">
                    <input
                      type="password"
                      className="field-input flex-1 font-mono text-[12.5px]"
                      placeholder="master password"
                      value={secCurrent}
                      onChange={(e) => setSecCurrent(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && secUnlock()}
                    />
                    <button
                      onClick={secUnlock}
                      disabled={secBusy || !secCurrent}
                      className="btn-primary shrink-0 disabled:pointer-events-none disabled:opacity-40"
                    >
                      Unlock
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="mb-2 text-[11px] leading-relaxed text-ink-dim">
                      Master password is on — saved secrets are encrypted at rest.
                      Enter the current password to change or remove it.
                    </p>
                    <div className="space-y-2">
                      <input
                        type="password"
                        className="field-input w-full font-mono text-[12.5px]"
                        placeholder="current master password"
                        value={secCurrent}
                        onChange={(e) => setSecCurrent(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <input
                          type="password"
                          className="field-input flex-1 font-mono text-[12.5px]"
                          placeholder="new password (for change)"
                          value={secNew}
                          onChange={(e) => setSecNew(e.target.value)}
                        />
                        <input
                          type="password"
                          className="field-input flex-1 font-mono text-[12.5px]"
                          placeholder="confirm"
                          value={secConfirm}
                          onChange={(e) => setSecConfirm(e.target.value)}
                        />
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={secChange}
                          disabled={secBusy || !secCurrent || !secNew}
                          className="btn-primary disabled:pointer-events-none disabled:opacity-40"
                        >
                          Change password
                        </button>
                        <button
                          onClick={secDisable}
                          disabled={secBusy || !secCurrent}
                          className="rounded-md border border-err/40 px-3 text-xs text-err transition hover:bg-err/10 disabled:pointer-events-none disabled:opacity-40"
                        >
                          Disable
                        </button>
                      </div>
                    </div>
                  </>
                )}
                {secNote && !secError && (
                  <p className="mt-1.5 font-mono text-[11px] text-accent">{secNote}</p>
                )}
                {secError && (
                  <p className="mt-1.5 rounded-md border border-err/40 bg-err/10 px-2 py-1.5 font-mono text-[10.5px] text-err">
                    {secError}
                  </p>
                )}
              </div>

              <div>
                <div className="micro-label mb-2">Saved sessions</div>
                <label className="field-label">Sessions folder (optional)</label>
                <div className="flex gap-2">
                  <input
                    className="field-input flex-1 font-mono text-[12.5px]"
                    placeholder="Keep in app storage only"
                    value={settings.sessionsDir}
                    onChange={(e) => setSettings({ sessionsDir: e.target.value })}
                    onBlur={(e) => applySessionsDir(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" && applySessionsDir(settings.sessionsDir)
                    }
                  />
                  <button
                    onClick={pickSessionsDir}
                    className="flex items-center gap-1.5 rounded-md border border-edge px-3 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
                  >
                    <Database size={14} />
                    Browse
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim">
                  Saved connections are mirrored to{" "}
                  <span className="font-mono text-ink-mid">connections.json</span> in this
                  folder — handy for backups or syncing between machines. If the folder
                  already contains one, it is loaded and replaces the current list.{" "}
                  {masterSet
                    ? "Passwords in it are encrypted with your master password."
                    : "Passwords stored there are plain text, so pick a private location — or set a master password above."}
                </p>
                {sessionsNote && (
                  <p className="mt-1.5 font-mono text-[11px] text-accent">{sessionsNote}</p>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end border-t border-edge px-5 py-3">
          <button onClick={onClose} className="btn-primary">
            Done
          </button>
        </div>
      </div>
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
