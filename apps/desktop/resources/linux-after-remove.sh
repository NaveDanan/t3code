#!/bin/bash
# Remove desktop integration artifacts created by linux-after-install.sh.
set +e

APP_LINK="/usr/bin/t3code"
ICON_THEME_DIR="/usr/share/icons/hicolor"
PIXMAP_ICON="/usr/share/pixmaps/t3code.png"
DESKTOP_DIR="/usr/share/applications"

if [ -e "$APP_LINK" ]; then
  rm -f "$APP_LINK"
fi

if [ -L "$PIXMAP_ICON" ]; then
  rm -f "$PIXMAP_ICON"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$ICON_THEME_DIR" >/dev/null 2>&1
fi

exit 0