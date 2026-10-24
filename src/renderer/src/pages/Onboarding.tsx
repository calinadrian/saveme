import { useState } from 'react'
import type { AppState, ProviderKind } from '../../../shared/types'
import { api, formatBytes } from '../api'
import { useAction } from '../components'

const PROVIDERS: { kind: ProviderKind; name: string; free: string; note: string }[] = [
  { kind: 'gdrive', name: 'Google Drive', free: '15 GB free', note: 'SaveMe can only see the files it creates.' },
  { kind: 'onedrive', name: 'OneDrive', free: '5 GB free', note: 'Stored in Apps/SaveMe.' },
  { kind: 'local', name: 'Folder', free: 'Any drive', note: 'External drive, NAS or a synced folder.' }
]

export function ProviderPicker({ state }: { state: AppState }) {
  const [run, error, busy] = useAction()
  const [setup, setSetup] = useState<'gdrive' | 'onedrive'>()
  const connect = (kind: ProviderKind): Promise<void> =>
    run(async () => {
      if (kind === 'local') {
        const folder = await api.pickFolder('Where should SaveMe keep backups?')
        if (folder) await api.connect('local', folder)
      } else if (!state.provider.configured[kind]) {
        setSetup(kind)
      } else {
        await api.connect(kind)
      }
    })
  return (
    <>
      <div className="providers">
        {PROVIDERS.map((p) => (
          <button key={p.kind} className={`provider ${p.kind}${setup === p.kind ? ' selected' : ''}`} disabled={busy} onClick={() => connect(p.kind)}>
            <span className="provider-logo" />
            <strong>{p.name}</strong>
            <span className="provider-free">{p.free}</span>
            <span className="muted">{state.provider.configured[p.kind] ? p.note : 'One-time setup, then sign in'}</span>
          </button>
        ))}
      </div>
      {setup && <ProviderSetup kind={setup} onCancel={() => setSetup(undefined)} />}
      {busy && <p className="muted">Finish signing in in your browser…</p>}
      {error && <div className="alert err">{error}</div>}
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

/** One-time OAuth app registration, done inside SaveMe; signs in as soon as the IDs are saved. */
function ProviderSetup({ kind, onCancel }: { kind: 'gdrive' | 'onedrive'; onCancel: () => void }) {
  const [run, error, busy] = useAction()
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const google = kind === 'gdrive'
  const steps = google ? GOOGLE_STEPS : MICROSOFT_STEPS
  const ready = google ? id.trim() && secret.trim() : id.trim()
  const save = (): Promise<void> =>
    run(() => api.configureAndConnect(kind, google ? { googleClientId: id, googleClientSecret: secret } : { microsoftClientId: id }))

  return (
    <div className="card form setup">
      <h2>Connect {google ? 'Google Drive' : 'OneDrive'}, one-time setup</h2>
      <p className="muted">
        {google ? 'Google' : 'Microsoft'} only lets registered apps sign in. Registering your own copy of SaveMe is free and takes about 5 minutes. After that, signing in is one click.
      </p>
      <ol className="steps">
        {steps.map((s) => (
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
      {error && <div className="alert err">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!ready || busy} onClick={save}>
          {busy ? 'Waiting for sign-in…' : 'Save and sign in'}
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
