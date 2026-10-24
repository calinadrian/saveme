import fs from 'node:fs'
import path from 'node:path'

export interface OAuthIds {
  googleClientId?: string
  googleClientSecret?: string
  microsoftClientId?: string
}

/**
 * OAuth client IDs: `%APPDATA%/SaveMe/config.json` wins over values baked in at build time (.env).
 * See docs/SETUP.md.
 */
export function loadOAuthIds(userData: string): OAuthIds {
  const env = import.meta.env
  const ids: OAuthIds = {
    googleClientId: env.MAIN_VITE_GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: env.MAIN_VITE_GOOGLE_CLIENT_SECRET || undefined,
    microsoftClientId: env.MAIN_VITE_MICROSOFT_CLIENT_ID || undefined
  }
  try {
    const file = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')) as OAuthIds
    for (const [k, v] of Object.entries(file)) if (v) ids[k as keyof OAuthIds] = v
  } catch {
    // no config.json
  }
  return ids
}

/** Stores IDs entered in the app into config.json, merged with what is there. */
export function saveOAuthIds(userData: string, patch: OAuthIds): void {
  const file = path.join(userData, 'config.json')
  let current: OAuthIds = {}
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // new file
  }
  const trimmed = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v?.trim() || undefined]))
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...current, ...trimmed }, null, 2))
}
