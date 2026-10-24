import { useState } from 'react'
import { cleanFolder, remoteFolderFor, REMOTE_ROOT_LABEL } from '../../../shared/types'
import type { AppState, ProviderKind } from '../../../shared/types'
import { api, formatBytes } from '../api'
import { useAction } from '../components'

const PROVIDERS: { kind: ProviderKind; name: string; free: string; note: string }[] = [
  { kind: 'gdrive', name: 'Google Drive', free: '15 GB free', note: 'SaveMe can only see the files it creates.' },
  { kind: 'onedrive', name: 'OneDrive', free: '5 GB free', note: 'Stored under Apps/SaveMe.' },
  { kind: 'local', name: 'Folder', free: 'Any drive', note: 'External drive, NAS or a synced folder.' }
]

export function ProviderPicker({ state, onCancel }: { state: AppState; onCancel?: () => void }) {
  const [selected, setSelected] = useState<ProviderKind>()
  return (
    <>
      <div className="providers">
        {PROVIDERS.map((p) => (
          <button key={p.kind} className={`provider ${p.kind}${selected === p.kind ? ' selected' : ''}`} onClick={() => setSelected(p.kind)}>
            <span className="provider-logo" />
            <strong>{p.name}</strong>
            <span className="provider-free">{p.free}</span>
            <span className="muted">{state.provider.configured[p.kind] ? p.note : 'One-time setup, then sign in'}</span>
          </button>
        ))}
      </div>
      {selected && (
        <ConnectPanel
          key={selected}
          kind={selected}
          state={state}
          onCancel={() => {
            setSelected(undefined)
            onCancel?.()
          }}
        />
      )}
    </>
  )
}

const GOOGLE_STEPS = [
  { text: 'Create a project and turn on the Google Drive API', url: 'https://console.cloud.google.com/apis/library/drive.googleapis.com' },
  { text: 'Set up the consent screen: External, add your email as a test user, then Publish app', url: 'https://console.cloud.google.com/auth/overview' },
  { text: 'Create credentials → OAuth client ID → Desktop app, and copy the ID and secret', url: 'https://console.cloud.google.com/apis/credentials' }
]

const MICROSOFT_STEPS = [
  { text: 'New registration: any name, "Accounts in any directory and personal Microsoft accounts"', url: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade' },
  { text: 'Redirect URI: "Public client/native (mobile & desktop)" with http://localhost, then Register' },
  { text: 'Copy the Application (client) ID from the Overview page' }
]

/**
 * Chooses where backups go, then connects. For Google Drive / OneDrive without a client ID yet,
 * it first walks through the one-time app registration.
 */
function ConnectPanel({ kind, state, onCancel }: { kind: ProviderKind; state: AppState; onCancel: () => void }) {
  const [run, error, busy] = useAction()
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const [localRoot, setLocalRoot] = useState(state.settings.localFolder ?? '')
  const [folder, setFolder] = useState(remoteFolderFor(state.settings, kind))
  const needsSetup = kind !== 'local' && !state.provider.configured[kind]
  const google = kind === 'gdrive'
  const name = PROVIDERS.find((p) => p.kind === kind)!.name
  const clean = cleanFolder(folder)
  const ready = (kind === 'onedrive' || clean) && (kind !== 'local' || localRoot) && (!needsSetup || (id.trim() && (!google || secret.trim())))

  const connect = (): Promise<void> =>
    run(async () => {
      if (kind === 'local') await api.connect('local', localRoot, clean)
      else if (needsSetup) await api.configureAndConnect(kind, google ? { googleClientId: id, googleClientSecret: secret } : { microsoftClientId: id }, clean)
      else await api.connect(kind, undefined, clean)
    })

  return (
    <div className="card form setup">
      <h2>Connect {name}</h2>
      {needsSetup && (
        <>
          <p className="muted">
            One-time setup: {google ? 'Google' : 'Microsoft'} only lets registered apps sign in. Registering your own copy of SaveMe is free and takes about 5 minutes.
          </p>
          <ol className="steps">
            {(google ? GOOGLE_STEPS : MICROSOFT_STEPS).map((s) => (
              <li key={s.text}>
                {s.text}
                {s.url && (
                  <button className="link" onClick={() => api.openUrl(s.url!)}>
                    Open ↗
                  </button>
                )}
              </li>
            ))}
          </ol>
          <label>
            {google ? 'Client ID' : 'Application (client) ID'}
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder={google ? '1234…apps.googleusercontent.com' : '00000000-0000-0000-0000-000000000000'} />
          </label>
          {google && (
            <label>
              Client secret
              <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="GOCSPX-…" type="password" />
            </label>
          )}
        </>
      )}

      {kind === 'local' && (
        <label>
          Drive or folder
          <div className="picker">
            <input value={localRoot} onChange={(e) => setLocalRoot(e.target.value)} placeholder="E:\Backups" />
            <button className="btn" onClick={async () => setLocalRoot((await api.pickFolder('Where should SaveMe keep backups?')) ?? localRoot)}>
              Browse
            </button>
          </div>
        </label>
      )}
      <label>
        Backup folder
        <div className="folder-field">
          {kind !== 'local' && <span className="folder-root">{REMOTE_ROOT_LABEL[kind]} /</span>}
          <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={kind === 'onedrive' ? '(optional subfolder)' : 'SaveMe'} />
        </div>
      </label>
      <p className="muted small">
        Backups will go to <code>{[kind === 'local' ? localRoot || '…' : REMOTE_ROOT_LABEL[kind], clean].filter(Boolean).join('/')}</code>, one subfolder per game.
        {kind === 'onedrive' && ' OneDrive only lets SaveMe use its own Apps/SaveMe folder.'} The folder is created if it doesn't exist.
      </p>

      {error && <div className="alert err">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!ready || busy} onClick={connect}>
          {busy ? (kind === 'local' ? 'Connecting…' : 'Waiting for sign-in in your browser…') : kind === 'local' ? 'Use this folder' : needsSetup ? 'Save and sign in' : 'Sign in'}
        </button>
      </div>
    </div>
  )
}

export function Onboarding({ state, onDone }: { state: AppState; onDone: () => void }) {
  const found = state.games.length
  const size = state.games.reduce((n, g) => n + g.sizeBytes, 0)
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="brand big">
          <span className="logo">S</span>
          <span>SaveMe</span>
        </div>
        <h1>Never lose a game save again</h1>
        <p className="lead">SaveMe finds your game saves, backs them up after every play session, and keeps older versions you can go back to.</p>

        <div className="scan-status">
          {state.scanning ? (
            <>
              <span className="spinner" /> {state.scanProgress}
            </>
          ) : found ? (
            <>
              ✓ Found saves for <strong>{found} games</strong> ({formatBytes(size)})
            </>
          ) : (
            'No game saves found yet.'
          )}
        </div>

        <h2>Where should backups go?</h2>
        <ProviderPicker state={state} />
        <button className="link skip" onClick={onDone}>
          Skip for now
        </button>
      </div>
    </div>
  )
}
