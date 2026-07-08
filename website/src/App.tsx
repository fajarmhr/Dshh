import { GITHUB_REPO } from "./config";
import { useIsMobile, useLatestRelease } from "./hooks";
import { formatBadgeDate, versionFromTag } from "./lib";
import Nav from "./components/Nav";
import Hero from "./components/Hero";
import Protocols from "./components/Protocols";
import DownloadSection from "./components/DownloadSection";
import Changelog from "./components/Changelog";
import Docs from "./components/Docs";
import Footer from "./components/Footer";

export default function App() {
  const isMobile = useIsMobile();
  const repo = GITHUB_REPO.trim();
  const { live, liveErr } = useLatestRelease(repo);

  // Static v0.1.0 strings are the design's fallback until the feed resolves.
  const version = versionFromTag(live?.tag) ?? "0.1.0";
  const tagLabel = live?.tag ?? "v0.1.0";
  const dateLabel = (live && formatBadgeDate(live.date)) || "jul 2026";
  const fileName = live?.zipName ?? `Dshh-${version}-portable-win64.zip`;
  const releaseUrl = live
    ? live.zipUrl
    : repo
      ? `https://github.com/${repo}/releases/latest`
      : "";
  const repoUrl = repo ? `https://github.com/${repo}` : "https://github.com";
  const releasesUrl = repo
    ? `https://github.com/${repo}/releases`
    : "https://github.com";
  const liveNote = !repo
    ? "release feed: set GITHUB_REPO in src/config.ts (user/repo) to pull the latest GitHub release, live"
    : liveErr
      ? `github: ${liveErr}`
      : live
        ? `latest on github: ${live.tag} · ${live.date}`
        : "checking github releases…";

  return (
    <>
      <Nav isMobile={isMobile} repoUrl={repoUrl} />
      <Hero isMobile={isMobile} releaseUrl={releaseUrl} tagLabel={tagLabel} />
      <Protocols />
      <DownloadSection
        tagLabel={tagLabel}
        dateLabel={dateLabel}
        version={version}
        fileName={fileName}
        releaseUrl={releaseUrl}
        releasesUrl={releasesUrl}
        liveNote={liveNote}
      />
      <Changelog />
      <Docs fileName={fileName} />
      <Footer />
    </>
  );
}
