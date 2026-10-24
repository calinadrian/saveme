import fs from 'node:fs'
import path from 'node:path'
import { norm, parseReg, regQuery } from './paths'
import { parseVdf, Vdf } from './vdf'

export interface InstalledGame {
  store: 'steam' | 'epic' | 'gog' | 'custom'
  name: string
  installDir: string
  steamId?: number
  gogId?: number
}

export interface LauncherInfo {
  steamRoot?: string
  games: InstalledGame[]
}

async function steamRoot(): Promise<string | undefined> {
  const reg = parseReg(await regQuery('HKCU\\Software\\Valve\\Steam', ['/v', 'SteamPath']))
  for (const values of Object.values(reg)) if (values.SteamPath) return norm(values.SteamPath)
  const fallback = 'C:/Program Files (x86)/Steam'
  return fs.existsSync(fallback) ? fallback : undefined
}

export function steamLibraries(root: string): string[] {
  const libs = new Set<string>([norm(root)])
  try {
    const vdf = parseVdf(fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8'))
    const folders = (vdf.libraryfolders ?? vdf.LibraryFolders) as Vdf | undefined
    for (const entry of Object.values(folders ?? {})) {
      if (typeof entry === 'object' && typeof entry.path === 'string') libs.add(norm(entry.path))
      else if (typeof entry === 'string' && /[\\/]/.test(entry)) libs.add(norm(entry)) // old format
    }
  } catch {
    // no libraryfolders.vdf: just the main library
  }
  const unique = new Map([...libs].map((l) => [l.toLowerCase(), l]))
  return [...unique.values()]
}

export function steamGamesInLibrary(lib: string): InstalledGame[] {
  const dir = path.join(lib, 'steamapps')
  const games: InstalledGame[] = []
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => /^appmanifest_\d+\.acf$/i.test(f))
  } catch {
    return games
  }
  for (const f of files) {
    try {
      const app = parseVdf(fs.readFileSync(path.join(dir, f), 'utf8')).AppState as Vdf
      const installdir = app.installdir as string
      const full = norm(path.join(dir, 'common', installdir))
      if (installdir && fs.existsSync(full)) {
        games.push({ store: 'steam', name: String(app.name ?? installdir), installDir: full, steamId: Number(app.appid) })
      }
    } catch {
      // skip unreadable manifest
    }
  }
  return games
}

function epicGames(): InstalledGame[] {
  const dir = 'C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests'
  const games: InstalledGame[] = []
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.item'))
  } catch {
    return games
  }
  for (const f of files) {
    try {
      const item = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (item.bIsApplication === false || !item.InstallLocation) continue
      games.push({ store: 'epic', name: item.DisplayName, installDir: norm(item.InstallLocation) })
    } catch {
      // skip
    }
  }
  return games
}

async function gogGames(): Promise<InstalledGame[]> {
  const games: InstalledGame[] = []
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', 'HKLM\\SOFTWARE\\GOG.com\\Games']) {
    const reg = parseReg(await regQuery(key, ['/s']))
    for (const values of Object.values(reg)) {
      if (values.path && values.gameName && fs.existsSync(values.path)) {
        games.push({ store: 'gog', name: values.gameName, installDir: norm(values.path), gogId: Number(values.gameID) || undefined })
      }
    }
    if (games.length) break
  }
  return games
}

/** Every immediate subfolder of a user-chosen library is treated as a possible game install. */
function folderGames(folders: string[]): InstalledGame[] {
  const games: InstalledGame[] = []
  for (const folder of folders) {
    try {
      for (const d of fs.readdirSync(folder, { withFileTypes: true })) {
        if (d.isDirectory()) games.push({ store: 'custom', name: d.name, installDir: norm(path.join(folder, d.name)) })
      }
    } catch {
      // folder gone
    }
  }
  return games
}

export async function findInstalledGames(extraFolders: string[]): Promise<LauncherInfo> {
  const root = await steamRoot()
  const steam = root ? steamLibraries(root).flatMap(steamGamesInLibrary) : []
  return { steamRoot: root, games: [...steam, ...epicGames(), ...(await gogGames()), ...folderGames(extraFolders)] }
}
