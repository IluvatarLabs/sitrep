// The reporters' shared configuration: the environment, or a `.env` file in the working directory, like the server's. codex-reporter
// and hermes-reporter both read it, so one env file serves both.
//
//   CODEX_REPORTER_SERVER_URL     the dashboard server (default http://127.0.0.1:7487, the server's default port)
//   CODEX_REPORTER_TOKEN          the admin secret, sent as X-Sitrep-Token
//   CODEX_REPORTER_CAPTURE        what of each session's record is sent: off, trace (its rows, no text; the default)
//                                 or full (rows with their text, redacted on the machine); anything else stops the reporter
import { CAPTURE_LEVELS, type CaptureLevel } from '../../server/src/fleet/protocol.js';

try {
  process.loadEnvFile();
} catch {
  // no .env here: the environment alone
}
export const env = (k: string) => process.env[k]?.trim() ?? '';
export const serverUrl = env('CODEX_REPORTER_SERVER_URL') || 'http://127.0.0.1:7487';
export const token = env('CODEX_REPORTER_TOKEN');

const rawCapture = env('CODEX_REPORTER_CAPTURE').toLowerCase() || 'trace';
// A bad value stops the reporter at start, as a bad switch stops the server (server/src/fleet/settings.ts envSwitch).
if (!(CAPTURE_LEVELS as readonly string[]).includes(rawCapture)) throw new Error(`CODEX_REPORTER_CAPTURE: "${rawCapture}" is not off, trace or full`);
export const capture = rawCapture as CaptureLevel;
