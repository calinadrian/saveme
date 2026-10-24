import { ReactNode, useEffect, useId, useRef, useState } from 'react'
import { cleanFolder, locationLabel, remoteFolderFor, REMOTE_ROOT_LABEL } from '../../../shared/types'
import type { AppState, ProviderKind, RetentionPolicy, UpdateState } from '../../../shared/types'
import { api, formatBytes, refreshUsageWithTimeout, REPO, SITE, timeAgo } from '../api'
import { ActionFeedback, BrandMark, confirmDialog, Icon, IconName, InlineError, PROVIDER_NAMES, PROVIDER_PLACE, ProviderIcon, Spinner, Toggle, useAction } from '../components'
import { ProviderPicker } from './Onboarding'

/** Where people take back SaveMe's access to their account. */
const REVOKE: Partial<Record<ProviderKind, string>> = {
  gdrive: 'https://myaccount.google.com/permissions',
  onedrive: 'https://account.live.com/consent/Manage'
}

export function Settings({ state, update, onOpenUpdate }: { state: AppState; update: UpdateState; onOpenUpdate: () => void }) {
  const [run, error, busy] = useAction()
  const [section, setSection] = useState('storage')
  const sections: { id: string; label: string; icon: IconName }[] = [
    { id: 'storage', label: 'Storage', icon: 'cloud' },
    { id: 'history', label: 'Version history', icon: 'history' },
    { id: 'behavior', label: 'General', icon: 'settings' },
    { id: 'folders', label: 'Game folders', icon: 'games' },
    { id: 'about', label: 'About SaveMe', icon: 'info' }
  ]
  const s = state.settings
  const kind = state.provider.kind

  return (
    <div className="page settings-page">
      <header className="page-head">
        <h1>Settings</h1>
      </header>
      <InlineError error={error} />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings categories">
          {sections.map(item => (
            <button key={item.id} aria-current={section === item.id ? 'page' : undefined} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}>
              <Icon name={item.icon} size={16} />{item.label}
            </button>
          ))}
        </nav>
        <div className="settings-panel">
      {section === 'storage' && <Section icon="cloud" title="Storage" sub="Where your backups go.">
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
              <button className="btn" disabled={busy} onClick={() => run(() => api.refreshQuota())}>
                <Icon name="refresh" size={16} /> Refresh
              </button>
              <button
                className="btn danger-ghost"
                disabled={busy || !!state.operation}
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
      </Section>}

      {section === 'history' && <Section
        icon="history"
        title="Version history"
        sub="Choose how many backups to keep for each game."
      >
        <HistorySettings state={state} />
      </Section>}

      {section === 'behavior' && <Section icon="settings" title="General" sub="How SaveMe works in the background.">
        <Setting title="Start with Windows" sub="Runs quietly in the tray so every play session is backed up.">
          <SettingSwitch setting="startAtLogin" value={s.startAtLogin} label="Start with Windows" />
        </Setting>
        <Setting title="Minimize to tray" sub="Hide SaveMe in the tray when minimized. Turn off to keep it on the taskbar.">
          <SettingSwitch setting="minimizeToTray" value={s.minimizeToTray} label="Minimize to tray" />
        </Setting>
        <Setting title="Notifications" sub="When another PC has a newer save, a backup fails, new games are found, or storage is almost full.">
          <SettingSwitch setting="notifications" value={s.notifications} label="Notifications" />
        </Setting>
        <Setting title="Update automatically" sub="Checks GitHub for a new version every few hours and installs it while SaveMe is idle in the tray.">
          <SettingSwitch setting="autoUpdate" value={s.autoUpdate} label="Update automatically" />
        </Setting>
      </Section>}

      {section === 'folders' && <Section icon="games" title="Game folders" sub="Steam, Epic and GOG games are found automatically. Add folders where you keep other games, like D:\Games.">
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
      </Section>}

      {section === 'about' && <About update={update} onOpenUpdate={onOpenUpdate} />}
        </div>
      </div>
    </div>
  )
}

function Section({ icon, title, sub, children }: { icon: IconName; title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
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

function SettingSwitch({ setting, value, label }: { setting: 'startAtLogin' | 'minimizeToTray' | 'notifications' | 'autoUpdate'; value: boolean; label: string }) {
  const [run, error, busy, saved] = useAction()
  const [on, setOn] = useState(value)
  useEffect(() => { setOn(value) }, [value])
  return <div className="setting-control"><Toggle disabled={busy} on={on} label={label} onChange={next => void run(async () => { const result = await api.updateSettings({ [setting]: next }); setOn(result[setting]) })} /><ActionFeedback busy={busy} saved={saved} error={error} /></div>
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
    <section className="about">
      <div className="about-head">
        <BrandMark size={40} tile />
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
  const field = useId()
  const save = (): Promise<void> =>
    run(async () => {
      const target = locationLabel(kind, state.settings.localFolder, cleanFolder(folder))
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
        <form className="form" onSubmit={e => { e.preventDefault(); if (!busy && (kind === 'onedrive' || cleanFolder(folder))) void save() }}>
          <label htmlFor={field}>Backup subfolder</label>
          <div className="folder-field">
            <span id={`${field}-root`} className="folder-root">{kind === 'local' ? state.settings.localFolder : REMOTE_ROOT_LABEL[kind]} /</span>
            <input id={field} aria-describedby={`${field}-root`} autoFocus disabled={busy} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={kind === 'onedrive' ? '(optional subfolder)' : 'SaveMe'} />
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={busy || (kind !== 'onedrive' && !cleanFolder(folder))}>
              Save
            </button>
          </div>
          <InlineError error={error} />
        </form>
      )}
    </div>
  )
}

function HistorySettings({ state }: { state: AppState }) {
  const policy = state.settings.retention
  const [applied, setApplied] = useState<RetentionPolicy>(policy)
  const [draft, setDraft] = useState(String(policy.keepDaily || policy.keepWeekly || policy.keepLast < 2 ? 3 : policy.keepLast))
  const [validation, setValidation] = useState<string>()
  const [run, error, busy] = useAction()
  const [saved, setSaved] = useState(false)
  const [checkUsage, usageError, checkingUsage] = useAction()
  const field = useId()
  const input = useRef<HTMLInputElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    setApplied(policy)
    setDraft(String(policy.keepDaily || policy.keepWeekly || policy.keepLast < 2 ? 3 : policy.keepLast))
  }, [policy.keepLast, policy.keepDaily, policy.keepWeekly])
  useEffect(() => { void checkUsage(refreshUsageWithTimeout) }, [])
  useEffect(() => { if (!busy && restoreFocus.current) { restoreFocus.current = false; input.current?.focus() } }, [busy])
  const count = Number(draft)
  const valid = /^\d+$/.test(draft) && Number.isInteger(count) && count >= 2 && count <= 365
  const legacy = applied.keepDaily > 0 || applied.keepWeekly > 0
  const changed = legacy || count !== applied.keepLast
  const save = (): void => {
    setSaved(false)
    if (!valid) { setValidation('Enter a whole number from 2 to 365.'); input.current?.focus(); return }
    setValidation(undefined)
    if (!changed) return
    void run(async () => {
      if (legacy || count < applied.keepLast) {
        const ok = await confirmDialog({
          title: 'Reduce backup history?',
          message: <><p>Each game will keep its newest {count} backups. Older backups will be removed after that game’s next successful backup. Local game saves are unaffected.</p><p>Copies protected during a restore may temporarily exceed this limit.</p></>,
          confirm: `Keep ${count} backups per game`, danger: true
        })
        restoreFocus.current = true
        if (!ok) return
      }
      const result = await api.updateSettings({ retention: { keepLast: count, keepDaily: 0, keepWeekly: 0 } })
      setApplied(result.retention)
      setDraft(String(result.retention.keepLast))
      setSaved(true)
    })
  }
  const usage = state.backupUsage
  const checkingLabel = usage?.status === 'loading' && usage.total !== undefined ? `Checking backup storage… ${usage.completed ?? 0} of ${usage.total} games` : 'Checking backup storage…'
  return (
    <div className="history-settings">
      {legacy ? <div className="alert warn">Your existing policy also keeps daily and weekly copies. It stays active until you apply a simple backup limit.</div> : <p className="muted">Current limit: {applied.keepLast} backups per game.</p>}
      <form className="form history-form" noValidate onSubmit={e => { e.preventDefault(); save() }} aria-busy={busy}>
        <div className="number-field">
          <label htmlFor={field}>Backups to keep per game</label>
          <input ref={input} id={field} inputMode="numeric" type="text" disabled={busy} value={draft} aria-invalid={!!validation} aria-describedby={`${field}-help${validation || error ? ` ${field}-error` : ''}`} onChange={e => { setDraft(e.target.value); setValidation(undefined); setSaved(false) }} />
          <span className="muted small">2–365 backups</span>
        </div>
        <p id={`${field}-help`} className="history-explanation">{valid ? `Keeps the newest backup and ${count === 2 ? 'one previous version' : count === 3 ? 'two previous versions' : `${count - 1} previous versions`}. Older backups are removed automatically after a successful backup.` : 'Keep at least two backups so you have a previous version to restore.'}</p>
        <div className="actions"><button type="submit" className="btn primary" disabled={busy || (!changed && valid)}>{busy ? 'Applying…' : legacy && count === 3 ? 'Switch to 3 backups per game' : 'Apply changes'}</button></div>
        <ActionFeedback busy={busy} saved={saved} error={validation || error} errorId={`${field}-error`} />
      </form>
      <div className="backup-usage"><div><strong>Space used by backups</strong><span className="muted" role="status">{checkingUsage ? checkingLabel : !state.provider.connected ? 'Connect storage to see usage.' : usageError ? 'Storage check timed out or failed. Try refreshing again.' : usage?.status === 'ready' ? formatBytes(usage.bytes) : usage?.status === 'loading' ? checkingLabel : 'Storage usage unavailable. Try refreshing again.'}</span></div><button className="btn" disabled={checkingUsage || !state.provider.connected} onClick={() => checkUsage(refreshUsageWithTimeout)}>Refresh usage</button></div>
      <p className="muted small">The limit is per game, not a fixed storage quota. Larger saves use more space. Restore safety copies may temporarily exceed the limit.</p>
    </div>
  )
}
