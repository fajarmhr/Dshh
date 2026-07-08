import { useEffect, useRef, useState } from "react";
import UpdateDemo from "./UpdateDemo";

interface Props {
  tagLabel: string;
  dateLabel: string;
  version: string;
  fileName: string;
  releaseUrl: string;
  releasesUrl: string;
  liveNote: string;
}

export default function DownloadSection({
  tagLabel,
  dateLabel,
  version,
  fileName,
  releaseUrl,
  releasesUrl,
  liveNote,
}: Props) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const copyLink = () => {
    const url = releaseUrl || "https://github.com/<user>/dshh/releases/latest";
    const done = () => {
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done, done);
    } else {
      done();
    }
  };

  return (
    <section id="dsh-download" className="section">
      <div className="wrap sec-in">
        <div className="eyebrow">download</div>
        <h2 className="h2">Get Dshh for Windows</h2>
        <div className="grid-dl">
          <div className="dl-card">
            <div className="badges">
              <span className="badge-ver">{tagLabel}</span>
              <span className="badge-latest">latest</span>
              <span className="badge-date">{dateLabel}</span>
            </div>
            <div className="dl-title">Dshh {version} — portable</div>
            <div className="file-row">
              <a
                className="file-link"
                href={releaseUrl || undefined}
                target="_blank"
                rel="noreferrer"
              >
                ↓ {fileName}
              </a>
              <span className="file-arch">win64</span>
            </div>
            <div className="install-note">
              unzip → run dshh.exe · no installer, no admin
              <br />
              uninstall = delete the folder
            </div>
            <div className="dl-btns">
              <a
                className="btn btn-acc sz-dl"
                href={releaseUrl || undefined}
                target="_blank"
                rel="noreferrer"
              >
                ↓ Download zip
              </a>
              <a
                className="btn btn-line sz-rel"
                href={releasesUrl}
                target="_blank"
                rel="noreferrer"
              >
                All releases ↗
              </a>
              <button
                type="button"
                className="btn btn-line sz-copy"
                onClick={copyLink}
              >
                {copied ? "✓ copied" : "copy link"}
              </button>
            </div>
            <div className="feed-status">{liveNote}</div>
          </div>
          <div className="up-card">
            <div className="eyebrow">updates</div>
            <div className="up-title">You'll know when there's a new build</div>
            <div className="steps">
              <div>
                <span className="step-num">01</span>&nbsp; on launch, dshh
                checks GitHub Releases
              </div>
              <div>
                <span className="step-num">02</span>&nbsp; compares the tag
                against the running build
              </div>
              <div>
                <span className="step-num">03</span>&nbsp; newer? a quiet
                in-app notification — your call
              </div>
            </div>
            <UpdateDemo />
            <div className="up-note">
              No background service, nothing silent. This page reads the same
              feed — it always shows the newest release.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
