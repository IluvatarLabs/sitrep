// The server's clocks. Every second the fleet sweeps its live set (leases, lingering and silent sessions, carried samples); every
// two seconds it sends the KPI tick, which is also the stream's keepalive; every hour, and once straight away, it applies
// retention. A job that throws is logged and its clock keeps running.
import type { Fleet } from './fleet.js';
import type { Logger } from '../logger.js';

/** How often each job runs, in ms. */
const EVERY = { sweep: 1000, tick: 2000, retention: 60 * 60_000 };

/** Starts the clocks, which never keep the process alive by themselves; the function returned stops them. */
export function startSweeper(fleet: Fleet, logger: Logger): () => void {
  const safely = (job: string, work: () => void) => (): void => {
    try {
      work();
    } catch (err) {
      logger.error(`sitrep: the ${job} job failed: ${(err as Error).message}`);
    }
  };
  const prune = safely('retention', () => {
    const gone = fleet.retain();
    if (gone.sessions + gone.events + gone.machines > 0) {
      logger.debug(`sitrep: retention pruned ${String(gone.sessions)} sessions, ${String(gone.events)} events and ${String(gone.machines)} machines`);
    }
  });
  const jobs: [run: () => void, ms: number][] = [
    [safely('sweep', () => fleet.sweep()), EVERY.sweep],
    [safely('tick', () => fleet.tick()), EVERY.tick],
    [prune, EVERY.retention],
  ];
  const clocks = jobs.map(([run, ms]) => setInterval(run, ms).unref());
  // Pruning at start too: a server restarted more often than hourly would otherwise never prune.
  prune();
  return () => clocks.forEach((clock) => clearInterval(clock));
}
