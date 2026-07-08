const REPO = "fajarmhr/Dshh";

// --- App-mockup tab switching (sidebar rows + tab strip) ---
const panels = document.querySelectorAll<HTMLElement>(".panel");
const tabs = document.querySelectorAll<HTMLElement>(".mtab");
function selectTab(name: string): void {
  tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
  panels.forEach((p) => p.classList.toggle("is-active", p.dataset.panel === name));
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

// --- Live latest release from GitHub (keeps download links current) ---
interface Release {
  tag_name?: string;
  html_url?: string;
  assets?: { name?: string; browser_download_url?: string }[];
}
const downloadLinks = document.querySelectorAll<HTMLAnchorElement>("[data-download]");
const liveNotes = document.querySelectorAll<HTMLElement>("[data-live-note]");
fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  .then((r) => (r.ok ? (r.json() as Promise<Release>) : Promise.reject(new Error("HTTP " + r.status))))
  .then((j) => {
    const exe = (j.assets || []).find((a) => /\.exe$/i.test(a.name || ""));
    const url = exe?.browser_download_url || j.html_url;
    if (url) downloadLinks.forEach((a) => (a.href = url));
    const tag = j.tag_name || "";
    if (tag) liveNotes.forEach((n) => (n.textContent = `latest on github: ${tag}`));
  })
  .catch(() => {
    liveNotes.forEach((n) => (n.textContent = "releases: github.com/fajarmhr/Dshh/releases"));
  });
