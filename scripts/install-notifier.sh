#!/usr/bin/env bash
# Assemble, ad-hoc sign, and install the FleetNotifier.app notification helper.
# UNUserNotificationCenter requires a signed, registered app bundle; ad-hoc
# signing is enough for local builds, but the bundle must live in a real
# Applications folder (temporary directories cannot register on macOS 26).
#
# usage: install-notifier.sh [--quiet] [dest-dir]   (default: ~/Applications)
#
# --quiet installs/refreshes the app without requesting permission — used by
# the automatic `fleet install`; macOS then asks with the first real
# notification. Without --quiet the helper's --setup runs after a successful
# build so an explicit `scripts/install-notifier.sh` registers the bundle,
# asks for permission, and reports the result.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
src="$DIR/scripts/notifier/FleetNotifier.swift"

# Not macOS, or the toolchain is missing: degrade gracefully. Never fail a
# `fleet install` over the helper.
[ "$(uname -s)" = Darwin ] || { echo "fleet: FleetNotifier is macOS-only — skipping" >&2; exit 0; }
command -v swiftc >/dev/null 2>&1 || { echo "fleet: swiftc not found — skipping FleetNotifier install" >&2; exit 0; }
command -v codesign >/dev/null 2>&1 || { echo "fleet: codesign not found — skipping FleetNotifier install" >&2; exit 0; }

quiet=0
if [ "${1:-}" = "--quiet" ]; then
  quiet=1
  shift
fi
dest="${1:-$HOME/Applications}"

if [ ! -f "$src" ]; then
  echo "fleet: FleetNotifier.swift not found at $src — skipping" >&2
  exit 0
fi

app="$dest/FleetNotifier.app"
exe="$app/Contents/MacOS/fleet-notifier"
plist="$app/Contents/Info.plist"

# Idempotent: skip the compile + sign when the installed binary is at least as
# new as the source. A `touch` of the .swift or a source pull refreshes it.
if [ -x "$exe" ] && [ -f "$plist" ] && [ "$(stat -f %m "$exe")" -ge "$(stat -f %m "$src")" ]; then
  echo "FleetNotifier.app already up to date"
else
  version="$(grep -m 1 '"version"' "$DIR/package.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')"
  : "${version:=0.0.0}"

  # xcrun finds the active toolchain; fall back to a bare swiftc on PATH.
  if command -v xcrun >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1; then
    swiftc=(xcrun swiftc)
  else
    swiftc=(swiftc)
  fi

  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.nicknisi.fleet.notifier</string>
	<key>CFBundleName</key>
	<string>FleetNotifier</string>
	<key>CFBundleDisplayName</key>
	<string>FleetNotifier</string>
	<key>CFBundleExecutable</key>
	<string>fleet-notifier</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$version</string>
	<key>CFBundleVersion</key>
	<string>$version</string>
	<key>LSUIElement</key>
	<true/>
</dict>
</plist>
PLIST

  if ! "${swiftc[@]}" "$src" -O -framework Cocoa -framework UserNotifications -o "$exe" 2>"$dest/.fleet-notifier-build.log"; then
    echo "fleet: FleetNotifier compile failed — skipping" >&2
    cat "$dest/.fleet-notifier-build.log" >&2 || true
    rm -f "$dest/.fleet-notifier-build.log"
    exit 0
  fi
  rm -f "$dest/.fleet-notifier-build.log"

  if ! codesign --force --sign - "$app" >/dev/null 2>&1; then
    echo "fleet: FleetNotifier codesign failed — skipping" >&2
    rm -rf "$app"
    exit 0
  fi
  echo "installed $app"
fi

[ "$quiet" = 1 ] && exit 0

# --setup registers the bundle, asks for permission, waits for the user's
# answer, and posts a test notification when granted.
if "$exe" --setup; then
  echo "✓ click-to-jump notifications enabled"
else
  echo "Notifications are off. Enable: System Settings → Notifications → FleetNotifier."
fi
