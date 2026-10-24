import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compactManifest } from '../src/main/detect/manifest'
import { norm, Portable } from '../src/main/detect/paths'
import { fakeFolders } from './helpers'
import { expandFiles, literalPrefix, resolveGame, resolveTemplate } from '../src/main/detect/scanner'
import { parseVdf } from '../src/main/detect/vdf'
import { steamLibraries } from '../src/main/detect/launchers'


function write(file: string, content = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-'))

describe('placeholders', () => {
  const folders = fakeFolders('C:/root')

  it('expands known folders and leaves store ids as wildcards', () => {
    expect(resolveTemplate('<winAppData>/Foo/<storeUserId>/*.sav', { folders })).toBe('C:/root/Users/player/AppData/Roaming/Foo/*/*.sav')
  })

  it('needs an install folder for <base>', () => {
    expect(resolveTemplate('<base>/saves', { folders })).toBeUndefined()
    expect(resolveTemplate('<base>/saves', { folders, base: 'D:/Games/Foo (Deluxe)' })).toBe('D:/Games/Foo \\(Deluxe\\)/saves')
  })

  it('finds the glob-free prefix', () => {
    expect(literalPrefix('C:/a/b/*/c.sav')).toBe('C:/a/b')
    expect(literalPrefix('C:/a/b')).toBe('C:/a/b')
  })
})

describe('portable paths', () => {
  const a = new Portable(fakeFolders('C:/pcA'), 'C:/pcA/Games/Foo')
  const b = new Portable(fakeFolders('E:/pcB'), 'D:/Steam/common/Foo')

  it('maps files between machines', () => {
    const p = a.toPortable('C:/pcA/Users/player/AppData/LocalLow/Studio/Game/save.dat')
    expect(p).toBe('<winLocalAppDataLow>/Studio/Game/save.dat')
    expect(b.fromPortable(p)).toBe('E:/pcB/Users/player/AppData/LocalLow/Studio/Game/save.dat')
  })

  it('maps the install folder and other drives', () => {
    expect(b.fromPortable(a.toPortable('C:/pcA/Games/Foo/save/1.sav'))).toBe('D:/Steam/common/Foo/save/1.sav')
    expect(a.toPortable('F:/Emu/saves/x.srm')).toBe('<drive:F>/Emu/saves/x.srm')
    expect(b.fromPortable('<drive:F>/Emu/saves/x.srm')).toBe('F:/Emu/saves/x.srm')
  })
})

describe('steam files', () => {
  it('parses libraryfolders.vdf', () => {
    const root = tmp()
    write(
      path.join(root, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders"\n{\n  "0"\n  {\n    "path"  "${root.replace(/\\/g, '\\\\')}"\n  }\n  "1"\n  {\n    "path"  "D:\\\\SteamLibrary"\n    "apps" { "123" "456" }\n  }\n}`
    )
    expect(steamLibraries(root)).toEqual([norm(root), 'D:/SteamLibrary'])
  })

  it('parses nested keyvalues', () => {
    expect(parseVdf('"AppState" { "appid" "367520" "installdir" "Hollow Knight" }')).toEqual({ AppState: { appid: '367520', installdir: 'Hollow Knight' } })
  })
})

describe('scanning', () => {
  it('finds files from manifest entries and skips logs', () => {
    const root = tmp()
    const folders = fakeFolders(root)
    write(folders.winLocalAppDataLow + '/Team Cherry/Hollow Knight/user1.dat')
    write(folders.winLocalAppDataLow + '/Team Cherry/Hollow Knight/user1.dat.bak')
    write(folders.winLocalAppData + '/Pioneer/Saved/SaveGames/slot.sav')
    write(folders.winLocalAppData + '/Pioneer/Saved/Logs/game.log')
    const [hk, pioneer] = compactManifest({
      'Hollow Knight': {
        files: {
          '<home>/AppData/LocalLow/Team Cherry/Hollow Knight/*.dat': { when: [{ os: 'windows' }] },
          '<xdgConfig>/unity3d/Team Cherry/Hollow Knight/*.dat': { when: [{ os: 'linux' }] }
        }
      },
      Pioneer: { files: { '<winLocalAppData>/Pioneer/Saved': null } }
    })
    expect(hk.files).toHaveLength(1)
    expect(resolveGame(hk, folders).files.map((f) => path.basename(f))).toEqual(['user1.dat'])
    expect(resolveGame(pioneer, folders).files.map((f) => path.basename(f))).toEqual(['slot.sav'])
  })

  it('never backs up a whole known folder', () => {
    const root = tmp()
    const folders = fakeFolders(root)
    write(folders.winDocuments + '/notes.txt')
    expect(expandFiles(folders.winDocuments, folders)).toEqual([])
  })
})
