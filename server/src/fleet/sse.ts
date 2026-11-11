// The Server-Sent Events hub: the open streams, and broadcasting to them. A client is anything with `write`
// (the stream route wraps its Express response in one). A client whose write throws is forgotten on the spot and the error goes
// no further, so one broken socket can neither crash the process nor hold up the other clients.

/** The stream's events: the whole state, one session, one activity row, a session that left, and the 2 s tick. */
export type SseEventName = 'snapshot' | 'session' | 'activity' | 'removed' | 'tick';

/** One message on the wire: the event's name, its data as one line of JSON, and the blank line that ends it. */
export function formatSse(name: SseEventName, payload: unknown): string {
  return ['event: ' + name, 'data: ' + JSON.stringify(payload), '', ''].join('\n');
}

/** Where one client's messages go. */
export interface SseSink {
  write(chunk: string): unknown;
  end?(): void;
}

/** What every client is sent before anything else: wait two seconds before reconnecting. */
const RECONNECT_HINT = 'retry: 2000\n\n';

export class SseHub {
  readonly maxClients: number;
  /** The open clients by id, in the order they joined. */
  private readonly open = new Map<number, SseSink>();
  private issued = 0;

  constructor(maxClients = 100) {
    this.maxClients = maxClients;
  }

  get size(): number {
    return this.open.size;
  }

  /** At the cap: the next `add` is turned away. */
  get isFull(): boolean {
    return this.open.size >= this.maxClients;
  }

  /**
   * Takes a client and sends it the reconnect hint followed by `opening`, the messages it starts with. Its id; null when the hub
   * is full, or when that first write failed and the client is already gone.
   */
  add(sink: SseSink, ...opening: string[]): number | null {
    if (this.isFull) return null;
    this.issued += 1;
    const id = this.issued;
    this.open.set(id, sink);
    this.send([id], [RECONNECT_HINT, ...opening].join(''));
    return this.open.has(id) ? id : null;
  }

  remove(id: number): void {
    this.open.delete(id);
  }

  /** One message to every open client; with nobody listening, the payload is never serialized. */
  broadcast(name: SseEventName, payload: unknown): void {
    if (this.open.size > 0) this.send(Array.from(this.open.keys()), formatSse(name, payload));
  }

  /** Ends every client's stream as the server shuts down; each is forgotten whether or not it ends cleanly. */
  closeAll(): void {
    const sinks = Array.from(this.open.values());
    this.open.clear();
    for (const sink of sinks) {
      try {
        sink.end?.();
      } catch {
        // A socket that fails to end is going away regardless.
      }
    }
  }

  /** Writes one chunk to each of `ids` still open; a client whose write throws is forgotten. */
  private send(ids: readonly number[], chunk: string): void {
    for (const id of ids) {
      const sink = this.open.get(id);
      if (sink === undefined) continue;
      try {
        sink.write(chunk);
      } catch {
        this.open.delete(id);
      }
    }
  }
}
