import { goToSection } from "../lib";
import AppMockup from "./AppMockup";

export default function Hero({
  isMobile,
  releaseUrl,
  tagLabel,
}: {
  isMobile: boolean;
  releaseUrl: string;
  tagLabel: string;
}) {
  return (
    <div className="hero">
      <div className="hero-glow" />
      <div className="wrap hero-body">
        {!isMobile ? (
          <div className="hero-in">
            <div className="eyebrow">ssh · sftp · ftp · serial — one exe</div>
            <h1 className="h1">
              Every protocol.
              <br />
              One process.
            </h1>
            <p className="hero-p">
              Dshh is a tabbed SSH, SFTP, FTP and serial client for Windows.
              Every protocol is implemented in-process, in Rust, inside a
              single portable executable — no{" "}
              <span className="mono-inline">ssh.exe</span>, no child processes,
              no installer.
            </p>
            <div className="hero-cta">
              <a
                className="btn btn-acc sz-hero hero-shadow"
                href={releaseUrl || undefined}
                target="_blank"
                rel="noreferrer"
              >
                ↓ Download for Windows
              </a>
              <button
                type="button"
                className="btn btn-line btn-line-b sz-hero-line"
                onClick={() => goToSection("dsh-changelog")}
              >
                View changelog
              </button>
            </div>
            <div className="hero-meta">
              {tagLabel} · portable zip · win64 · no installer · no admin
              rights
            </div>
          </div>
        ) : (
          <div className="hero-in-m">
            <div className="eyebrow eyebrow-m">ssh · sftp · ftp · serial</div>
            <h1 className="h1-m">Every protocol. One process.</h1>
            <p className="hero-p-m">
              A tabbed SSH, SFTP, FTP and serial client for Windows — every
              protocol in-process, in Rust, in one portable exe.
            </p>
            <div className="hero-cta-m">
              <a
                className="btn-acc m-hero-acc"
                href={releaseUrl || undefined}
                target="_blank"
                rel="noreferrer"
              >
                ↓ Download for Windows
              </a>
              <button
                type="button"
                className="btn-line m-hero-line"
                onClick={() => goToSection("dsh-changelog")}
              >
                View changelog
              </button>
            </div>
            <div className="hero-meta-m">
              {tagLabel} · portable zip · win64 · no admin
            </div>
          </div>
        )}
        <AppMockup isMobile={isMobile} />
      </div>
    </div>
  );
}
