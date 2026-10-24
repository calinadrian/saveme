import fs from 'node:fs'
import { FSWatcher, watch } from 'chokidar'
import { Game } from '../../shared/types'
import { isUnder, KnownFolders } from '../detect/paths'
import { saveDirs } from '../backup/snapshot'

/**
 * Fallback trigger for games we can't see running (no known install folder, emulators,
 * Xbox games): back up once save files have been quiet for a while.
 */
export class FileWatcher {
  private watcher?: FSWatcher
  private dirToGame = new Map<string, string>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private folders: KnownFolders,
    private onQuiet: (gameId: string) => void,
    private isRunning: (gameId: string) => boolean,
    private quietMs = 2 * 60 * 1000
  ) {}

  async setGames(games: Game[]): Promise<void> {
    await this.watcher?.close()
    this.dirToGame.clear()
    for (const g of games) {
      if (!g.tracked) continue
      for (const dir of saveDirs(g, this.folders)) {
        // Saves inside the install folder are covered by the process watcher; watching a whole game install is too heavy.
        if (g.installDir && isUnder(dir, g.installDir)) continue
        if (fs.existsSync(dir)) this.dirToGame.set(dir, g.id)
      }
    }
    if (!this.dirToGame.size) return
    this.watcher = watch([...this.dirToGame.keys()], {
      ignoreInitial: true,
      persistent: true,
      depth: 6,
      // Temp files that apps create and delete mid-write (Steam's *.async123.tmp) can't be watched and aren't saves.
      ignored: (p) => /\.(tmp|log)$|\.async\d+\.tmp$/i.test(p)
    })
    this.watcher.on('all', (_event, file) => this.touched(file))
    // A locked or vanished file must never take the app down; just skip it.
    this.watcher.on('error', (e) => console.warn('[saveme] file watcher:', (e as Error).message))
  }

  private touched(file: string): void {
    for (const [dir, gameId] of this.dirToGame) {
      if (!isUnder(file, dir)) continue
      clearTimeout(this.timers.get(gameId))
      this.timers.set(
        gameId,
        setTimeout(() => {
          this.timers.delete(gameId)
          if (!this.isRunning(gameId)) this.onQuiet(gameId)
        }, this.quietMs)
      )
    }
  }

  async close(): Promise<void> {
    this.timers.forEach(clearTimeout)
    await this.watcher?.close()
  }
}
