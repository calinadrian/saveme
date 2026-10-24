// Generates resources/icon.png (256px) and resources/tray.png (32px) without any image tools.
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
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size)
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4)
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

const clamp = (v) => Math.max(0, Math.min(1, v))

// Signed distance helpers, in units of the icon size (0..1).
const roundedBox = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r
  const qy = Math.abs(y - cy) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r

function cloud(x, y) {
  return Math.min(circle(x, y, 0.4, 0.52, 0.15), circle(x, y, 0.58, 0.46, 0.19), circle(x, y, 0.72, 0.58, 0.12), roundedBox(x, y, 0.55, 0.62, 0.26, 0.08, 0.08))
}

function arrow(x, y) {
  // Up arrow cut out of the cloud: shaft + head.
  const shaft = roundedBox(x, y, 0.55, 0.62, 0.035, 0.09, 0.02)
  const hx = Math.abs(x - 0.55)
  const head = Math.max(y - 0.56, 0.42 - y + hx * 1.1 - 0.0)
  return Math.min(shaft, Math.max(head, hx - 0.12))
}

function icon(x, y, size, tray) {
  const u = x / size
  const v = y / size
  const aa = 1.2 / size
  const bg = roundedBox(u, v, 0.5, 0.5, 0.47, 0.47, 0.2)
  const bgA = tray ? 0 : clamp(0.5 - bg / aa)
  const t = (u + v) / 2
  let r = 108 + (155 - 108) * t
  let g = 140 + (123 - 140) * t
  let b = 255
  const cl = Math.max(cloud(u, v), -arrow(u, v))
  const cA = clamp(0.5 - cl / aa)
  // cloud is white on the badge; on the tray icon it is the colored shape itself
  if (tray) return [r, g, b, cA * 255].map(Math.round)
  r = r * (1 - cA) + 255 * cA
  g = g * (1 - cA) + 255 * cA
  b = b * (1 - cA) + 255 * cA
  return [r, g, b, Math.max(bgA, cA * bgA) * 255].map(Math.round)
}

fs.mkdirSync('resources', { recursive: true })
fs.writeFileSync('resources/icon.png', png(256, (x, y, s) => icon(x, y, s, false)))
fs.writeFileSync('resources/tray.png', png(32, (x, y, s) => icon(x, y, s, false)))
console.log('wrote resources/icon.png, resources/tray.png')
