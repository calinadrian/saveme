import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Forward slashes, no trailing slash. All internal paths use this form. */
export function norm(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  return s.length > 3 && s.endsWith('/') ? s.slice(0, -1) : s
}

export function isUnder(child: string, parent: string): boolean {
  const c = norm(child).toLowerCase()
  const p = norm(parent).toLowerCase()
  return c === p || c.startsWith(p + '/')
}

export interface KnownFolders {
  home: string
  winAppData: string
  winLocalAppData: string
  winLocalAppDataLow: string
  winDocuments: string
  winPublic: string
  winProgramData: string
  winDir: string
  osUserName: string
}

export async function regQuery(key: string, args: string[] = []): Promise<string> {
  try {
    const { stdout } = await run('reg', ['query', key, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    return stdout
  } catch {
    return ''
  }
}

/** Parse `reg query` output into { keyPath: { valueName: value } }. */
export function parseReg(out: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}
  let current = ''
  for (const line of out.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) {
      current = line.trim()
      result[current] = {}
      continue
    }
    const m = /^\s{2,}(.+?)\s{2,}(REG_\w+)\s{2,}(.*)$/.exec(line)
    if (m && current) result[current][m[1]] = m[3].trim()
  }
  return result
}

function expandEnv(s: string): string {
  return s.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`)
}

export async function getKnownFolders(): Promise<KnownFolders> {
  const home = norm(os.homedir())
  const env = (k: string, fallback: string): string => norm(process.env[k] || fallback)
  let documents = home + '/Documents'
  const shell = parseReg(await regQuery('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', ['/v', 'Personal']))
  for (const values of Object.values(shell)) if (values.Personal) documents = norm(expandEnv(values.Personal))
  return {
    home,
    winAppData: env('APPDATA', home + '/AppData/Roaming'),
    winLocalAppData: env('LOCALAPPDATA', home + '/AppData/Local'),
    winLocalAppDataLow: home + '/AppData/LocalLow',
    winDocuments: documents,
    winPublic: env('PUBLIC', 'C:/Users/Public'),
    winProgramData: env('PROGRAMDATA', 'C:/ProgramData'),
    winDir: env('WINDIR', 'C:/Windows'),
    osUserName: os.userInfo().username
  }
}

/**
 * Converts absolute paths to machine-independent ones (`<winAppData>/Foo/save.dat`)
 * so a snapshot taken on one PC can be restored on another.
 */
export class Portable {
  private prefixes: [string, string][]

  constructor(folders: KnownFolders, base?: string) {
    const entries: [string, string][] = [
      ['winLocalAppDataLow', folders.winLocalAppDataLow],
      ['winLocalAppData', folders.winLocalAppData],
      ['winAppData', folders.winAppData],
      ['winDocuments', folders.winDocuments],
      ['winPublic', folders.winPublic],
      ['winProgramData', folders.winProgramData],
      ['winDir', folders.winDir],
      ['home', folders.home]
    ]
    if (base) entries.push(['base', base])
    // Longest prefix first, so <base> inside Documents or AppData inside home wins.
    this.prefixes = entries.map(([k, v]): [string, string] => [k, norm(v)]).sort((a, b) => b[1].length - a[1].length)
  }

  toPortable(abs: string): string {
    const p = norm(abs)
    for (const [token, prefix] of this.prefixes) {
      if (isUnder(p, prefix)) return `<${token}>` + p.slice(prefix.length)
    }
    // Other absolute path: C:/Games/x -> <drive:C>/Games/x
    const m = /^([A-Za-z]):(\/.*)$/.exec(p)
    return m ? `<drive:${m[1].toUpperCase()}>${m[2]}` : p
  }

  fromPortable(portable: string): string | undefined {
    const m = /^<([^>]+)>(.*)$/.exec(portable)
    if (!m) return undefined
    if (m[1].startsWith('drive:')) return `${m[1].slice(6)}:${m[2]}`
    const hit = this.prefixes.find(([token]) => token === m[1])
    return hit ? hit[1] + m[2] : undefined
  }
}

export function safeJoin(...parts: string[]): string {
  return norm(path.join(...parts))
}
