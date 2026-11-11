// localStorage that never throws: a private window, blocked storage or a test environment falls back quietly.
export const KEY_PREFIX = "sitrep.";

/** The stored value, or `fallback` when there is none, storage is blocked, or what is stored is not JSON. */
export function readJson<T>(key: string, fallback: T): T {
  let value = fallback;
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + key);
    if (raw !== null) value = JSON.parse(raw) as T;
  } catch {
    value = fallback;
  }
  return value;
}

/** Stores `value` as JSON; undefined removes the key. */
export function writeJson(key: string, value: unknown): void {
  const name = KEY_PREFIX + key;
  try {
    if (value === undefined) window.localStorage.removeItem(name);
    else window.localStorage.setItem(name, JSON.stringify(value));
  } catch {
    // Storage is unavailable: the choice lasts until the page reloads.
  }
}
