import { useState } from "react";
import { useScrollSpy } from "../hooks";
import { goToSection, type SectionId } from "../lib";

const LINKS: { id: SectionId; label: string }[] = [
  { id: "dsh-features", label: "features" },
  { id: "dsh-download", label: "download" },
  { id: "dsh-changelog", label: "changelog" },
  { id: "dsh-docs", label: "docs" },
];

export default function Nav({
  isMobile,
  repoUrl,
}: {
  isMobile: boolean;
  repoUrl: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const activeSection = useScrollSpy();

  const navigate = (id: SectionId) => {
    setMenuOpen(false);
    goToSection(id);
  };

  return (
    <header className="nav">
      <div className="wrap nav-in">
        <button
          type="button"
          className="brand"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <span className="brand-chip">&gt;_</span>
          <span className="brand-name">dshh</span>
        </button>
        {!isMobile && (
          <>
            <nav className="nav-links">
              {LINKS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className="nav-link"
                  onClick={() => navigate(l.id)}
                >
                  {activeSection === l.id && <span className="nav-dot" />}
                  {l.label}
                </button>
              ))}
            </nav>
            <div className="nav-btns">
              <a
                className="btn btn-line btn-line-b sz-nav-line"
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
              >
                GitHub ↗
              </a>
              <button
                type="button"
                className="btn btn-acc sz-nav-acc"
                onClick={() => navigate("dsh-download")}
              >
                ↓ Download
              </button>
            </div>
          </>
        )}
        {isMobile && (
          <button
            type="button"
            className="menu-btn"
            onClick={() => setMenuOpen((o) => !o)}
          >
            ≡
          </button>
        )}
      </div>
      {isMobile && menuOpen && (
        <div className="m-menu">
          {LINKS.map((l, i) => (
            <button
              key={l.id}
              type="button"
              className={"m-link" + (i === LINKS.length - 1 ? " m-link-last" : "")}
              onClick={() => navigate(l.id)}
            >
              {l.label}
            </button>
          ))}
          <button
            type="button"
            className="btn-acc m-menu-dl"
            onClick={() => navigate("dsh-download")}
          >
            ↓ Download for Windows
          </button>
        </div>
      )}
    </header>
  );
}
