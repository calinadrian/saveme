# SaveMe setup

SaveMe talks to Google Drive and OneDrive with **your own** free OAuth client IDs, so no third party ever holds your tokens. Each takes about 5 minutes. The **Folder** option (external drive, NAS, or a Dropbox/OneDrive-synced folder) needs no setup at all.

Put the IDs in either place:

- `.env` in the project root (baked in at build time). Copy `.env.example`.
- `%APPDATA%\SaveMe\config.json` (read at startup; overrides `.env`):

```json
{
  "googleClientId": "1234-abc.apps.googleusercontent.com",
  "googleClientSecret": "GOCSPX-...",
  "microsoftClientId": "00000000-0000-0000-0000-000000000000"
}
```

## Google Drive

1. Open https://console.cloud.google.com/ and create a project (e.g. "SaveMe").
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: choose *External*, fill in an app name and your email. Under **Data access / Scopes**, add `.../auth/drive.file`. Under **Audience → Test users**, add your Google account.
   - While the app is in *Testing*, refresh tokens expire after 7 days. To avoid that, click **Publish app**. `drive.file` is a non-sensitive scope, so Google doesn't need to review it.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type **Desktop app**.
5. Copy the **Client ID** and **Client secret**. For desktop apps the "secret" isn't really secret; Google requires it anyway.

SaveMe only sees files it created itself (a `SaveMe` folder in My Drive). It can't read the rest of your Drive.

## OneDrive

1. Open https://entra.microsoft.com/ → **App registrations → New registration**.
2. Name it "SaveMe". For supported account types, choose **Accounts in any organizational directory and personal Microsoft accounts**.
3. For the redirect URI, choose **Public client/native (mobile & desktop)** and enter `http://localhost`.
4. Register, then copy the **Application (client) ID**.
5. Under **API permissions**, check that *Microsoft Graph → Files.ReadWrite.AppFolder*, *User.Read* and *offline_access* (delegated) are there. Add any that are missing. No admin consent is needed for personal accounts.

Backups go to `OneDrive/Apps/SaveMe`.

## Running

```bash
npm install
npm run dev        # development with hot reload
npm test           # unit tests
npm run package    # installer in dist/ (SaveMe-Setup-<version>.exe)
npm run release    # build, tag and publish a GitHub release (see README)
```

The npm used here blocks install scripts by default, so approve the ones SaveMe needs once:

```bash
npm approve-scripts esbuild koffi electron-winstaller
node node_modules/electron/install.js
```
