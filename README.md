# SaveMe

Automatic game-save backup for Windows, to Google Drive, OneDrive or any folder.

**[Download for Windows](https://github.com/calinadrian/saveme/releases/latest)** · [Website](https://calinadrian.github.io/saveme/) · [Privacy](https://calinadrian.github.io/saveme/privacy.html) · [Terms](https://calinadrian.github.io/saveme/terms.html)

- **Finds saves on its own.** It uses the [Ludusavi manifest](https://github.com/mtkennerly/ludusavi-manifest) (save locations for 20k+ games) together with your Steam, Epic and GOG installs.
- **Backs up when you stop playing.** It watches game processes and uploads a few seconds after the game closes. Games it can't see running are backed up once their save files go quiet.
- **Only uploads what changed.** Files are hashed, so a session without saving uploads nothing.
- **Keeps a version history.** By default: the last 10 versions, plus 1 per day for 2 weeks, plus 1 per week for 8 weeks. Restore any version in one click; your current save is always backed up first.
- **Works across PCs.** If another PC has a newer save, you get a notification. A fresh PC never overwrites the cloud with an empty new-game save.
- **Shows your storage.** Free space and how much SaveMe uses.
- **Lives in the tray.** It starts with Windows and stays out of the way.
- **Updates itself** from GitHub releases.

Backups are plain zip files under `SaveMe/<game>/`, plus an `index.json`, so you can always get to them without the app.

## Install on Windows

1. Open the [latest release](https://github.com/calinadrian/saveme/releases/latest) and download `SaveMe-Setup-<version>.exe` from **Assets**.
2. Run it. It installs for your user only, so no administrator rights are needed, and SaveMe opens when it's done.
   The installer isn't code-signed yet, so Windows SmartScreen may warn about an unknown publisher: choose **More info → Run anyway**.
3. Pick where backups go: Google Drive, OneDrive or a folder.

Uninstall from **Settings → Apps**. This removes SaveMe and its local data (`%APPDATA%\SaveMe`); your backups stay in your storage.

## Updates

The installed app checks GitHub for a new release on launch and every six hours, and downloads it in the background.
When it's ready, choose **Restart and update**, or **Later**: SaveMe then updates itself the next time it's idle in the tray (no game running, nothing to back up), or when it quits.
Your games, backups and settings are kept.

To check by hand, click the version at the bottom of the sidebar or use **Settings → Check for updates**. **Settings → Update automatically** turns automatic checks off.

## Privacy and license

SaveMe has no servers: saves go straight from your PC to your own storage, and nothing is sent to the developer. Details are in the [privacy policy](https://calinadrian.github.io/saveme/privacy.html) ([Română](https://calinadrian.github.io/saveme/ro/confidentialitate.html)).

SaveMe is free software under the [MIT License](LICENSE). Third-party licenses ship with the app (Settings → Open-source licenses). To report a security problem, see [SECURITY.md](SECURITY.md).

SaveMe isn't affiliated with Valve, Epic Games, GOG, Google or Microsoft.

## Development

See [docs/SETUP.md](docs/SETUP.md) to connect Google Drive or OneDrive and to run from source.

| Path | What |
| --- | --- |
| `src/main/detect` | manifest download, Steam/Epic/GOG detection, placeholder resolution, scanning |
| `src/main/backup` | snapshots (hash, zip, extract), retention, backup/restore/sync engine |
| `src/main/cloud` | `StorageProvider` + Google Drive, OneDrive, local folder; OAuth (PKCE, loopback) |
| `src/main/watch` | process watcher (Win32 via koffi), file watcher (chokidar) |
| `src/main/updates.ts` | app updates from GitHub releases (electron-updater) |
| `src/main/app.ts` | ties it together; `index.ts` handles the window, tray and update timing; `ipc.ts` handles the UI calls |
| `src/renderer` | React UI |
| `build/installer.nsh` | NSIS additions (uninstall also removes "Start with Windows") |
| `scripts` | icons, third-party notices, release |
| `docs` | the website (GitHub Pages), including the privacy policy and terms in English and Romanian |
| `tests` | vitest: detection, retention, two-PC backup/restore scenarios, updater |

`node scripts/scan-test.ts <manifest.yaml>` (via `npx tsx`) prints what a scan finds on this PC.

### Releasing

1. Commit your changes, then `npm version patch` (or `minor`) to bump the version.
2. `npm run release`: checks GitHub authentication, builds and verifies the installer, pushes the commit and its `v<version>` tag,
   uploads the installer, blockmap and `latest.yml` to a draft release, then publishes it. Release notes are grouped from the
   commit subjects since the last tag (New / Fixed / Improved) and show up in the app's update dialog.
   Needs the GitHub CLI signed in (`gh auth login`). A failed upload leaves a draft that the same command can retry.
   Sign-in client IDs come from `.env` at build time; the script warns if they're missing.

`npm run package` builds the same installer into `dist/` without publishing.
