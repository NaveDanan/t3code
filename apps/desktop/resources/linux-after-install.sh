#!/bin/bash
# Fix chrome-sandbox permissions and desktop integration for Electron on Linux.
# This script runs as root after deb/rpm installation via the package manager.
set +e

APP_BIN="/opt/NJ Code (Alpha)/t3code"
APP_LINK="/usr/bin/t3code"
ICON_THEME_DIR="/usr/share/icons/hicolor"
PIXMAP_ICON="/usr/share/pixmaps/t3code.png"
DESKTOP_DIR="/usr/share/applications"

if [ -x "$APP_BIN" ]; then
  cat >"$APP_LINK" <<'EOF'
#!/bin/bash
set -e

APP_BIN="/opt/NJ Code (Alpha)/t3code"

if [ "${T3CODE_ENABLE_WAYLAND:-}" = "1" ]; then
  exec "$APP_BIN" --no-sandbox "$@"
fi

exec "$APP_BIN" --no-sandbox --ozone-platform=x11 --disable-gpu --disable-software-rasterizer "$@"
EOF
  chmod 0755 "$APP_LINK"
fi

if [ -f "$ICON_THEME_DIR/1024x1024/apps/t3code.png" ]; then
  ln -sf "$ICON_THEME_DIR/1024x1024/apps/t3code.png" "$PIXMAP_ICON"
fi

if [ -f "$DESKTOP_DIR/t3code.desktop" ]; then
  sed -i 's|^Exec=.*|Exec=/usr/bin/t3code %U|' "$DESKTOP_DIR/t3code.desktop"
fi

# Resolve the install directory from the packaged binary path first.
find_sandbox_via_app_bin() {
  if [ -x "$APP_BIN" ]; then
    local install_dir
    install_dir=$(dirname "$APP_BIN")
    local sandbox="$install_dir/chrome-sandbox"
    if [ -f "$sandbox" ]; then
      echo "$sandbox"
    fi
  fi
}

# Fallback: search the common install prefixes used by electron-builder.
find_sandbox_via_find() {
  find /opt /usr/lib -maxdepth 2 -name "chrome-sandbox" 2>/dev/null | head -1
}

CHROME_SANDBOX=$(find_sandbox_via_app_bin)
if [ -z "$CHROME_SANDBOX" ]; then
  CHROME_SANDBOX=$(find_sandbox_via_find)
fi

if [ -n "$CHROME_SANDBOX" ] && [ -f "$CHROME_SANDBOX" ]; then
  chown root:root "$CHROME_SANDBOX"
  chmod 4755 "$CHROME_SANDBOX"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$ICON_THEME_DIR" >/dev/null 2>&1
fi

# Always exit 0 — a missing sandbox must not abort the package install.
exit 0
