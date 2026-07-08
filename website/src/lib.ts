export const SECTION_IDS = [
  "dsh-features",
  "dsh-download",
  "dsh-changelog",
  "dsh-docs",
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

// Scroll with a fixed 72px offset so the sticky nav never covers the
// section heading (scrollIntoView cannot do this).
export function goToSection(id: SectionId): void {
  const el = document.getElementById(id);
  if (!el) return;
  const y = el.getBoundingClientRect().top + window.scrollY - 72;
  window.scrollTo({ top: y, behavior: "smooth" });
}

export function versionFromTag(tag: string | undefined): string | null {
  if (!tag) return null;
  return tag.replace(/^v/i, "");
}

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

// "2026-07-07" -> "jul 2026" (the badge-row date format of the design)
export function formatBadgeDate(isoDate: string): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(isoDate);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${m[1]}` : null;
}
