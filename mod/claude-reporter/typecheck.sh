#!/usr/bin/env bash
# Type-checks the Claude reporter mod (plugin sitrep-reporter) against Claude Code's plugin API declarations at
# types/claude-code.d.ts. Those declarations are Anthropic's, not SITREP's, and SITREP does not distribute them: Claude
# Code writes them when its bundled plugin-authoring skill loads. Needs `npm ci` at the repository root for TypeScript.
set -euo pipefail

MOD="$(cd "$(dirname "$0")" && pwd)"
TSC="$MOD/../../node_modules/.bin/tsc"
if [[ ! -x "$TSC" ]]; then
  echo "TypeScript not found at $TSC: run npm ci at the repository root." >&2
  exit 2
fi
DECL="$MOD/types/claude-code.d.ts"
if [[ ! -f "$DECL" ]]; then
  echo "Claude Code's plugin API declarations are not at $DECL." >&2
  echo "They are Anthropic's and are not distributed with SITREP. In Claude Code, load the plugin-authoring skill:" >&2
  echo "it writes them as its own types/claude-code.d.ts and names the path. Copy that file to" >&2
  echo "$DECL, then run this again." >&2
  exit 2
fi
"$TSC" -p "$MOD/tsconfig.json"
echo "sitrep-reporter type-check passed"
