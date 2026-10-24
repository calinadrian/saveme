import type { AppState, ProviderKind, RetentionPolicy } from '../../../shared/types'
import { api } from '../api'
import { Toggle, useAction } from '../components'
import { ProviderPicker } from './Onboarding'

export function Settings({ state }: { state: AppState }) {
  const [run, error] = useAction()
  const s = state.settings
  const setRetention = (patch: Partial<RetentionPolicy>): void => void run(() => api.updateSettings({ retention: { ...s.retention, ...patch } }))
  const names: Record<ProviderKind, string> = { gdrive: 'Google Drive', onedrive: 'OneDrive', local: 'Local folder' }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Settings</h1>
      </header>
      {error && <div className="alert err">{error}</div>}

      <section className="card">
        <h2>Cloud storage</h2>
        {state.provider.connected && state.provider.kind ? (
          <div className="row">
            <div className="row-main">
              <strong>{names[state.provider.kind]}</strong>
              <span className="muted">{state.provider.account}</span>
            </div>
            <button className="btn" onClick={() => run(() => api.refreshQuota())}>Refresh</button>
            <button className="btn danger" onClick={() => confirm('Disconnect? Backups stop until you connect again. Nothing is deleted from the cloud.') && run(() => api.disconnect())}>
              Disconnect
            </button>
          </div>
        ) : (
          <ProviderPicker state={state} />
        )}
      </section>

      <section className="card">
        <h2>Version history</h2>
        <p className="muted">Older versions are thinned out automatically to save space.</p>
        <div className="fields">
          <NumberField label="Always keep the latest" suffix="versions" value={s.retention.keepLast} onChange={(v) => setRetention({ keepLast: v })} min={1} />
          <NumberField label="Plus one per day for" suffix="days" value={s.retention.keepDaily} onChange={(v) => setRetention({ keepDaily: v })} />
          <NumberField label="Plus one per week for" suffix="weeks" value={s.retention.keepWeekly} onChange={(v) => setRetention({ keepWeekly: v })} />
        </div>
      </section>

      <section className="card">
        <h2>Behavior</h2>
        <label className="setting">
          <div>
            <strong>Start with Windows</strong>
            <span className="muted">Runs quietly in the tray so every play session is backed up.</span>
          </div>
          <Toggle on={s.startAtLogin} onChange={(v) => run(() => api.updateSettings({ startAtLogin: v }))} />
        </label>
        <label className="setting">
          <div>
            <strong>Notifications</strong>
            <span className="muted">A quiet toast after each backup, and when another PC has a newer save.</span>
          </div>
          <Toggle on={s.notifications} onChange={(v) => run(() => api.updateSettings({ notifications: v }))} />
        </label>
      </section>

      <section className="card">
        <h2>Extra game folders</h2>
        <p className="muted">Steam, Epic and GOG are found automatically. Add folders where you keep other games (e.g. D:\Games).</p>
        <ul className="paths">
          {s.extraLibraryFolders.map((f) => (
            <li key={f}>
              <code>{f}</code>
              <button className="link" onClick={() => run(() => api.updateSettings({ extraLibraryFolders: s.extraLibraryFolders.filter((x) => x !== f) }))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
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
          Add folder
        </button>
      </section>

      <section className="card about">
        <h2>About</h2>
        <p className="muted">
          SaveMe 0.1 · Save locations come from the <strong>Ludusavi manifest</strong> (MIT), built from PCGamingWiki. Backups are zip files under <code>SaveMe/</code> in your storage, so you can always get to them without this app.
        </p>
      </section>
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
