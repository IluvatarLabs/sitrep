// The reporters' shared configuration: the environment, or a `.env` file in the working directory, like the server's. codex-reporter
// and hermes-reporter both read it, so one env file serves both.
//
//   CODEX_REPORTER_SERVER_URL     the dashboard server (default http://127.0.0.1:7487, the server's default port)
//   CODEX_REPORTER_TOKEN          the admin secret, sent as X-Sitrep-Token

try {
  process.loadEnvFile();
} catch {
  // no .env here: the environment alone
}
export const env = (k: string) => process.env[k]?.trim() ?? '';
export const serverUrl = env('CODEX_REPORTER_SERVER_URL') || 'http://127.0.0.1:7487';
export const token = env('CODEX_REPORTER_TOKEN');
