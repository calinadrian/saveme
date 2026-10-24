# SaveMe

<!-- impeccable:product-schema 1 -->

## Platform

Windows desktop app, built with Electron and React.

## Product Purpose

Back up PC game saves automatically to the user's Google Drive, OneDrive, or chosen folder. Preserve the existing storage, restore, game detection, retention, and update workflows.

## Operating Context

The user launches the packaged executable from dist and expects the same identity in the app, Start menu, tray, and Windows taskbar. Development runs must not claim the packaged app's Windows identity.

Keep only two distribution directories: `dist/main` for the main build and `dist/testing` for a testing copy. Reuse these paths; do not create dated, archived, or per-fix distribution folders. If a running app locks its build directory, wait for it to be closed rather than creating another output directory. The main executable is `dist/main/win-unpacked/SaveMe.exe`.

## Brand Commitments

The name is SaveMe. The user asked for a compact, minimal dark UI, a slimmer sidebar, less card framing, and tidy settings rows. No decorative gradients or button glow. The icon should be recognizable at taskbar size, with the familiarity of major gaming apps; the latest explicit direction is a floppy disk, the game-save symbol.

The user chose Steam blue (#1a9fff from their supplied screenshot) for the icon and UI accents.

## Capabilities and Constraints

Keep real game covers and offline artwork caching. Preserve user data and settings across upgrades. Do not publish releases or push Git changes without the user's request.

Minimize sends the app to the tray by default. Settings → General offers a persistent choice to minimize to the taskbar instead. Opening SaveMe from the tray or launching it again restores the window.
