import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { capture, inspectArchive, zipFiles } from '../src/main/backup/streaming'
import { Portable } from '../src/main/detect/paths'
import { fakeFolders } from './helpers'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root,{ recursive: true,force: true })))
describe.runIf(process.env.SAVEME_LARGE_TESTS === '1')('large save streaming', () => {
  it.each([{ size: 4 * 1024 ** 3 + 1024, random: false },{ size: 64 * 1024 ** 2, random: true }])('captures, archives and verifies $size bytes with bounded memory (random=$random)', async ({ size,random }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'saveme-large-')); roots.push(root)
    const folders = fakeFolders(root), input = path.join(folders.winAppData,'Game','large.sav')
    fs.mkdirSync(path.dirname(input),{ recursive: true })
    const handle = await fs.promises.open(input,'w')
    try {
      if (!random) await handle.truncate(size)
      else { const chunk = crypto.randomBytes(1024 * 1024); for (let n = 0; n < size; n += chunk.length) await handle.write(chunk) }
    } finally { await handle.close() }
    const baseline = process.memoryUsage().rss
    let peak = baseline, last = Date.now(), maxStall = 0
    const timer = setInterval(() => { peak = Math.max(peak,process.memoryUsage().rss); maxStall = Math.max(maxStall,Date.now() - last); last = Date.now() },20)
    try {
      const state = await capture([input],new Portable(folders),path.join(root,'staged'))
      const zip = path.join(root,'archive.zip')
      await zipFiles(state,{},zip)
      const files = await inspectArchive(zip,{ files: state.hashes,sizeBytes: size },path.join(root,'verified'))
      expect(files).toHaveLength(1)
      expect(fs.statSync(files[0].staged).size).toBe(size)
      expect(peak - baseline).toBeLessThan(192 * 1024 * 1024)
      expect(maxStall).toBeLessThan(500)
      console.log(JSON.stringify({ bytes: size,random,rssIncreaseMiB: Math.round((peak - baseline) / 1024 ** 2),maxEventLoopGapMs: maxStall,zipBytes: fs.statSync(zip).size }))
    } finally { clearInterval(timer) }
  },180_000)
})
