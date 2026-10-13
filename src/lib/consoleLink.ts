/**
 * Console links as OpenStack-style clouds hand them out — Huawei FusionSphere
 * gives `https://proxy:8002/vnc_auto.html?token=…&name=VM&uuid=…`, and plain
 * nova gives `…/vnc_auto.html?token=…` or `…/vnc_lite.html?path=…`.
 *
 * The page itself is just noVNC; what matters is where its WebSocket goes, and
 * the token that authorises it. A `ws://`/`wss://` URL is taken as the
 * WebSocket address directly.
 */
export interface ConsoleLink {
  host: string;
  port: number;
  /** https/wss rather than http/ws. */
  tls: boolean;
  token: string;
  /** WebSocket path, when the link names one; otherwise noVNC's default applies. */
  path?: string;
  /** VM name, when the link carries one (FusionSphere's `name=`). */
  name?: string;
}

export function parseConsoleLink(input: string): ConsoleLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (!["http", "https", "ws", "wss"].includes(scheme)) return null;
  const tls = scheme === "https" || scheme === "wss";
  const params = url.searchParams;

  // noVNC's own `path` parameter names the WebSocket path, and may carry the
  // token inside it ("websockify?token=…").
  let path: string | undefined;
  if (scheme.startsWith("ws")) {
    path = (url.pathname.replace(/^\/+/, "") || "websockify") + url.search;
  } else if (params.get("path")) {
    path = params.get("path")!;
  }
  const token =
    params.get("token") ?? (path ? new URLSearchParams(path.split("?")[1] ?? "").get("token") : null);
  if (!token) return null;

  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port ? Number(url.port) : tls ? 443 : 80,
    tls,
    token,
    path,
    name: params.get("name")?.trim() || params.get("title")?.trim() || undefined,
  };
}
