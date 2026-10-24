import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { norm } from '../detect/paths'

const run = promisify(execFile)

type Lister = () => Promise<string[]>

/** Win32 process listing through koffi (no native build step). */
function koffiLister(): Lister | undefined {
  try {
    const koffi = createRequire(import.meta.url)('koffi')
    const k32 = koffi.load('kernel32.dll')
    const EnumProcesses = k32.func('bool __stdcall K32EnumProcesses(_Out_ uint32_t *pids, uint32_t cb, _Out_ uint32_t *needed)')
    const OpenProcess = k32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)')
    const CloseHandle = k32.func('bool __stdcall CloseHandle(void *h)')
    const QueryName = k32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)')
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    const cache = new Map<number, string>()

    return async () => {
      const pids = new Uint32Array(4096)
      const needed = [0]
      if (!EnumProcesses(pids, pids.byteLength, needed)) return []
      const count = needed[0] / 4
      const alive = new Set<number>()
      const out: string[] = []
      for (let i = 0; i < count; i++) {
        const pid = pids[i]
        if (!pid) continue
        alive.add(pid)
        let p = cache.get(pid)
        if (p === undefined) {
          p = ''
          const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
          if (h) {
            const buf = new Uint16Array(1024)
            const size = [buf.length]
            if (QueryName(h, 0, buf, size)) p = norm(Buffer.from(buf.buffer, 0, size[0] * 2).toString('utf16le'))
            CloseHandle(h)
          }
          cache.set(pid, p)
        }
        if (p) out.push(p)
      }
      for (const pid of cache.keys()) if (!alive.has(pid)) cache.delete(pid)
      return out
    }
  } catch {
    return undefined
  }
}

/** Slower fallback if koffi cannot load. */
const powershellLister: Lister = async () => {
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', 'Get-Process | Where-Object Path | ForEach-Object Path'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return stdout.split(/\r?\n/).filter(Boolean).map(norm)
  } catch {
    return []
  }
}

export interface WatchedGame {
  id: string
  installDir: string
}

/**
 * Polls running processes; a game counts as running while any executable inside its
 * install folder is alive. Calls back on start and exit.
 */
export class ProcessWatcher {
  running = new Set<string>()
  private games: { id: string; dir: string }[] = []
  private timer?: NodeJS.Timeout
  private lister: Lister
  private interval: number

  constructor(
    private onStart: (gameId: string) => void,
    private onExit: (gameId: string) => void
  ) {
    const fast = koffiLister()
    this.lister = fast ?? powershellLister
    this.interval = fast ? 5000 : 15000
  }

  setGames(games: WatchedGame[]): void {
    this.games = games.filter((g) => g.installDir).map((g) => ({ id: g.id, dir: norm(g.installDir).toLowerCase() + '/' }))
  }

  start(): void {
    const tick = async (): Promise<void> => {
      try {
        await this.poll()
      } finally {
        this.timer = setTimeout(tick, this.interval)
      }
    }
    void tick()
  }

  stop(): void {
    clearTimeout(this.timer)
  }

  async poll(): Promise<void> {
    const paths = (await this.lister()).map((p) => p.toLowerCase())
    const now = new Set<string>()
    for (const g of this.games) if (paths.some((p) => p.startsWith(g.dir))) now.add(g.id)
    for (const id of now) if (!this.running.has(id)) this.onStart(id)
    for (const id of this.running) if (!now.has(id)) this.onExit(id)
    this.running = now
  }
}
