import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { ConnectionModal } from "./components/ConnectionModal";
import { SettingsModal } from "./components/SettingsModal";
import { UnlockModal } from "./components/UnlockModal";
import { UpdateToast } from "./components/UpdateToast";
import { applyWindowEffect, initSavedSessions, useStore } from "./store";
import type { Connection } from "./lib/types";

export default function App() {
  const [modalOpen, setModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const windowEffect = useStore((s) => s.settings.windowEffect);

  // Load saved sessions from the optional sessions folder once at startup.
  useEffect(() => {
    initSavedSessions();
  }, []);

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
      <Sidebar onNew={openNew} onEdit={openEdit} onSettings={() => setSettingsOpen(true)} />
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
