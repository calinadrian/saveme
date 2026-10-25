# SaveMe

Automatic game-save backup for Windows, to Google Drive, OneDrive or any folder.

**[Download for Windows](https://github.com/calinadrian/saveme/releases/latest)** · [Website](https://calinadrian.github.io/saveme/) · [Privacy](https://calinadrian.github.io/saveme/privacy.html) · [Terms](https://calinadrian.github.io/saveme/terms.html)

- **Finds saves on its own.** It uses the [Ludusavi manifest](https://github.com/mtkennerly/ludusavi-manifest) (save locations for 20k+ games) together with your Steam, Epic and GOG installs.
- **Backs up when you stop playing.** It watches game processes and uploads a few seconds after the game closes. Games it can't see running are backed up once their save files go quiet.
- **Only uploads what changed.** Files are hashed, so a session without saving uploads nothing.
- **Keeps a small version history.** New installations keep the newest backup and two previous versions per game. Change the limit in Settings → Version history; older backups are removed after a successful backup. Existing daily/weekly policies stay active until you choose to switch. Restoring preserves your current files first.
- **Works across PCs.** If another PC has a newer save, you get a notification. A fresh PC never overwrites the cloud with an empty new-game save.
- **Checks recovery copies.** Verify a backup without changing saves, name important versions, and pin a protected copy until you unpin it. Restore shows which files change and which extra local files stay.
- **Handles large saves.** File staging, streaming ZIP64 archives, and chunked cloud uploads keep memory bounded. Progress shows the current stage and transferred bytes.
- **Shows your storage.** Free space and how much SaveMe uses.
- **Lives in the tray.** It starts with Windows and stays out of the way.
- **Updates itself** from GitHub releases.

Backups are plain ZIP files under `SaveMe/<game>/`, with independent history records under `<game>/_v2/`. Pinned copies have `.pin.zip` names. You can extract the archives without the app.

**History format 2:** every PC sharing this storage must use this build or a newer build supporting format 2. Existing backups are imported automatically without rewriting their legacy indexes or archives. Older SaveMe builds cannot discover new versions and must not keep writing to the same storage. Import commits are idempotent; retention can remove an imported archive only after its history record is durable and the archive is available.

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

### Backup and restore safety

Backups, restores, verification, history changes, and storage changes share one operation coordinator on each PC. Backups wait while the game is running and hash the same disk-staged bytes that are put into the ZIP. Unreadable or changing files abort the capture rather than producing a partial version. Temporary space is checked before capture and extraction; abandoned operation staging is cleaned on startup separately from restore recovery files.

Restore validates all archive paths, file hashes, and declared size before replacing files. It downloads the selected version before making the pre-restore backup, and protects that version from retention during the operation. A local journal under `%APPDATA%\SaveMe\restore-recovery` preserves previous files until replacement completes. An interrupted restore is rolled back on the next launch before watchers start. If rollback fails, automatic backups stop and the recovery files are retained; resolve the reported problem and restart SaveMe to retry recovery.

Local settings keep a validated previous copy (`state.json.bak`). Unreadable settings are preserved separately; SaveMe reports recovery and refuses to start automatic backups if neither copy can be loaded. History metadata commits before archive cleanup, and failed catalog updates or cleanup jobs are persisted for retry.

Format 2 publishes a unique snapshot record after its archive upload completes. Discovery merges those records instead of updating shared catalogs. Independent events record names, pins, unpins, and pruning decisions; unresolved branch tips stay protected until you explicitly restore or keep a save. Pins use separate verified archive copies, so a concurrent retention operation cannot remove the only protected copy after pinning succeeds. An unpin only removes pins it has observed. Pinned versions, unresolved branches, and active restore copies can exceed the normal history limit.

Folder synchronization is eventually consistent: SaveMe reports incomplete history and defers cleanup while referenced records or archives have not arrived. Google Drive discovery combines duplicate named folders and uses stable file IDs. Metadata records remain after archive pruning so delayed clients cannot resurrect deleted history. Failed archive cleanup is retried from committed pruning/unpin records.

Restore compares the selected backup with current files and checks that the comparison is still current before replacement. Extra local files are kept. **Verify backup** checks archive paths, sizes, duplicate entries, and SHA-256 hashes without touching live saves; its latest result is stored locally for that destination. Pinned versions stay until unpinned and can use additional storage.

**Settings → About SaveMe → Export diagnostics** previews and saves a local ZIP with readable and JSON reports. It includes app/runtime versions, storage health, counts, and fixed classifications of recent events. Credentials, account details, personal paths, raw error text, and save contents are excluded. Nothing is sent automatically.

`npm test` covers injected backup, restore, retention, and recovery failures. After building, `node_modules/.bin/electron scripts/safety-ui-smoke.cjs` exercises status reporting, history error/retry, keyboard dialogs, and the minimum window size using synthetic state and an isolated profile.

The concurrency/provider tests cover simultaneous snapshot commits, different games, duplicate Drive folders, legacy migration, pin/prune races, cloud upload offset recovery, stale restore comparisons, and diagnostic redaction. Run the optional large-save cases in PowerShell with `$env:SAVEME_LARGE_TESTS='1'; npx vitest run tests/large-save.test.ts`; they exercise a save larger than 4 GiB and incompressible data, assert bounded memory, and measure event-loop responsiveness. Test temporary files should use a writable directory without glob metacharacters; on restricted Windows hosts set `TEMP` and `TMP` to a project-local `.tmp` directory. The junction test needs permission to create a temporary Windows junction.

`node_modules/.bin/electron scripts/ui-refinement-smoke.cjs` also checks startup retry, keyboard library navigation and view restoration, safe restore confirmations, forms, retention validation, save feedback, and accessibility-tree names. It exercises all screens at 1100×780, 820×580, and 200% app zoom, with emulated high-contrast and reduced-motion preferences. Add `--scale=1.25` or `--scale=1.5` for device-scaling emulation without changing Windows display settings. These automated checks inspect the accessibility tree; an audible Narrator session remains a separate manual check.

After `npm run package:test`, run `node_modules/.bin/electron scripts/packaged-smoke.cjs` to exercise the actual testing ASAR and its packaged dependencies through the real preload and IPC handlers. It uses synthetic saves and an isolated profile for backup, verification, naming, pinning, restore comparison, restore, unpinning, and diagnostics. The test runner retains the development Windows identity and does not change startup settings or shortcuts.

Backup storage usage is a separate read-only scan, with up to four folders checked at once. It has a 20-second deadline, reports progress, and can be retried after failure without holding up backups or restores. Changing storage or starting a new backup invalidates an older scan. The renderer also releases its pending control after 25 seconds if an IPC reply is lost.

### Releasing

1. Commit your changes, then `npm version patch` (or `minor`) to bump the version.
2. `npm run release`: checks GitHub authentication, builds and verifies the installer, pushes the commit and its `v<version>` tag,
   uploads the installer, blockmap and `latest.yml` to a draft release, then publishes it. Release notes are grouped from the
   commit subjects since the last tag (New / Fixed / Improved) and show up in the app's update dialog.
   Needs the GitHub CLI signed in (`gh auth login`). A failed upload leaves a draft that the same command can retry.
   Sign-in client IDs come from `.env` at build time; the script warns if they're missing.

`npm run package` builds the main app and installer into `dist/main/` without publishing. Run the app from `dist/main/win-unpacked/SaveMe.exe`.

`npm run package:test` builds a testing copy into `dist/testing/`. These are the only two build directories: reuse them for subsequent builds instead of creating dated or per-fix folders. Quit the app before rebuilding its copy if Windows locks the executable. The release script also reads its installer and update manifest from `dist/main/`.
