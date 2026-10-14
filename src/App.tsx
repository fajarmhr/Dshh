import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { ConnectionModal } from "./components/ConnectionModal";
import { SettingsModal } from "./components/SettingsModal";
import { UnlockModal } from "./components/UnlockModal";
import { UpdateToast } from "./components/UpdateToast";
import { applyWindowEffect, initSavedSessions, useStore } from "./store";
import { installFullScreenKeys, useFullScreen } from "./lib/fullscreen";
import type { Connection } from "./lib/types";

export default function App() {
  const [modalOpen, setModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const windowEffect = useStore((s) => s.settings.windowEffect);
  const fullScreen = useFullScreen((s) => s.on);

  // Load saved sessions from the optional sessions folder once at startup.
  useEffect(() => {
    initSavedSessions();
  }, []);

  useEffect(() => installFullScreenKeys(), []);

  // Restore the saved backdrop, and follow it when the setting changes.
  useEffect(() => {
    applyWindowEffect(windowEffect);
  }, [windowEffect]);

  const openNew = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (c: Connection) => {
    setEditing(c);
    setModalOpen(true);
  };

  return (
    <div className="flex h-screen w-screen bg-bg-base text-ink-hi effect-base">
      {/* Hidden rather than unmounted in full screen, so its filter and folds survive. */}
      <div className={fullScreen ? "hidden" : "contents"}>
        <Sidebar onNew={openNew} onEdit={openEdit} onSettings={() => setSettingsOpen(true)} />
      </div>
      <Workspace />
      {modalOpen && (
        <ConnectionModal initial={editing} onClose={() => setModalOpen(false)} />
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <UpdateToast />
      <UnlockModal />
    </div>
  );
}
