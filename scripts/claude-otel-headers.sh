#!/bin/sh
# Claude Code's otelHeadersHelper for SITREP (code.claude.com/docs/en/monitoring-usage, "Dynamic headers"): prints
# the headers Claude Code's OTLP log exporter sends to the server, one JSON object of strings. Claude Code runs it at start and
# every 29 minutes; scripts/install.ts --claude names it in Claude Code's user settings as `/bin/sh <this file>`. POSIX sh, not
# Node, so a version manager or an upgrade that moves Node does not stop it.
#
# X-Sitrep-Machine: the machine id both reporters share, read by their rule (codex-reporter/src/machine.ts:
# `$CLAUDE_CONFIG_DIR` or ~/.claude, the text trimmed, 8 to 32 lowercase hex) and never made here. X-Sitrep-Token: the
# admin secret, alone in ~/.sitrep/claude-otel-token (mode 0600, written by install), so it is never in a settings
# file, argv or a URL; left out when that file is absent or empty, as the plugin sends none with an empty token. The names are
# MACHINE_HEADER and TOKEN_HEADER in server/src/fleet/protocol.ts, repeated here; scripts/doctor.ts checks the output against
# them. A missing machine id, or a file it cannot read, fails it (exit 1, the reason on stderr): Claude Code then exports
# nothing until it works.

fail() {
  printf 'sitrep telemetry headers: %s\n' "$1" >&2
  exit 1
}

# $text without the whitespace around it.
trim_text() {
  text=${text#"${text%%[![:space:]]*}"}
  text=${text%"${text##*[![:space:]]}"}
}

# A file's text, trimmed, in $text; returns 1 when there is no file.
read_trimmed() {
  [ -e "$1" ] || return 1
  text=$(cat -- "$1") || fail "$1 cannot be read"
  trim_text
}

# The id file by the reporters' rule (codex-reporter/src/machine.ts): `$CLAUDE_CONFIG_DIR` trimmed, else ~/.claude, a relative
# one taken from the working directory as path.resolve takes it. Two differences, neither able to send an id no reporter here
# made: `..` after a symlink is followed, not dropped by name, and there only the Claude plugin can have written the file (it
# hands Claude Code the path unresolved; codex-reporter resolves it); JavaScript also trims non-ASCII spaces, so such a value
# names a path no reporter writes to. Where no file is, the helper fails naming the path.
text=$CLAUDE_CONFIG_DIR
trim_text
id_file=${text:-$HOME/.claude}/sitrep-machine-id
read_trimmed "$id_file" || fail "no machine id yet in $id_file; the Claude plugin or codex-reporter makes it when it starts"
case $text in
  '' | *[!0123456789abcdef]*) fail "$id_file holds no machine id" ;;
esac
[ ${#text} -ge 8 ] && [ ${#text} -le 32 ] || fail "$id_file holds no machine id"
id=$text

text=
read_trimmed "$HOME/.sitrep/claude-otel-token"
if [ -n "$text" ]; then
  # A backslash and a double quote are escaped, as a JSON string needs.
  token=$(printf '%s' "$text" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf '{"X-Sitrep-Machine":"%s","X-Sitrep-Token":"%s"}\n' "$id" "$token"
else
  printf '{"X-Sitrep-Machine":"%s"}\n' "$id"
fi
