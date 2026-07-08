import { useEffect, useState } from "react";
import { SECTION_IDS } from "./lib";

export function useIsMobile(): boolean {
  const [vw, setVw] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return vw < 768;
}

// The last section whose top edge is within 130px of the viewport top wins.
export function useScrollSpy(): string {
  const [active, setActive] = useState("");
  useEffect(() => {
    const onScroll = () => {
      let current = "";
      for (const id of SECTION_IDS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 130) current = id;
      }
      setActive(current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return active;
}

export interface LiveRelease {
  tag: string;
  date: string; // YYYY-MM-DD
  zipUrl: string;
  zipName: string | null;
}

interface GhAsset {
  name?: string;
  browser_download_url: string;
}

interface GhRelease {
  tag_name?: string;
  published_at?: string;
  html_url: string;
  assets?: GhAsset[];
}

export function useLatestRelease(repo: string): {
  live: LiveRelease | null;
  liveErr: string | null;
} {
  const [live, setLive] = useState<LiveRelease | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);

  useEffect(() => {
    const slug = repo.trim();
    if (!slug || !slug.includes("/")) return;
    const ctl = new AbortController();
    fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      signal: ctl.signal,
    })
      .then((r): Promise<GhRelease> =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((j) => {
        const zip = (j.assets ?? []).find((a) => /\.zip$/i.test(a.name ?? ""));
        setLive({
          tag: j.tag_name || "?",
          date: (j.published_at ?? "").slice(0, 10),
          zipUrl: zip ? zip.browser_download_url : j.html_url,
          zipName: zip?.name ?? null,
        });
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setLiveErr(e instanceof Error ? e.message : String(e));
      });
    return () => ctl.abort();
  }, [repo]);

  return { live, liveErr };
}
