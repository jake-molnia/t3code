#!/bin/sh
set -eu

apt-get update
apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 python3-pip python3-venv ripgrep tini tmux unzip file ffmpeg \
    xfce4-session xfce4-settings xfwm4 xfce4-panel xfdesktop4 xfconf thunar xfce4-terminal \
    dbus-x11 at-spi2-core tigervnc-standalone-server novnc websockify xauth x11-utils xdotool wmctrl scrot xclip \
    fonts-dejavu chromium desktop-file-utils
rm -rf /var/lib/apt/lists/*
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --global --prefix /opt/playwright-mcp --ignore-scripts --no-audit --no-fund @playwright/mcp@0.0.83
ln -s /opt/playwright-mcp/bin/playwright-mcp /usr/local/bin/playwright-mcp
PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers node /opt/playwright-mcp/lib/node_modules/@playwright/mcp/node_modules/playwright/cli.js install ffmpeg
python3 -m venv /opt/markitdown
/opt/markitdown/bin/pip install --no-cache-dir 'markitdown[all]==0.1.8' markitdown-mcp==0.0.1a7
ln -s /opt/markitdown/bin/markitdown /usr/local/bin/markitdown
ln -s /opt/markitdown/bin/markitdown-mcp /usr/local/bin/markitdown-mcp
npm cache clean --force
mkdir -p /tmp/.X11-unix /tmp/.ICE-unix
chmod 1777 /tmp/.X11-unix /tmp/.ICE-unix
