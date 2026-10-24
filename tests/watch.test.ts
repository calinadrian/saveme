import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { saveDirs } from '../src/main/backup/snapshot'
import { norm } from '../src/main/detect/paths'
import { resolveTemplate } from '../src/main/detect/scanner'
import { fakeFolders } from './helpers'

describe('watched folders', () => {
  it('watches the matched save folders, not the whole wildcard prefix', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saveme-'))
    const folders = fakeFolders(root)
    const steam = norm(path.join(root, 'Steam'))
    const save = `${steam}/userdata/12345678/2246340/remote/win64_save`
    fs.mkdirSync(save, { recursive: true })
    fs.writeFileSync(`${save}/data.bin`, 'x')
    fs.mkdirSync(`${steam}/userdata/12345678/config`, { recursive: true })

    const resolved = resolveTemplate('<root>/userdata/<storeUserId>/2246340/remote/win64_save', { folders, root: steam })!
    const dirs = saveDirs({ roots: [{ template: '', resolved }] }, folders)
    expect(dirs).toEqual([save])
  })
})
