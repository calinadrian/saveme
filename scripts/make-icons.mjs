// Flat archive-and-arrow icon. All Windows sizes use the same geometry as BrandMark.
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

/** Windows ICO: native bitmap frames at shell sizes, PNG only for the 256px frame. */
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

// Signed distance helpers, in units of the icon size (0..1).
const roundedBox = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r
  const qy = Math.abs(y - cy) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const segment = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - ax - t * dx, y - ay - t * dy)
}
const strokes = [[12, 4, 12, 13], [9, 10, 12, 13], [12, 13, 15, 10], [4, 15, 8, 15], [8, 15, 9.5, 17], [9.5, 17, 14.5, 17], [14.5, 17, 16, 15], [16, 15, 20, 15]]

function icon(x, y, size) {
  const u = x / size * 24
  const v = y / size * 24
  const tile = roundedBox(u, v, 12, 12, 11.5, 11.5, 4.5)
  if (tile > 0) return [0, 0, 0, 0]
  const width = size <= 20 ? 1 : 0.9
  const outline = Math.abs(roundedBox(u, v, 12, 14, 8, 6, 1.5)) <= width && !(v < 10 && u > 7 && u < 17)
  const line = strokes.some(s => segment(u, v, ...s) <= width)
  const color = outline || line ? [220, 232, 250] : [37, 54, 78]
  return [...color, 1]
}

const draw = (size) => png(size, icon)
function dib(size) {
  const encoded = draw(size)
  const raw = zlib.inflateSync(encoded.subarray(41, 41 + encoded.readUInt32BE(33)))
  const maskStride = Math.ceil(size / 32) * 4
  const bitmap = Buffer.alloc(40 + size * size * 4 + maskStride * size)
  bitmap.writeUInt32LE(40, 0)
  bitmap.writeInt32LE(size, 4)
  bitmap.writeInt32LE(size * 2, 8) // color plane plus transparency mask
  bitmap.writeUInt16LE(1, 12)
  bitmap.writeUInt16LE(32, 14)
  bitmap.writeUInt32LE(size * size * 4 + maskStride * size, 20)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const src = y * (size * 4 + 1) + 1 + x * 4
    const dest = 40 + ((size - y - 1) * size + x) * 4
    bitmap[dest] = raw[src + 2]
    bitmap[dest + 1] = raw[src + 1]
    bitmap[dest + 2] = raw[src]
    bitmap[dest + 3] = raw[src + 3]
    if (!raw[src + 3]) bitmap[40 + size * size * 4 + (size - y - 1) * maskStride + (x >> 3)] |= 0x80 >> (x % 8)
  }
  return bitmap
}
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
fs.mkdirSync('resources', { recursive: true })
fs.writeFileSync('resources/icon.png', draw(256))
fs.writeFileSync('docs/icon.png', draw(256))
fs.writeFileSync('resources/tray.png', draw(32))
fs.writeFileSync('resources/icon.ico', ico(sizes.map((size) => ({ size, data: size === 256 ? draw(size) : dib(size) }))))
console.log('wrote resources/icon.png, resources/icon.ico, resources/tray.png, docs/icon.png')
