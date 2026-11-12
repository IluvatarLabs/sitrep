#!/usr/bin/env node
// Writes the release's version, the root package.json's, into the two plugin manifests npm does not manage: the Claude Code
// plugin's and the Codex plugin's. npm runs it as the root package's `version` script, after
//   npm version <version> --workspaces --include-workspace-root --no-git-tag-version
// has written the number into every package.json and the lockfile. A manifest that is missing or is not JSON stops it.
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
for (const file of ['mod/claude-reporter/.claude-plugin/plugin.json', 'codex-reporter/plugin/.codex-plugin/plugin.json']) {
  const manifest = JSON.parse(fs.readFileSync(new URL(file, root), 'utf8'));
  manifest.version = version;
  // The manifests' own layout, two-space indent and a final newline, so the version line is the only one that changes.
  fs.writeFileSync(new URL(file, root), `${JSON.stringify(manifest, null, 2)}\n`);
}
