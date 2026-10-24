// Dev check: run the real scan against this PC and print what was found.
import fs from 'node:fs'
import yaml from 'js-yaml'
import { compactManifest } from '../src/main/detect/manifest'
import { findInstalledGames } from '../src/main/detect/launchers'
import { getKnownFolders } from '../src/main/detect/paths'
import { scanGames } from '../src/main/detect/scanner'

const t0 = Date.now()
const manifest = compactManifest(yaml.load(fs.readFileSync(process.argv[2], 'utf8')) as never)
const t1 = Date.now()
const folders = await getKnownFolders()
const launchers = await findInstalledGames([])
const results = scanGames(manifest, launchers, folders)
const t2 = Date.now()
console.log(`manifest ${manifest.length} games parsed in ${t1 - t0} ms, scan ${t2 - t1} ms`)
console.log('folders', folders)
console.log('installed', launchers.games.map((g) => `${g.store}:${g.name}`))
for (const r of results) console.log(`${r.game.name} | ${r.game.fileCount} files | ${(r.game.sizeBytes / 1e6).toFixed(1)} MB | ${r.game.roots.map((x) => x.template).join(', ')}`)
