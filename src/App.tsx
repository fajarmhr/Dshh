import { useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { ConnectionModal } from "./components/ConnectionModal";
import { SettingsModal } from "./components/SettingsModal";
import type { Connection } from "./lib/types";

export default function App() {
  const [modalOpen, setModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);

  const openNew = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (c: Connection) => {
    setEditing(c);
    setModalOpen(true);
  };

  return (
    <div className="flex h-screen w-screen bg-bg-base text-[#dfe6ee]">
      <Sidebar onNew={openNew} onEdit={openEdit} onSettings={() => setSettingsOpen(true)} />
      <Workspace />
      {modalOpen && (
        <ConnectionModal initial={editing} onClose={() => setModalOpen(false)} />
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
