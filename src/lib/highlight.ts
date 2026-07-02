import type { HighlightColor, HighlightRule } from "./types";

/**
 * Keyword colorizer for terminal output (XShell-style highlight sets).
 * Matches are wrapped in an SGR foreground color and closed with `ESC[39m`
 * (default foreground) so background/bold state set by the remote app is
 * preserved. A keyword split across two output chunks simply isn't
 * highlighted — chunks are transformed independently and never buffered.
 */

const SGR_OPEN: Record<HighlightColor, string> = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

const SGR_CLOSE = "\x1b[39m";

export interface CompiledRule {
  re: RegExp;
  open: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileRules(rules: HighlightRule[]): CompiledRule[] {
  return rules
    .filter((r) => r.pattern.trim().length > 0)
    .map((r) => ({
      re: new RegExp(escapeRegExp(r.pattern.trim()), "gi"),
      open: SGR_OPEN[r.color] ?? SGR_OPEN.red,
    }));
}

export function applyHighlights(text: string, rules: CompiledRule[]): string {
  let out = text;
  for (const { re, open } of rules) {
    out = out.replace(re, (m) => `${open}${m}${SGR_CLOSE}`);
  }
  return out;
}
