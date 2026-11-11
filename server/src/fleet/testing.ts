// What the fleet's test files share: the contract fixtures, the shipped prices and an in-memory fleet. Only tests import it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetDb, openDb } from './db.js';
import { DEFAULT_CONFIG, Fleet, type FleetConfig } from './fleet.js';
import { litellmPrices, parsePrices, Pricing, readJson } from './pricing.js';
import { validateReport, type Provider, type Report } from './protocol.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A shared contract fixture (docs/fixtures/report.<provider>.json), validated as the report route would. */
export function fixture(provider: Provider): Report {
  const v = validateReport(JSON.parse(readFileSync(path.join(REPO_ROOT, 'docs', 'fixtures', `report.${provider}.json`), 'utf8')));
  if (!v.ok) throw new Error(`fixture ${provider} is invalid at ${v.path}: ${v.error}`);
  return v.report;
}

export const TEST_CONFIG: FleetConfig = { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' };

/** The prices the server ships: its copy of LiteLLM's table with prices.json over it, as a start with LiteLLM out of reach has them. */
export function shippedPrices(): Pricing {
  const file = (name: string): string => path.join(REPO_ROOT, 'server', name);
  return new Pricing({ ...litellmPrices(readJson(file('model_prices_and_context_window.json'))), ...parsePrices(readJson(file('prices.json'))) });
}

/** A fleet on an in-memory database with the shipped prices and the given clock. */
export function testFleet(now: () => number, cfg: Partial<FleetConfig> = {}, db = new FleetDb(openDb(':memory:'))): Fleet {
  return new Fleet(db, { ...TEST_CONFIG, ...cfg }, shippedPrices(), now);
}
