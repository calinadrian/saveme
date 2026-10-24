import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createUpdates, releaseSections, Updater } from '../src/main/updates'
// @ts-expect-error plain ESM script without types
import { releaseNotes } from '../scripts/release.mjs'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function fixture() {
  const updater = Object.assign(new EventEmitter(), { autoDownload: false, autoInstallOnAppQuit: false, autoRunAppAfterInstall: false }) as EventEmitter & Updater
  let checks = 0
  const installs: unknown[][] = []
  updater.checkForUpdates = async () => {
    checks++
  }
  updater.quitAndInstall = (...args: unknown[]) => void installs.push(args)
  const updates = createUpdates({ current: '0.1.0', updater })
  return { updater, updates, checks: () => checks, installs }
}

describe('release notes', () => {
  it('reads GitHub HTML, entities, markdown, missing notes and multi-release notes', () => {
    expect(releaseSections('<h3>Fixed</h3><ul><li>Keep <code>A &amp; B</code> &#8212; working</li></ul><script>bad()</script>')).toEqual([{ title: 'Fixed', items: ['Keep A & B — working'] }])
    expect(releaseSections([{ note: '### New\n- One' }, { note: '### Fixed\n* Two' }])).toEqual([
      { title: 'New', items: ['One'] },
      { title: 'Fixed', items: ['Two'] }
    ])
    expect(releaseSections(null)).toEqual([])
    expect(releaseSections('<h3>Fixed</h3><ul><li>Keep &lt;tag&gt; labels</li></ul>')).toEqual([{ title: 'Fixed', items: ['Keep <tag> labels'] }])
    expect(releaseSections('Plain release notes')).toEqual([{ title: '', items: ['Plain release notes'] }])
  })

  it('groups commit subjects for a release', () => {
    expect(releaseNotes(['0.1.1', 'feat: New feature', 'Fix a crash', 'Improve the games list'])).toBe(
      '### New\n- feat: New feature\n\n### Fixed\n- Fix a crash\n\n### Improved\n- Improve the games list'
    )
    expect(releaseNotes([''])).toBe('### Improved\n- Maintenance release')
  })
})

describe('updates', () => {
  it('serializes checks; a ready update installs once and keeps notes the download omits', async () => {
    const f = fixture()
    f.updates.install()
    expect(f.installs).toHaveLength(0)
    expect(f.updates.check().status).toBe('checking')
    f.updates.check()
    await tick()
    expect(f.checks()).toBe(1)
    expect([f.updater.autoDownload, f.updater.autoInstallOnAppQuit, f.updater.autoRunAppAfterInstall]).toEqual([true, true, true])
    f.updater.emit('update-available', { version: '0.1.1', releaseNotes: '### Fixed\n- A crash' })
    f.updater.emit('download-progress', { percent: 42.4 })
    expect(f.updates.get().percent).toBe(42)
    f.updates.check()
    expect(f.checks()).toBe(1)
    f.updater.emit('update-downloaded', { version: '0.1.1' })
    expect(f.updates.get()).toMatchObject({ status: 'ready', version: '0.1.1', notes: [{ title: 'Fixed', items: ['A crash'] }] })
    f.updates.install()
    f.updates.install()
    expect(f.updates.get().status).toBe('installing')
    expect(f.installs).toEqual([[true, true]])
  })

  it('recovers from network failures, rejected checks and failed installs', async () => {
    const f = fixture()
    f.updater.checkForUpdates = async () => {
      throw Error('net::ERR_INTERNET_DISCONNECTED')
    }
    f.updates.check()
    await tick()
    expect(f.updates.get().status).toBe('error')
    expect(f.updates.get().message).toMatch(/connection/)
    f.updater.checkForUpdates = async () => f.updater.emit('update-not-available', {})
    f.updates.check()
    await tick()
    expect(f.updates.get()).toMatchObject({ status: 'latest', notes: [] })
    f.updater.emit('update-downloaded', { version: '0.1.1' })
    f.updater.quitAndInstall = () => void f.updater.emit('error', Error('Installer failed'))
    f.updates.install()
    expect(f.updates.get().status).toBe('error')
    f.updates.check()
    await tick()
    expect(f.updates.get().status).toBe('latest')
  })

  it('treats a repository without releases as up to date', async () => {
    const f = fixture()
    f.updater.checkForUpdates = async () => {
      throw Error('No published versions on GitHub')
    }
    f.updates.check()
    await tick()
    expect(f.updates.get()).toMatchObject({ status: 'latest', message: undefined })
  })

  it('never checks or installs in a development copy', () => {
    const updates = createUpdates({ current: '0.1.1' })
    expect(updates.check().status).toBe('dev')
    updates.install()
    expect(updates.get().status).toBe('dev')
  })

  it('tells the UI about every change', () => {
    const seen: string[] = []
    const updater = Object.assign(new EventEmitter(), { checkForUpdates: async () => undefined, quitAndInstall: () => undefined }) as unknown as Updater & EventEmitter
    createUpdates({ current: '0.1.0', updater, publish: (s) => seen.push(s.status) })
    updater.emit('checking-for-update')
    updater.emit('update-available', { version: '0.2.0' })
    updater.emit('update-downloaded', { version: '0.2.0' })
    expect(seen).toEqual(['checking', 'downloading', 'ready'])
  })
})
