const REPO = "fajarmhr/Dshh";

// --- App-mockup tab switching (sidebar rows + tab strip) ---
const panels = document.querySelectorAll<HTMLElement>(".panel");
const tabs = document.querySelectorAll<HTMLElement>(".mtab");
const sideRows = document.querySelectorAll<HTMLElement>(".side-row");
function selectTab(name: string): void {
  tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
  panels.forEach((p) => p.classList.toggle("is-active", p.dataset.panel === name));
  sideRows.forEach((r) => r.classList.toggle("is-active", r.dataset.tab === name));
}
document.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) =>
  el.addEventListener("click", () => selectTab(el.dataset.tab as string))
);
selectTab("ssh");

// --- Mobile menu ---
const menu = document.querySelector<HTMLElement>("[data-mobile-menu]");
document
  .querySelector("[data-menu-toggle]")
  ?.addEventListener("click", () => menu?.classList.toggle("open"));
menu?.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => menu.classList.remove("open")));

// --- Active nav dot on scroll ---
const sections = ["dsh-features", "dsh-download", "dsh-changelog", "dsh-docs"];
const navLinks = new Map<string, HTMLElement>();
document.querySelectorAll<HTMLElement>("[data-nav]").forEach((el) => navLinks.set(el.dataset.nav as string, el));
function onScroll(): void {
  let current = "";
  for (const id of sections) {
    const el = document.getElementById(id);
    if (el && el.getBoundingClientRect().top <= 130) current = id;
  }
  navLinks.forEach((el, id) => el.classList.toggle("active", id === current));
}
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// --- Update-check demo (idle -> checking -> available -> downloading -> done) ---
const demoRoot = document.querySelector<HTMLElement>("[data-demo-root]");
let progress = 0;
let dlTimer: number | undefined;
function setDemo(state: string): void {
  demoRoot?.setAttribute("data-demo", state);
  demoRoot?.querySelectorAll<HTMLElement>("[data-demo-view]").forEach((v) => {
    v.style.display = v.dataset.demoView === state ? "" : "none";
  });
}
function renderProgress(): void {
  const bar = demoRoot?.querySelector<HTMLElement>("[data-progress]");
  if (bar) bar.style.width = progress + "%";
  demoRoot?.querySelectorAll<HTMLElement>("[data-progress-label]").forEach((l) => (l.textContent = progress + "%"));
}
document.querySelector("[data-simulate]")?.addEventListener("click", () => {
  setDemo("checking");
  window.setTimeout(() => setDemo("available"), 1400);
});
document.querySelector("[data-start-download]")?.addEventListener("click", () => {
  progress = 0;
  setDemo("downloading");
  renderProgress();
  window.clearInterval(dlTimer);
  dlTimer = window.setInterval(() => {
    progress = Math.min(100, progress + 8);
    renderProgress();
    if (progress >= 100) {
      window.clearInterval(dlTimer);
      window.setTimeout(() => setDemo("done"), 300);
    }
  }, 170);
});
document.querySelectorAll("[data-reset-demo]").forEach((b) =>
  b.addEventListener("click", () => {
    window.clearInterval(dlTimer);
    progress = 0;
    setDemo("idle");
  })
);
setDemo("idle");

// --- Live releases from GitHub (download links + changelog stay current) ---
interface Release {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; browser_download_url?: string }[];
}
const downloadLinks = document.querySelectorAll<HTMLAnchorElement>("[data-download]");
const liveNotes = document.querySelectorAll<HTMLElement>("[data-live-note]");

function el(
  tag: string,
  style: string,
  text?: string,
  cls?: string
): HTMLElement {
  const e = document.createElement(tag);
  if (style) e.setAttribute("style", style);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function monthYear(iso?: string): string {
  if (!iso) return "";
  return new Date(iso)
    .toLocaleDateString("en-US", { month: "short", year: "numeric" })
    .toLowerCase();
}

/** Pull display bullets out of a release body (handles GitHub's
 *  auto-generated notes: markdown links, "by @user in <url>" tails). */
function bullets(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-*] /.test(l))
    .map((l) =>
      l
        .replace(/^[-*] /, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/ by @[\w-]+ in \S+$/, "")
        .replace(/\*\*/g, "")
        .trim()
    )
    .filter(Boolean);
}

const MONO = "'JetBrains Mono',monospace";

function renderChangelog(rels: Release[]): void {
  const root = document.querySelector<HTMLElement>("[data-changelog]");
  if (!root || rels.length === 0) return;
  // Keep the hand-written body for releases whose GitHub notes are empty —
  // the curated static entry reads better than a bare link.
  const staticBodies = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>(":scope > .clog").forEach((c) => {
    const tag = c.querySelector(".clog-v span")?.textContent?.trim();
    const body = c.querySelector<HTMLElement>(".clog-body");
    if (tag && body) staticBodies.set(tag, body);
  });
  const out: HTMLElement[] = [];
  rels.forEach((rel, i) => {
    const entry = el("div", "", undefined, "clog");
    const left = el("div", "", undefined, "clog-v");
    const tagRow = el("div", "display:flex;align-items:center;gap:8px;");
    tagRow.appendChild(
      el("span", `font-family:${MONO};font-size:13px;font-weight:600;color:#5b8cff;`, rel.tag_name || "")
    );
    if (i === 0)
      tagRow.appendChild(
        el(
          "span",
          `border-radius:5px;background:rgba(62,207,142,0.1);padding:1px 7px;font-family:${MONO};font-size:10px;color:#3ecf8e;`,
          "latest"
        )
      );
    left.appendChild(tagRow);
    left.appendChild(el("div", "", monthYear(rel.published_at), "clog-d"));
    entry.appendChild(left);

    const items = bullets(rel.body || "");
    const staticBody = staticBodies.get(rel.tag_name || "");
    let body: HTMLElement;
    if (items.length === 0 && staticBody) {
      body = staticBody.cloneNode(true) as HTMLElement;
    } else {
      body = el("div", "", undefined, "clog-body");
      const heading =
        rel.name && rel.name !== rel.tag_name ? rel.name : `Release ${rel.tag_name || ""}`;
      body.appendChild(el("div", "", heading, "clog-h"));
      if (items.length > 0) {
        const ul = el("ul", "", undefined, "clog-ul");
        items.forEach((b) => ul.appendChild(el("li", "", b)));
        body.appendChild(ul);
      } else {
        const wrap = el("div", "margin-top:6px;font-size:14px;color:#5a6878;");
        const link = el("a", "color:#7ca4ff;", "release notes on github ↗") as HTMLAnchorElement;
        const url = rel.html_url || `https://github.com/${REPO}/releases`;
        if (/^https:\/\/github\.com\//.test(url)) link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        wrap.appendChild(link);
        body.appendChild(wrap);
      }
    }
    entry.appendChild(body);
    out.push(entry);
  });
  root.replaceChildren(...out);
}

fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`)
  .then((r) => (r.ok ? (r.json() as Promise<Release[]>) : Promise.reject(new Error("HTTP " + r.status))))
  .then((all) => {
    const rels = all.filter((r) => !r.draft && !r.prerelease);
    const latest = rels[0];
    if (!latest) throw new Error("no releases");
    const assets = latest.assets || [];
    const pick = (re: RegExp) =>
      assets.find((a) => re.test(a.name || ""))?.browser_download_url;
    // Zip only — never hand the browser a bare .exe (SmartScreen warnings);
    // if a release somehow has no zip, send people to the release page.
    const url = pick(/^Dshh-portable\.zip$/i) || pick(/\.zip$/i) || latest.html_url;
    if (url) downloadLinks.forEach((a) => (a.href = url));
    const tag = latest.tag_name || "";
    if (tag) {
      liveNotes.forEach((n) => (n.textContent = `latest on github: ${tag}`));
      document
        .querySelectorAll<HTMLElement>("[data-latest-ver]")
        .forEach((e) => (e.textContent = tag));
      document
        .querySelectorAll<HTMLElement>("[data-latest-title]")
        .forEach((e) => (e.textContent = `Dshh ${tag.replace(/^v/i, "")} — portable`));
    }
    renderChangelog(rels);
  })
  .catch(() => {
    liveNotes.forEach((n) => (n.textContent = "releases: github.com/fajarmhr/Dshh/releases"));
  });

// --- Copy download link (with brief ✓ confirmation) ---
const copyBtn = document.querySelector<HTMLElement>("[data-copy-link]");
let copyTimer: number | undefined;
copyBtn?.addEventListener("click", () => {
  const url = downloadLinks[0]?.href || `https://github.com/${REPO}/releases/latest`;
  const done = (): void => {
    copyBtn.textContent = "✓ copied";
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => (copyBtn.textContent = "copy link"), 1600);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, done);
  else done();
});
