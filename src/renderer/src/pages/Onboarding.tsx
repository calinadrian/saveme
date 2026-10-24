import { useEffect, useId, useState } from 'react'
import { cleanFolder, locationLabel, remoteFolderFor, REMOTE_ROOT_LABEL } from '../../../shared/types'
import type { AppState, ProviderKind } from '../../../shared/types'
import { api, formatBytes, plural, SITE } from '../api'
import { BrandMark, Icon, IconName, InlineError, Spinner, useAction } from '../components'

const PROVIDERS: { kind: ProviderKind; name: string; free: string; note: string; icon: IconName }[] = [
  { kind: 'gdrive', name: 'Google Drive', free: '15 GB free', note: 'SaveMe can only see the files it creates.', icon: 'cloud' },
  { kind: 'onedrive', name: 'OneDrive', free: '5 GB free', note: 'Kept in Apps/SaveMe, away from your other files.', icon: 'cloud' },
  { kind: 'local', name: 'A folder', free: 'Any drive', note: 'External drive, NAS or a folder another app syncs.', icon: 'drive' }
]

export function ProviderPicker({ state, onCancel }: { state: AppState; onCancel?: () => void }) {
  const [selected, setSelected] = useState<ProviderKind>()
  const [busy, setBusy] = useState(false)
  const group = useId()
  return (
    <>
      <fieldset className="providers" disabled={busy}>
        <legend className="sr-only">Where backups go</legend>
        {PROVIDERS.map((p) => (
          <label key={p.kind} className={`provider ${p.kind}${selected === p.kind ? ' selected' : ''}`}>
            <input type="radio" name={group} value={p.kind} checked={selected === p.kind} onChange={() => setSelected(p.kind)} aria-label={p.name} />
            <span className="provider-top">
              <span className="provider-logo">
                <Icon name={p.icon} size={20} />
              </span>
              <span className="provider-free">{p.free}</span>
            </span>
            <strong>{p.name}</strong>
            <span className="muted">{state.provider.configured[p.kind] ? p.note : `Requires your own ${p.kind === 'gdrive' ? 'Google' : 'Microsoft'} app registration, then sign-in.`}</span>
          </label>
        ))}
      </fieldset>
      {PROVIDERS.map(provider => <div key={provider.kind} hidden={selected !== provider.kind}>
        <ConnectPanel
          kind={provider.kind}
          state={state}
          onBusy={setBusy}
          active={selected === provider.kind}
          onCancel={() => {
            setSelected(undefined)
            onCancel?.()
          }}
        />
      </div>)}
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
function ConnectPanel({ kind, state, onCancel, onBusy, active }: { kind: ProviderKind; state: AppState; onCancel: () => void; onBusy: (busy: boolean) => void; active: boolean }) {
  const [run, error, busy] = useAction()
  const [action, setAction] = useState<'connect' | 'browse' | 'link'>('connect')
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const [localRoot, setLocalRoot] = useState(state.settings.localFolder ?? '')
  const [folder, setFolder] = useState(remoteFolderFor(state.settings, kind))
  const needsSetup = kind !== 'local' && !state.provider.configured[kind]
  const google = kind === 'gdrive'
  const name = PROVIDERS.find((p) => p.kind === kind)!.name
  const clean = cleanFolder(folder)
  const ready = (kind === 'onedrive' || clean) && (kind !== 'local' || localRoot.trim()) && (!needsSetup || (id.trim() && (!google || secret.trim())))
  const field = useId()
  useEffect(() => { if (active) onBusy(busy) }, [active, busy, onBusy])

  const connect = (): Promise<void> =>
    run(async () => {
      setAction('connect')
      if (kind === 'local') await api.connect('local', localRoot, clean)
      else if (needsSetup) await api.configureAndConnect(kind, google ? { googleClientId: id, googleClientSecret: secret } : { microsoftClientId: id }, clean)
      else await api.connect(kind, undefined, clean)
    })

  return (
    <form className="card form setup" onSubmit={e => { e.preventDefault(); if (ready && !busy) void connect() }} aria-busy={busy}>
      <h2 className="setup-title">{kind === 'local' ? 'Back up to a folder' : `Connect ${name}`}</h2>
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
                  <button type="button" className="link" disabled={busy} onClick={() => run(async () => { setAction('link'); await api.openUrl(s.url!) })}>
                    Open <Icon name="external" size={13} />
                  </button>
                )}
              </li>
            ))}
          </ol>
          <label>
            {google ? 'Client ID' : 'Application (client) ID'}
            <input required disabled={busy} value={id} onChange={(e) => setId(e.target.value)} placeholder={google ? '1234…apps.googleusercontent.com' : '00000000-0000-0000-0000-000000000000'} />
          </label>
          {google && (
            <label>
              Client secret
              <input required disabled={busy} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="GOCSPX-…" type="password" />
            </label>
          )}
        </>
      )}

      {kind === 'local' && (
        <div className="field">
          <label htmlFor={`${field}-root`}>Drive or folder</label>
          <div className="picker">
            <input id={`${field}-root`} required disabled={busy} value={localRoot} onChange={(e) => setLocalRoot(e.target.value)} placeholder="E:\Backups" />
            <button type="button" className="btn" disabled={busy} onClick={() => run(async () => { setAction('browse'); setLocalRoot((await api.pickFolder('Where should SaveMe keep backups?')) ?? localRoot) })}>
              <Icon name="folder" size={16} /> Browse
            </button>
          </div>
        </div>
      )}
      <label>
        Backup folder
        <div className="folder-field">
          {kind !== 'local' && <span className="folder-root">{REMOTE_ROOT_LABEL[kind]} /</span>}
          <input disabled={busy} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={kind === 'onedrive' ? '(optional subfolder)' : 'SaveMe'} />
        </div>
      </label>
      <p className="muted small">
        Backups will go to <code>{locationLabel(kind, localRoot || '…', clean)}</code>, one subfolder per game.
        {kind === 'onedrive' && ' OneDrive only lets SaveMe use its own Apps/SaveMe folder.'} The folder is created if it doesn't exist.
      </p>

      <InlineError error={error} />
      <span role="status" className="muted small">{busy ? action === 'browse' ? 'Choose a folder in the dialog…' : action === 'link' ? 'Opening setup instructions…' : (kind === 'local' ? 'Connecting…' : 'Finish signing in in your browser. Your entries are kept if sign-in fails.') : ''}</span>
      <div className="actions">
        <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!ready || busy}>
          {busy && action === 'connect' ? (kind === 'local' ? 'Connecting…' : 'Waiting for sign-in in your browser…') : kind === 'local' ? 'Use this folder' : needsSetup ? 'Save and sign in' : 'Sign in'}
        </button>
      </div>
    </form>
  )
}

export function Onboarding({ state, onDone }: { state: AppState; onDone: () => void }) {
  const found = state.games.length
  const size = state.games.reduce((n, g) => n + g.sizeBytes, 0)
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <BrandMark size={56} tile />
        <h1>Never lose a game save again</h1>
        <p className="lead">SaveMe finds your saves, backs them up every time you stop playing, and keeps older versions you can go back to.</p>

        <ol className="onboarding-steps">
          <li className={state.scanning ? 'active' : 'done'}>
            <span className="step-mark">{state.scanning ? <Spinner size={14} /> : <Icon name="check" size={14} />}</span>
            <div>
              <strong>Find your games</strong>
              <span className="muted">
                {state.scanning ? state.scanProgress : found ? `Found saves for ${plural(found, 'game')} (${formatBytes(size)})` : 'No saves found yet. You can add games later.'}
              </span>
            </div>
          </li>
          <li className="active">
            <span className="step-mark">2</span>
            <div>
              <strong>Choose where backups go</strong>
              <span className="muted">Your own cloud or a folder. SaveMe has no servers of its own.</span>
            </div>
          </li>
          <li>
            <span className="step-mark">3</span>
            <div>
              <strong>Play</strong>
              <span className="muted">SaveMe runs in the tray and backs up each game when you close it.</span>
            </div>
          </li>
        </ol>

        <ProviderPicker state={state} />
        <footer className="onboarding-foot">
          <span className="muted">
            By using SaveMe you agree to the{' '}
            <button className="link" onClick={() => api.openUrl(SITE + 'terms.html')}>
              terms
            </button>
            . See how your data is handled in the{' '}
            <button className="link" onClick={() => api.openUrl(SITE + 'privacy.html')}>
              privacy policy
            </button>
            .
          </span>
          <button className="link skip" onClick={onDone}>
            Skip for now
          </button>
        </footer>
      </div>
    </div>
  )
}
