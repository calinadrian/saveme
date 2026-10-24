// Writes resources/THIRD-PARTY-NOTICES.txt: SaveMe's license plus the license of every package the app ships.
// MIT and similar licenses require their notices to travel with the copies, and the renderer bundle drops them.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
const rule = '-'.repeat(78)

function licenseText(dir) {
  if (!fs.existsSync(dir)) return undefined
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(f)) ?? fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f))
  return file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : undefined
}

const packages = Object.entries(lock.packages)
  .filter(([key, p]) => key.startsWith('node_modules/') && !p.dev && !p.optional)
  .map(([key, p]) => ({ name: key.slice(key.lastIndexOf('node_modules/') + 13), version: p.version, license: p.license, dir: path.join(ROOT, key) }))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const seen = new Set()
const sections = []
for (const p of packages) {
  const id = `${p.name}@${p.version}`
  if (seen.has(id)) continue
  seen.add(id)
  const text = licenseText(p.dir)
  sections.push(`${id}\nLicense: ${p.license ?? 'see below'}\n\n${text ?? `No license file in the package; it is published under ${p.license}.`}`)
}

const own = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8').trim()
const out = [
  'SaveMe',
  '',
  own,
  '',
  rule,
  'Third-party software',
  rule,
  '',
  'SaveMe is built with Electron (MIT). Electron and Chromium licenses are installed next to SaveMe.exe',
  'as LICENSE.electron.txt and LICENSES.chromium.html.',
  '',
  'Game save locations come from the Ludusavi manifest (https://github.com/mtkennerly/ludusavi-manifest, MIT),',
  'which is compiled from PCGamingWiki (https://www.pcgamingwiki.com). It is downloaded when SaveMe runs.',
  '',
  ...sections.flatMap((s) => [rule, s, '']),
].join('\n')

fs.mkdirSync(path.join(ROOT, 'resources'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'resources', 'THIRD-PARTY-NOTICES.txt'), out.replace(/\r\n/g, '\n'))
console.log(`wrote resources/THIRD-PARTY-NOTICES.txt (${seen.size} packages)`)
