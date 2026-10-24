# SaveMe

Automatic game-save backup for Windows, to Google Drive, OneDrive or any folder.

- **Finds saves on its own.** It uses the [Ludusavi manifest](https://github.com/mtkennerly/ludusavi-manifest) (save locations for 20k+ games) together with your Steam, Epic and GOG installs.
- **Backs up when you stop playing.** It watches game processes and uploads a few seconds after the game closes. Games it can't see running are backed up once their save files go quiet.
- **Only uploads what changed.** Files are hashed, so a session without saving uploads nothing.
- **Keeps a version history.** By default: the last 10 versions, plus 1 per day for 2 weeks, plus 1 per week for 8 weeks. Restore any version in one click; your current save is always backed up first.
- **Works across PCs.** If another PC has a newer save, you get a notification. A fresh PC never overwrites the cloud with an empty new-game save.
- **Shows your storage.** Free space and how much SaveMe uses.
- **Lives in the tray.** It starts with Windows and stays out of the way.

Backups are plain zip files under `SaveMe/<game>/`, plus an `index.json`, so you can always get to them without the app.

See [docs/SETUP.md](docs/SETUP.md) to connect Google Drive or OneDrive.

## Layout

| Path | What |
| --- | --- |
| `src/main/detect` | manifest download, Steam/Epic/GOG detection, placeholder resolution, scanning |
| `src/main/backup` | snapshots (hash, zip, extract), retention, backup/restore/sync engine |
| `src/main/cloud` | `StorageProvider` + Google Drive, OneDrive, local folder; OAuth (PKCE, loopback) |
| `src/main/watch` | process watcher (Win32 via koffi), file watcher (chokidar) |
| `src/main/app.ts` | ties it together; `index.ts` handles the window and tray; `ipc.ts` handles the UI calls |
| `src/renderer` | React UI |
| `tests` | vitest: detection, retention, two-PC backup/restore scenarios |

`node scripts/scan-test.ts <manifest.yaml>` (via `npx tsx`) prints what a scan finds on this PC.
