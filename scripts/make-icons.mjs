// Generates the app icon (a floppy disk with a heart on its label: "save me") without any image tools:
// resources/icon.png (256px), resources/icon.ico (16-256px, for the exe and installer), resources/tray.png
// (32px) and docs/icon.png. Each size is drawn at its own resolution so small icons stay crisp.
import fs from 'node:fs'
import zlib from 'node:zlib'

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      // 4x4 supersampling for clean edges at every size.
      const acc = [0, 0, 0, 0]
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const [r, g, b, a] = pixel(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4, size)
          acc[0] += r * a
          acc[1] += g * a
          acc[2] += b * a
          acc[3] += a
        }
      const a = acc[3] / 16
      const px = a ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3], a * 255] : [0, 0, 0, 0]
      raw.set(px.map(Math.round), y * (size * 4 + 1) + 1 + x * 4)
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** Windows .ico holding one PNG per size (supported since Vista). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i
    header[e] = size >= 256 ? 0 : size
    header[e + 1] = size >= 256 ? 0 : size
    header.writeUInt16LE(1, e + 4)
    header.writeUInt16LE(32, e + 6)
    header.writeUInt32LE(data.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...images.map((i) => i.data)])
}

const clamp = (v) => Math.max(0, Math.min(1, v))
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

// Signed distance helpers, in units of the icon size (0..1).
const roundedBox = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r
  const qy = Math.abs(y - cy) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r

const INK_TOP = [36, 40, 49]
const INK_BOTTOM = [16, 18, 23]
const LIME = [200, 242, 74]
const LIME_DEEP = [150, 205, 40]

function heart(u, v, cx, cy, s) {
  const x = Math.abs(u - cx) / s
  const y = (v - cy) / s
  const lobe = circle(x, y, 0.5, -0.25, 0.52)
  // The point: everything under the two tangents that meet at (0, 1).
  const point = Math.max(-0.25 - y, (y - 1 + x * 1.25) / Math.hypot(1, 1.25))
  return Math.min(lobe, point) * s
}

function floppy(u, v, small) {
  // Body with the top-right corner cut off.
  const body = Math.max(roundedBox(u, v, 0.5, 0.52, 0.28, 0.29, 0.055), (u - v - 0.43) / Math.SQRT2)
  // Metal shutter at the top, with its slot.
  const shutter = roundedBox(u, v, 0.47, 0.315, 0.135, 0.085, 0.025)
  const slot = roundedBox(u, v, 0.53, 0.315, 0.035, 0.05, 0.012)
  // Label at the bottom, with the heart.
  const label = roundedBox(u, v, 0.5, 0.655, 0.19, 0.125, 0.035)
  const love = heart(u, v, 0.5, 0.635, small ? 0.13 : 0.105)
  return { body, shutter, slot, label, love }
}

function icon(x, y, size) {
  const u = x / size
  const v = y / size
  const small = size < 30
  const inside = (d) => (d <= 0 ? 1 : 0)
  const tile = roundedBox(u, v, 0.5, 0.5, 0.47, 0.47, 0.21)
  if (tile > 0) return [0, 0, 0, 0]
  let color = mix(INK_TOP, INK_BOTTOM, v)
  // Soft lime glow behind the disk.
  color = mix(color, LIME, 0.14 * clamp(1 - Math.hypot(u - 0.5, v - 0.52) / 0.5))
  const f = floppy(u, v, small)
  if (inside(f.body)) {
    color = mix(LIME, LIME_DEEP, clamp((v - 0.23) / 0.58))
    if (inside(f.shutter) && !(small && inside(f.slot)) && !(!small && inside(f.slot))) color = INK_BOTTOM
    if (inside(f.shutter) && inside(f.slot)) color = small ? INK_BOTTOM : LIME
    if (inside(f.label)) color = [244, 246, 240]
    if (inside(f.love)) color = [255, 92, 108]
  }
  return [...color, 1]
}

const draw = (size) => png(size, icon)
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
fs.mkdirSync('resources', { recursive: true })
fs.writeFileSync('resources/icon.png', draw(256))
fs.writeFileSync('docs/icon.png', draw(256))
fs.writeFileSync('resources/tray.png', draw(32))
fs.writeFileSync('resources/icon.ico', ico(sizes.map((size) => ({ size, data: draw(size) }))))
console.log('wrote resources/icon.png, resources/icon.ico, resources/tray.png, docs/icon.png')
