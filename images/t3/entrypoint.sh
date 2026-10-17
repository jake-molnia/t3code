#!/bin/sh
set -eu
umask 077
# T3 publishes a separate configuration for each provider session.
unset OPENCODE_CONFIG OPENCODE_DISABLE_PROJECT_CONFIG
mkdir -p "$HOME" "$CODEX_HOME" "$T3_WORKER_STATE_DIR"
for directory in "$HOME/.agents" "$HOME/.claude"; do
    mkdir -p "$directory"
    if [ ! -e "$directory/skills" ] && [ ! -L "$directory/skills" ]; then
        ln -s /opt/agent-skills "$directory/skills"
    fi
done
/usr/local/bin/t3-configure-git
python3 /opt/t3/configure-editor.py "$T3_WORKER_STATE_DIR" /opt/code-server/lib/vscode/extensions/t3-sandbox-defaults/package.json
exec agent-runtime t3-session
