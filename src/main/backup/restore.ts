import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { RestoreFile } from './snapshot'

interface Journal {
  entries: { target: string; original?: string; staged: string }[]
}

export class RecoveryRequiredError extends Error {}

/** Refuse junctions/symlinks: a lexical path check alone does not bound Windows writes. */
async function checkTarget(target: string): Promise<void> {
  let current = path.resolve(target)
  for (;;) {
    try {
      const st = await fs.lstat(current)
      if (st.isSymbolicLink()) throw new Error(`Restore destination contains a link: ${current}`)
      if (current === path.resolve(target) && !st.isFile()) throw new Error(`Restore destination is not a file: ${current}`)
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

async function replace(target: string, data: Buffer): Promise<void> {
  await checkTarget(target)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.saveme-${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, data, { flag: 'wx', flush: true })
    await checkTarget(target)
    await fs.rename(temporary, target)
  } finally { await fs.rm(temporary, { force: true }) }
}

async function rollback(directory: string, journal: Journal): Promise<void> {
  for (const entry of [...journal.entries].reverse()) {
    await checkTarget(entry.target)
    if (entry.original) await replace(entry.target, await fs.readFile(path.join(directory, entry.original)))
    else await fs.rm(entry.target, { force: true })
  }
}

/** Journals are written before the first replacement and retained if recovery cannot complete. */
export async function applyRestore(files: RestoreFile[], recoveryRoot: string, canWrite: () => void = () => {}): Promise<string[]> {
  await fs.mkdir(recoveryRoot, { recursive: true })
  const directory = await fs.mkdtemp(path.join(recoveryRoot, 'restore-'))
  const journal: Journal = { entries: [] }
  let prepared = false
  try {
    for (const [i, file] of files.entries()) {
      await checkTarget(file.target)
      let original: string | undefined
      try {
        const data = await fs.readFile(file.target)
        original = `${i}.original`
        await fs.writeFile(path.join(directory, original), data, { flush: true })
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      const staged = `${i}.staged`
      await fs.writeFile(path.join(directory, staged), file.data, { flush: true })
      journal.entries.push({ target: file.target, original, staged })
    }
    await fs.writeFile(path.join(directory, 'journal.json'), JSON.stringify(journal), { flush: true })
    prepared = true
    for (const entry of journal.entries) {
      canWrite()
      await replace(entry.target, await fs.readFile(path.join(directory, entry.staged)))
    }
    // An immutable completion marker avoids a torn rewrite of the recovery journal.
    await fs.writeFile(path.join(directory, 'complete'), '', { flush: true })
  } catch (e) {
    if (prepared) {
      try {
        await rollback(directory, journal)
        await fs.writeFile(path.join(directory, 'complete'), '', { flush: true })
      }
      catch (recovery) { throw new RecoveryRequiredError(`Restore failed: ${(e as Error).message}. Automatic rollback failed: ${(recovery as Error).message}. Recovery files retained at ${directory}. Automatic backups are stopped. Restart SaveMe to retry recovery.`) }
    }
    await fs.rm(directory, { recursive: true, force: true })
    throw e
  }
  // Cleanup is optional once the completion marker is durable.
  await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  return files.map(f => f.target)
}

/** Run before watchers start, so an interrupted restore cannot become a new automatic backup. */
export async function recoverRestores(root: string): Promise<number> {
  let entries: string[]
  try { entries = await fs.readdir(root) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw e }
  let recovered = 0
  for (const name of entries.filter(n => n.startsWith('restore-'))) {
    const directory = path.join(root, name)
    try {
      await fs.access(path.join(directory, 'complete'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      let raw: string
      try { raw = await fs.readFile(path.join(directory, 'journal.json'), 'utf8') }
      catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError
        // No journal means preparation never reached live-file writes.
        await fs.rm(directory, { recursive: true, force: true })
        continue
      }
      const journal = JSON.parse(raw) as Journal
      if (!Array.isArray(journal.entries) || journal.entries.some(e => !path.isAbsolute(e.target) || (e.original && !/^\d+\.original$/.test(e.original)))) throw new Error(`Invalid restore recovery journal: ${directory}`)
      await rollback(directory, journal)
      await fs.writeFile(path.join(directory, 'complete'), '', { flush: true })
      recovered++
    }
    await fs.rm(directory, { recursive: true, force: true })
  }
  return recovered
}
