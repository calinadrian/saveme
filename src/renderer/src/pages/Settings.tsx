import { ReactNode, useState } from 'react'
import { cleanFolder, remoteFolderFor, REMOTE_ROOT_LABEL } from '../../../shared/types'
import type { AppState, ProviderKind, RetentionPolicy, UpdateState } from '../../../shared/types'
import { api, REPO, SITE, timeAgo } from '../api'
import { BrandMark, confirmDialog, Icon, IconName, PROVIDER_NAMES, PROVIDER_PLACE, ProviderIcon, Spinner, Toggle, useAction } from '../components'
import { ProviderPicker } from './Onboarding'

/** Where people take back SaveMe's access to their account. */
const REVOKE: Partial<Record<ProviderKind, string>> = {
  gdrive: 'https://myaccount.google.com/permissions',
  onedrive: 'https://account.live.com/consent/Manage'
}

export function Settings({ state, update, onOpenUpdate }: { state: AppState; update: UpdateState; onOpenUpdate: () => void }) {
  const [run, error] = useAction()
  const s = state.settings
  const setRetention = (patch: Partial<RetentionPolicy>): void => void run(() => api.updateSettings({ retention: { ...s.retention, ...patch } }))
  const kind = state.provider.kind

  return (
    <div className="page narrow">
      <header className="page-head">
        <h1>Settings</h1>
      </header>
      {error && <div className="alert err">{error}</div>}

      <Section icon="cloud" title="Storage" sub="Where your backups go.">
        {state.provider.connected && kind ? (
          <>
            <div className="row connected">
              <span className="tile-icon">
                <ProviderIcon kind={kind} />
              </span>
              <div className="row-main">
                <strong>{PROVIDER_NAMES[kind]}</strong>
                <span className="muted">{kind === 'local' ? 'On this PC or a drive connected to it' : (state.provider.account ?? 'Connected')}</span>
              </div>
              <button className="btn" onClick={() => run(() => api.refreshQuota())}>
                <Icon name="refresh" size={16} /> Refresh
              </button>
              <button
                className="btn danger-ghost"
                onClick={() =>
                  run(async () => {
                    const ok = await confirmDialog({
                      title: `Disconnect ${PROVIDER_PLACE[kind]}?`,
                      message: <p>Backups stop until you connect a storage again. Nothing is deleted: your backups stay in {state.provider.location}.</p>,
                      confirm: 'Disconnect',
                      danger: true
                    })
                    if (ok) await api.disconnect()
                  })
                }
              >
                Disconnect
              </button>
            </div>
            <FolderSetting state={state} />
            {REVOKE[kind] && (
              <p className="muted small">
                Disconnecting removes SaveMe's sign-in from this PC. To withdraw its access completely, also remove SaveMe in your{' '}
                <button className="link" onClick={() => api.openUrl(REVOKE[kind]!)}>
                  {kind === 'gdrive' ? 'Google' : 'Microsoft'} account settings <Icon name="external" size={12} />
                </button>
                .
              </p>
            )}
          </>
        ) : (
          <ProviderPicker state={state} />
        )}
      </Section>

      <Section
        icon="history"
        title="Version history"
        sub={`Older versions are thinned out automatically. Each game keeps up to ${s.retention.keepLast + s.retention.keepDaily + s.retention.keepWeekly} versions.`}
      >
        <div className="fields">
          <NumberField label="Always keep the latest" suffix="versions" value={s.retention.keepLast} onChange={(v) => setRetention({ keepLast: v })} min={1} />
          <NumberField label="Plus one a day for" suffix="days" value={s.retention.keepDaily} onChange={(v) => setRetention({ keepDaily: v })} />
          <NumberField label="Plus one a week for" suffix="weeks" value={s.retention.keepWeekly} onChange={(v) => setRetention({ keepWeekly: v })} />
        </div>
      </Section>

      <Section icon="settings" title="Behavior">
        <Setting title="Start with Windows" sub="Runs quietly in the tray so every play session is backed up.">
          <Toggle on={s.startAtLogin} label="Start with Windows" onChange={(v) => run(() => api.updateSettings({ startAtLogin: v }))} />
        </Setting>
        <Setting title="Notifications" sub="When another PC has a newer save, a backup fails, new games are found, or storage is almost full.">
          <Toggle on={s.notifications} label="Notifications" onChange={(v) => run(() => api.updateSettings({ notifications: v }))} />
        </Setting>
        <Setting title="Update automatically" sub="Checks GitHub for a new version every few hours and installs it while SaveMe is idle in the tray.">
          <Toggle on={s.autoUpdate} label="Update automatically" onChange={(v) => run(() => api.updateSettings({ autoUpdate: v }))} />
        </Setting>
      </Section>

      <Section icon="games" title="Game folders" sub="Steam, Epic and GOG games are found automatically. Add folders where you keep other games, like D:\Games.">
        {s.extraLibraryFolders.length > 0 && (
          <ul className="paths">
            {s.extraLibraryFolders.map((f) => (
              <li key={f}>
                <Icon name="folder" size={15} />
                <code>{f}</code>
                <button className="link" onClick={() => run(() => api.updateSettings({ extraLibraryFolders: s.extraLibraryFolders.filter((x) => x !== f) }))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <button
            className="btn"
            onClick={() =>
              run(async () => {
                const f = await api.pickFolder('Game library folder')
                if (f && !s.extraLibraryFolders.includes(f)) {
                  await api.updateSettings({ extraLibraryFolders: [...s.extraLibraryFolders, f] })
                  await api.scan()
                }
              })
            }
          >
            <Icon name="plus" size={16} /> Add folder
          </button>
        </div>
      </Section>

      <About update={update} onOpenUpdate={onOpenUpdate} />
    </div>
  )
}

function Section({ icon, title, sub, children }: { icon: IconName; title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="card section">
      <div className="section-head">
        <span className="tile-icon">
          <Icon name={icon} />
        </span>
        <div>
          <h2>{title}</h2>
          {sub && <p className="muted">{sub}</p>}
        </div>
      </div>
      <div className="section-body">{children}</div>
    </section>
  )
}

function Setting({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="setting">
      <div>
        <strong>{title}</strong>
        <span className="muted">{sub}</span>
      </div>
      {children}
    </div>
  )
}

function updateLine(u: UpdateState): string {
  switch (u.status) {
    case 'dev':
      return 'Development copy: updates only work in the installed app.'
    case 'checking':
      return 'Checking for updates…'
    case 'downloading':
      return `Downloading ${u.version}… ${u.percent ?? 0}%`
    case 'ready':
      return `Version ${u.version} is ready to install.`
    case 'installing':
      return 'Restarting to install the update…'
    case 'latest':
      return `You have the latest version. Checked ${timeAgo(u.checkedAt)}.`
    case 'error':
      return u.message ?? 'The update check failed.'
    default:
      return 'Updates come from SaveMe’s GitHub releases.'
  }
}

function About({ update, onOpenUpdate }: { update: UpdateState; onOpenUpdate: () => void }) {
  const busy = ['checking', 'downloading', 'installing'].includes(update.status)
  const links: { label: string; icon: IconName; open: () => void }[] = [
    { label: 'Website', icon: 'external', open: () => api.openUrl(SITE) },
    { label: 'Privacy policy', icon: 'doc', open: () => api.openUrl(SITE + 'privacy.html') },
    { label: 'Terms of use', icon: 'doc', open: () => api.openUrl(SITE + 'terms.html') },
    { label: 'Open-source licenses', icon: 'code', open: () => api.openLicenses() },
    { label: 'Source code', icon: 'code', open: () => api.openUrl(REPO) },
    { label: 'Report a problem', icon: 'alert', open: () => api.openUrl(REPO + '/issues') }
  ]
  return (
    <section className="card about">
      <div className="about-head">
        <BrandMark size={48} tile />
        <div className="about-title">
          <strong>SaveMe {update.current}</strong>
          <span className={'muted' + (update.status === 'error' ? ' err-text' : '')} role="status">
            {busy && <Spinner size={11} />} {updateLine(update)}
          </span>
        </div>
        {update.status === 'ready' ? (
          <button className="btn primary" onClick={onOpenUpdate}>
            <Icon name="download" size={16} /> Restart and update
          </button>
        ) : (
          <button className="btn" disabled={update.status === 'dev' || busy} onClick={() => void api.checkForUpdate()}>
            <Icon name="refresh" size={16} /> Check for updates
          </button>
        )}
      </div>
      <div className="link-grid">
        {links.map((l) => (
          <button key={l.label} className="link-tile" onClick={l.open}>
            <Icon name={l.icon} size={15} />
            {l.label}
          </button>
        ))}
      </div>
      <p className="legal muted">
        © 2026 calinadrian. Free software under the MIT License, provided as is, without warranty. Save locations come from the Ludusavi manifest (MIT), compiled from PCGamingWiki. SaveMe isn't
        affiliated with or endorsed by Valve, Epic Games, GOG, Google or Microsoft; game names, artwork and the names of these services are trademarks of their owners.
      </p>
    </section>
  )
}

function FolderSetting({ state }: { state: AppState }) {
  const kind = state.provider.kind!
  const [editing, setEditing] = useState(false)
  const [folder, setFolder] = useState(remoteFolderFor(state.settings, kind))
  const [run, error, busy] = useAction()
  const save = (): Promise<void> =>
    run(async () => {
      const target = [REMOTE_ROOT_LABEL[kind] || state.settings.localFolder, cleanFolder(folder)].filter(Boolean).join('/')
      const ok = await confirmDialog({
        title: 'Move future backups?',
        message: (
          <p>
            New backups will go to <code>{target}</code>. Backups already in the old folder stay where they are.
          </p>
        ),
        confirm: 'Use this folder'
      })
      if (!ok) return
      await api.setRemoteFolder(folder)
      setEditing(false)
    })
  return (
    <div className="setting-folder">
      {!editing ? (
        <div className="row">
          <div className="row-main">
            <span className="muted">Backups go to</span>
            <code>{state.provider.location}</code>
          </div>
          <button className="btn" onClick={() => setEditing(true)}>
            <Icon name="folder" size={16} /> Change folder
          </button>
        </div>
      ) : (
        <div className="form">
          <div className="folder-field">
            <span className="folder-root">{kind === 'local' ? state.settings.localFolder : REMOTE_ROOT_LABEL[kind]} /</span>
            <input autoFocus value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={kind === 'onedrive' ? '(optional subfolder)' : 'SaveMe'} />
            <button className="btn ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || (kind !== 'onedrive' && !cleanFolder(folder))} onClick={save}>
              Save
            </button>
          </div>
          {error && <div className="alert err">{error}</div>}
        </div>
      )}
    </div>
  )
}

function NumberField({ label, suffix, value, onChange, min = 0 }: { label: string; suffix: string; value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <input type="number" min={min} max={365} value={value} onChange={(e) => onChange(Math.max(min, Number(e.target.value) || 0))} />
      <span className="muted">{suffix}</span>
    </label>
  )
}
