import { useEffect, useRef, useState } from "react";
import { goToSection } from "../lib";

type DemoState = "idle" | "checking" | "available" | "downloading" | "done";

export default function UpdateDemo() {
  const [demo, setDemo] = useState<DemoState>("idle");
  const [progress, setProgress] = useState(0);
  const timeoutRef = useRef<number | undefined>(undefined);
  const intervalRef = useRef<number | undefined>(undefined);

  const clearTimers = () => {
    window.clearTimeout(timeoutRef.current);
    window.clearInterval(intervalRef.current);
  };
  useEffect(() => clearTimers, []);

  useEffect(() => {
    if (demo === "downloading" && progress >= 100) {
      window.clearInterval(intervalRef.current);
      setDemo("done");
    }
  }, [demo, progress]);

  const simulate = () => {
    clearTimers();
    setProgress(0);
    setDemo("checking");
    timeoutRef.current = window.setTimeout(() => setDemo("available"), 1100);
  };
  const startDownload = () => {
    window.clearInterval(intervalRef.current);
    setProgress(0);
    setDemo("downloading");
    intervalRef.current = window.setInterval(() => {
      setProgress((p) => Math.min(100, p + 1.5 + Math.random() * 3.5));
    }, 55);
  };
  const reset = () => {
    clearTimers();
    setProgress(0);
    setDemo("idle");
  };

  const pct = Math.round(progress);

  return (
    <>
      <div className="toast">
        {demo === "idle" && (
          <div className="toast-row toast-row-c">
            <div className="toast-ico ti-green">✓</div>
            <div>
              <div className="toast-t">You're up to date</div>
              <div className="toast-s">dshh 0.1.0 · checked on launch</div>
            </div>
          </div>
        )}
        {demo === "checking" && (
          <div className="toast-row toast-row-c">
            <div className="toast-ico ti-ring">
              <span className="spinner" />
            </div>
            <div>
              <div className="toast-t">Checking for updates…</div>
              <div className="toast-s">
                GET api.github.com/…/releases/latest
              </div>
            </div>
          </div>
        )}
        {demo === "available" && (
          <div className="toast-row">
            <div className="toast-ico ti-acc">↓</div>
            <div className="toast-body">
              <div className="toast-head">
                <span className="toast-t">Update available</span>
                <button type="button" className="toast-x" onClick={reset}>
                  ✕
                </button>
              </div>
              <div className="toast-s">dshh 0.2.0 · released today</div>
              <div className="toast-btns">
                <button
                  type="button"
                  className="toast-dl"
                  onClick={startDownload}
                >
                  Download
                </button>
                <button
                  type="button"
                  className="toast-cl"
                  onClick={() => goToSection("dsh-changelog")}
                >
                  Changelog
                </button>
              </div>
            </div>
          </div>
        )}
        {demo === "downloading" && (
          <div className="toast-row">
            <div className="toast-ico ti-acc">↓</div>
            <div className="toast-body">
              <div className="toast-t">Downloading dshh 0.2.0</div>
              <div className="prog-track">
                <div className="prog-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="prog-meta">
                <span>Dshh-0.2.0-portable-win64.zip</span>
                <span>{pct}%</span>
              </div>
            </div>
          </div>
        )}
        {demo === "done" && (
          <div className="toast-row toast-row-c">
            <div className="toast-ico ti-green">✓</div>
            <div className="toast-body">
              <div className="toast-t">Ready — dshh 0.2.0 downloaded</div>
              <div className="toast-s">
                saved next to dshh.exe · restart to apply
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="demo-ctl">
        {demo === "idle" && (
          <button
            type="button"
            className="btn-demo btn-demo-b"
            onClick={simulate}
          >
            ▶ simulate update check
          </button>
        )}
        {demo === "done" && (
          <button type="button" className="btn-demo" onClick={reset}>
            ↺ replay demo
          </button>
        )}
      </div>
    </>
  );
}
