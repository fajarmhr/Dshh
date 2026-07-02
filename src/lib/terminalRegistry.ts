/**
 * Live handles to mounted terminal sessions, keyed by session id.
 * Lets UI outside a terminal (compose bar, quick commands) write into it
 * without threading refs through the component tree. Entries exist only
 * while the backend connection is up.
 */

export interface TerminalHandle {
  send: (data: string) => void;
  focus: () => void;
}

const handles = new Map<string, TerminalHandle>();

export function registerTerminal(sessionId: string, handle: TerminalHandle) {
  handles.set(sessionId, handle);
}

export function unregisterTerminal(sessionId: string) {
  handles.delete(sessionId);
}

export function getTerminal(sessionId: string): TerminalHandle | undefined {
  return handles.get(sessionId);
}

/** Send to every listed session that has a live handle; returns how many received it. */
export function broadcastToTerminals(sessionIds: string[], data: string): number {
  let n = 0;
  for (const id of sessionIds) {
    const h = handles.get(id);
    if (h) {
      h.send(data);
      n++;
    }
  }
  return n;
}
