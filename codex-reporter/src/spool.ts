// Tailing an append-only JSONL file read-only: by byte offset and inode, complete lines only. The same reader serves the hook
// spool and Codex session files. It never writes, truncates, locks or moves the file it reads.
import fs from 'node:fs';

/** The most bytes one read takes from one file; the rest waits for the next tick. */
export const READ_CHUNK = 1024 * 1024;
/** A record longer than this is passed over whole rather than held in memory (a session file's compaction can be large). */
const MAX_RECORD_BYTES = 64 * 1024 * 1024;

export interface Line {
  text: string;
  /** Byte offset of the line's start in its file: with the inode, a stable key for what the line produced. */
  at: number;
}

export class JsonlTail {
  offset = 0;
  ino: number | null = null;
  private carry: Buffer = Buffer.alloc(0);
  /** Inside a record over MAX_RECORD_BYTES: everything up to the next line feed is dropped. */
  private skipping = false;

  /** `rotatedTo`: where a rotated file is renamed (the hook spool's `.1`), so the lines it got before the rename are still read. */
  constructor(
    readonly path: string,
    private readonly rotatedTo: string | null = null,
  ) {}

  /**
   * The complete lines appended since the last read, up to `budget` bytes. Follows a rotation (a new inode: the rest of the
   * old file is read from where it was renamed to, over as many reads as it takes, and only then the new file from its start)
   * and a truncation (a shorter file: read again from its start). A line without its terminating line feed is still being
   * written and waits.
   */
  read(budget: number): Line[] {
    const out: Line[] = [];
    let st: fs.Stats;
    try {
      st = fs.statSync(this.path);
    } catch {
      return out;
    }
    if (this.ino !== null && st.ino !== this.ino) {
      // Still inside the renamed file: the new one waits for the next read.
      if (this.rotatedTo && !this.drainRotated(out, budget)) return out;
      this.reset();
    } else if (st.size < this.offset) this.reset();
    this.ino = st.ino;
    this.readFrom(this.path, out, budget);
    return out;
  }

  /** Whether the last read reached the end of what the file held then. */
  caughtUp(): boolean {
    try {
      return fs.statSync(this.path).size <= this.offset;
    } catch {
      return true;
    }
  }

  private reset(): void {
    this.offset = 0;
    this.carry = Buffer.alloc(0);
    this.skipping = false;
  }

  /**
   * Reads on in the file the spool was renamed to, from where the last read stopped. True once nothing of it is left to read
   * (or it is not there any more: what it held is then lost); false while the budget ran out first.
   */
  private drainRotated(out: Line[], budget: number): boolean {
    let old: fs.Stats;
    try {
      old = fs.statSync(this.rotatedTo!);
    } catch {
      return true;
    }
    return old.ino !== this.ino || this.readFrom(this.rotatedTo!, out, budget);
  }

  /** Reads `file` on from the offset, at most `budget` bytes. False only when bytes it held were left for the next read. */
  private readFrom(file: string, out: Line[], budget: number): boolean {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      let left = budget;
      while (this.offset < size && left > 0) {
        const len = Math.min(size - this.offset, READ_CHUNK, left);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, this.offset);
        if (n <= 0) break;
        const chunkStart = this.offset - this.carry.length;
        this.offset += n;
        left -= n;
        this.take(Buffer.concat([this.carry, buf.subarray(0, n)]), chunkStart, out);
      }
      return this.offset >= size;
    } catch {
      // Unreadable now: the live file is tried again on the next read; a renamed file that cannot be read is given up, so the
      // spool never stalls on it.
      return true;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
      }
    }
  }

  private take(data: Buffer, dataStart: number, out: Line[]): void {
    let start = 0;
    for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
      if (this.skipping) this.skipping = false;
      else if (nl > start) out.push({ text: data.toString('utf8', start, nl), at: dataStart + start });
      start = nl + 1;
    }
    const rest = data.subarray(start);
    if (rest.length > MAX_RECORD_BYTES) {
      this.skipping = true;
      this.carry = Buffer.alloc(0);
    } else this.carry = this.skipping ? Buffer.alloc(0) : Buffer.from(rest);
  }
}
