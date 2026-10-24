/** Minimal parser for Valve KeyValues text files (libraryfolders.vdf, appmanifest_*.acf). */
export type Vdf = { [key: string]: string | Vdf }

export function parseVdf(text: string): Vdf {
  const tokens: string[] = []
  const re = /"((?:\\.|[^"\\])*)"|([{}])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) tokens.push(m[2] ?? '"' + m[1].replace(/\\\\/g, '\\'))
  let i = 0
  const readObject = (): Vdf => {
    const obj: Vdf = {}
    while (i < tokens.length) {
      const t = tokens[i++]
      if (t === '}') break
      const key = t.slice(1)
      const next = tokens[i++]
      if (next === '{') obj[key] = readObject()
      else if (next !== undefined) obj[key] = next.slice(1)
    }
    return obj
  }
  return readObject()
}
