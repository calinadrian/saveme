// Build locally first, then upload all assets to a draft before making the release visible (same flow as rdal).
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'calinadrian/saveme'
const require = createRequire(import.meta.url)

/** Commit subjects since the last release, grouped the way the in-app update dialog shows them. */
export function releaseNotes(subjects) {
  const groups = { New: [], Fixed: [], Improved: [] }
  for (const subject of subjects) {
    const s = subject.trim()
    if (!s || /^v?\d+\.\d+\.\d+$/.test(s)) continue
    groups[/^(add|new\b|feat[(:])/i.test(s) ? 'New' : /^fix/i.test(s) ? 'Fixed' : 'Improved'].push(s)
  }
  return (
    Object.entries(groups)
      .filter(([, list]) => list.length)
      .map(([title, list]) => '### ' + title + '\n' + list.map((s) => '- ' + s).join('\n'))
      .join('\n\n') || '### Improved\n- Maintenance release'
  )
}

function main() {
  const run = (exe, args, optional = false) => {
    const result = spawnSync(exe, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true })
    if (result.error || result.status !== 0) {
      if (optional) return null
      throw Error(result.error?.message || result.stderr || result.stdout || exe + ' failed')
    }
    return result.stdout.trim()
  }
  const node = (script, args) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit', windowsHide: true })
    return !result.error && result.status === 0
  }
  const git = (...args) => run('git', args)
  const ghPath = process.env.GH_CLI || path.join(process.env.ProgramFiles || 'C:/Program Files', 'GitHub CLI', 'gh.exe')
  const ghExe = fs.existsSync(ghPath) ? ghPath : 'gh'
  const gh = (...args) => run(ghExe, args)

  // Authentication must succeed before creating tags or uploading anything. No tokens in command output.
  try {
    gh('api', 'user', '--jq', '.login')
  } catch {
    throw Error('GitHub publishing requires authentication. Run gh auth login (Windows: & "C:/Program Files/GitHub CLI/gh.exe" auth login), then retry.')
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const tag = 'v' + version
  if (git('status', '--porcelain')) throw Error('Commit your changes first: the release must match its tagged commit.')
  if (!git('branch', '--show-current')) throw Error('Check out a branch before releasing.')
  git('fetch', '--tags', 'origin')
  const existingTag = git('tag', '--list', tag)
  if (existingTag && git('rev-parse', tag + '^{commit}') !== git('rev-parse', 'HEAD')) throw Error(tag + ' already points to another commit. Bump the version.')
  const release = run(ghExe, ['release', 'view', tag, '--repo', REPO, '--json', 'isDraft'], true)
  if (release && !JSON.parse(release).isDraft) throw Error(tag + ' is already published. Bump the version.')

  // Sign-in IDs are baked in at build time. Without them, every user has to register their own app first.
  const env = fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : ''
  const missing = ['MAIN_VITE_GOOGLE_CLIENT_ID', 'MAIN_VITE_GOOGLE_CLIENT_SECRET', 'MAIN_VITE_MICROSOFT_CLIENT_ID'].filter((k) => !new RegExp(`^${k}=\\S+`, 'm').test(env))
  if (missing.length) console.warn(`Warning: .env has no ${missing.join(', ')}. Users will have to register their own app to sign in.`)

  const previous = git('tag', '--list', 'v*', '--sort=-v:refname', '--merged', 'HEAD')
    .split(/\r?\n/)
    .find((t) => t && t !== tag)
  const subjects = git('log', '--no-merges', '--pretty=%s', previous ? previous + '..HEAD' : 'HEAD').split(/\r?\n/)
  const notesFile = path.join(ROOT, 'dist', 'release-notes.md')
  fs.mkdirSync(path.dirname(notesFile), { recursive: true })
  fs.writeFileSync(notesFile, releaseNotes(subjects) + '\n')

  // No publication happens until a complete installer and manifest exist.
  const built =
    node(path.join(ROOT, 'scripts', 'licenses.mjs'), []) &&
    node(require.resolve('electron-vite/bin/electron-vite.js'), ['build']) &&
    node(require.resolve('electron-builder/cli.js'), ['--win', '--publish', 'never', '-c.releaseInfo.releaseNotesFile=' + notesFile])
  if (!built) throw Error('Installer build failed; nothing was published.')
  const installer = path.join(ROOT, 'dist', `SaveMe-Setup-${version}.exe`)
  const manifest = path.join(ROOT, 'dist', 'latest.yml')
  const assets = [installer, installer + '.blockmap', manifest]
  for (const file of assets) if (!fs.statSync(file).size) throw Error('Missing or empty asset: ' + file)
  const info = yaml.load(fs.readFileSync(manifest, 'utf8'))
  const hash = crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64')
  if (info.version !== version || info.path !== path.basename(installer) || info.sha512 !== hash) throw Error('The update manifest does not match the installer.')

  if (!existingTag) git('tag', '-a', tag, '-m', 'Release ' + tag)
  git('push', 'origin', 'HEAD', 'refs/tags/' + tag)
  if (!release) gh('release', 'create', tag, '--repo', REPO, '--draft', '--verify-tag', '--title', 'SaveMe ' + version, '--notes-file', notesFile)
  gh('release', 'upload', tag, ...assets, '--repo', REPO, '--clobber')
  gh('release', 'edit', tag, '--repo', REPO, '--notes-file', notesFile, '--draft=false', '--latest')
  console.log('Released ' + tag + ': https://github.com/' + REPO + '/releases/tag/' + tag)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
