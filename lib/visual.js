/**
 * Screenshot baselines and pixel comparison for `apple_dev_visual`.
 *
 * The plugin has no image dependencies, so comparison leans on macOS: `sips`
 * converts PNG to uncompressed BMP, this module parses the BMP into RGB pixels,
 * compares with a per-channel tolerance, and writes a red-marked diff BMP that
 * `sips` turns back into a PNG.
 *
 * Baseline store layout under `<visualDirectory>/<name>/`:
 *   latest.png    last capture
 *   baseline.png  approved reference
 *   diff.png      last mismatch, red pixels
 *   meta.json     capture metadata (source, device, time, size)
 *   result.json   last comparison metrics
 */
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { resolveUserPath } from './runner.js'

/** Capture sources accepted by the visual tool. */
export const VISUAL_SOURCES = ['simulator', 'preview', 'file']
/** Per-channel difference ignored by default (0-255). */
export const DEFAULT_CHANNEL_TOLERANCE = 12
/** Fraction of differing pixels still considered a match. */
export const DEFAULT_MAX_DIFF_RATIO = 0.002
/** Guard for absurd bitmaps (sips output) before allocating. */
const MAX_PIXELS = 40 * 1000 * 1000

/** Parse a 24/32-bit uncompressed BMP into `{ width, height, rgb }`. */
export function parseBmp(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 54) throw new Error('Not a BMP file.')
  if (buffer.toString('ascii', 0, 2) !== 'BM') throw new Error('Not a BMP file (missing BM signature).')
  const pixelOffset = buffer.readUInt32LE(10)
  const headerSize = buffer.readUInt32LE(14)
  if (headerSize < 40) throw new Error('Unsupported BMP header.')
  const width = buffer.readInt32LE(18)
  const rawHeight = buffer.readInt32LE(22)
  const planes = buffer.readUInt16LE(26)
  const bitsPerPixel = buffer.readUInt16LE(28)
  const compression = buffer.readUInt32LE(30)
  if (planes !== 1) throw new Error('Unsupported BMP plane count.')
  // sips writes BI_BITFIELDS (3) with a V4 header on some PNGs; both masks and
  // the plain BI_RGB layout decode to the same RGB triplets.
  if (compression !== 0 && compression !== 3) throw new Error(`Unsupported BMP compression: ${compression}.`)
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) throw new Error(`Unsupported BMP depth: ${bitsPerPixel} bpp.`)
  let masks
  if (compression === 3) {
    if (buffer.length < 70) throw new Error('BMP bitfield masks are truncated.')
    masks = [buffer.readUInt32LE(54), buffer.readUInt32LE(58), buffer.readUInt32LE(62)]
    if (masks.some((mask) => mask === 0)) throw new Error('BMP bitfield masks are empty.')
  }
  const height = Math.abs(rawHeight)
  if (width <= 0 || height <= 0) throw new Error('BMP has no pixels.')
  if (width * height > MAX_PIXELS) throw new Error('BMP is too large to compare.')
  const bytesPerPixel = bitsPerPixel / 8
  const rowSize = Math.ceil((width * bytesPerPixel) / 4) * 4
  if (buffer.length < pixelOffset + rowSize * height) throw new Error('BMP pixel data is truncated.')
  const shifts = masks ? masks.map(maskShift) : undefined
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const sourceRow = rawHeight > 0 ? height - 1 - y : y
    const rowStart = pixelOffset + sourceRow * rowSize
    for (let x = 0; x < width; x += 1) {
      const source = rowStart + x * bytesPerPixel
      const target = (y * width + x) * 3
      if (shifts) {
        const pixel = bytesPerPixel === 4 ? buffer.readUInt32LE(source) : buffer[source] | (buffer[source + 1] << 8) | (buffer[source + 2] << 16)
        rgb[target] = scaleChannel(pixel, shifts[0])
        rgb[target + 1] = scaleChannel(pixel, shifts[1])
        rgb[target + 2] = scaleChannel(pixel, shifts[2])
      } else {
        rgb[target] = buffer[source + 2]
        rgb[target + 1] = buffer[source + 1]
        rgb[target + 2] = buffer[source]
      }
    }
  }
  return { width, height, rgb }
}

/** Bit position and maximum value of one BI_BITFIELDS mask. */
function maskShift(mask) {
  let shift = 0
  while (shift < 32 && ((mask >>> shift) & 1) === 0) shift += 1
  return { shift, max: mask >>> shift }
}

/** Extract one mask channel and scale it to 0-255. */
function scaleChannel(pixel, { shift, max }) {
  if (max === 0) return 0
  const value = (pixel & (max << shift)) >>> shift
  return max === 255 ? value : Math.round((value * 255) / max)
}

/** Encode RGB pixels as a 24-bit top-down BMP (sips/Preview friendly). */
export function encodeBmp(width, height, rgb) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixelBytes = rowSize * height
  const buffer = Buffer.alloc(54 + pixelBytes)
  buffer.write('BM', 0, 'ascii')
  buffer.writeUInt32LE(54 + pixelBytes, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(width, 18)
  buffer.writeInt32LE(-height, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)
  buffer.writeUInt32LE(0, 30)
  buffer.writeUInt32LE(pixelBytes, 34)
  for (let y = 0; y < height; y += 1) {
    const rowStart = 54 + y * rowSize
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 3
      const target = rowStart + x * 3
      buffer[target] = rgb[source + 2]
      buffer[target + 1] = rgb[source + 1]
      buffer[target + 2] = rgb[source]
    }
  }
  return buffer
}

/**
 * Compare two RGB images.
 *
 * @param {{width: number, height: number, rgb: Uint8Array}} base reference.
 * @param {{width: number, height: number, rgb: Uint8Array}} current candidate.
 * @param {{tolerance?: number}} [options] per-channel tolerance.
 * @returns {object} metrics plus `diffRgb` for a diff image.
 */
export function compareRgb(base, current, { tolerance = DEFAULT_CHANNEL_TOLERANCE } = {}) {
  const limit = Number.isFinite(tolerance) ? Math.max(0, Math.min(255, Math.trunc(tolerance))) : DEFAULT_CHANNEL_TOLERANCE
  if (base.width !== current.width || base.height !== current.height) {
    return {
      sizeMismatch: true,
      width: base.width,
      height: base.height,
      currentWidth: current.width,
      currentHeight: current.height,
      diffPixels: base.width * base.height,
      totalPixels: base.width * base.height,
      ratio: 1,
      bbox: { x: 0, y: 0, width: base.width, height: base.height },
      diffRgb: base.rgb.slice(),
    }
  }
  const { width, height } = base
  const diffRgb = new Uint8Array(width * height * 3)
  let diffPixels = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3
      const different = Math.abs(base.rgb[index] - current.rgb[index]) > limit
        || Math.abs(base.rgb[index + 1] - current.rgb[index + 1]) > limit
        || Math.abs(base.rgb[index + 2] - current.rgb[index + 2]) > limit
      if (different) {
        diffPixels += 1
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        diffRgb[index] = 255
        diffRgb[index + 1] = 0
        diffRgb[index + 2] = 0
      } else {
        diffRgb[index] = base.rgb[index]
        diffRgb[index + 1] = base.rgb[index + 1]
        diffRgb[index + 2] = base.rgb[index + 2]
      }
    }
  }
  const totalPixels = width * height
  return {
    sizeMismatch: false,
    width,
    height,
    diffPixels,
    totalPixels,
    ratio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    bbox: diffPixels === 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    diffRgb,
  }
}

/** Stable directory name for a baseline key. */
export function sanitizeVisualName(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  return (value.length > 0 ? value : 'default').replace(/[^\w.-]+/g, '-').slice(0, 80)
}

/** Paths owned by one baseline entry under the configured visual directory. */
export function visualPaths(cwd, config, name) {
  const root = resolveUserPath(cwd, config.visualDirectory || '.apple-dev/visual')
  const directory = join(root, sanitizeVisualName(name))
  return {
    root,
    directory,
    latest: join(directory, 'latest.png'),
    baseline: join(directory, 'baseline.png'),
    diff: join(directory, 'diff.png'),
    meta: join(directory, 'meta.json'),
    result: join(directory, 'result.json'),
    converted: join(directory, '.convert'),
  }
}

/** Convert a PNG to BMP with sips (macOS ships it). */
export async function pngToBmp(runner, pngPath, bmpPath, { signal } = {}) {
  const result = await runner(['sips', '-s', 'format', 'bmp', pngPath, '--out', bmpPath], { signal })
  if (!result.ok) {
    throw new Error(`sips could not convert ${basename(pngPath)}: ${(result.stderr || result.stdout || `exit ${result.exitCode}`).trim()}`)
  }
  return bmpPath
}

/** Convert a BMP (diff image) back to PNG with sips. */
export async function bmpToPng(runner, bmpPath, pngPath, { signal } = {}) {
  const result = await runner(['sips', '-s', 'format', 'png', bmpPath, '--out', pngPath], { signal })
  if (!result.ok) {
    throw new Error(`sips could not write ${basename(pngPath)}: ${(result.stderr || result.stdout || `exit ${result.exitCode}`).trim()}`)
  }
  return pngPath
}

/** Load one PNG as RGB pixels through a temporary BMP. */
export async function loadPngPixels(runner, pngPath, bmpPath, { signal } = {}) {
  await pngToBmp(runner, pngPath, bmpPath, { signal })
  return parseBmp(await readFile(bmpPath))
}

/** Read a JSON file, returning `{}` for a missing or unreadable file. */
export async function readJsonFile(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Write metadata as pretty JSON. */
export async function writeJsonFile(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Copy a captured image into the entry's `latest.png` and record metadata. */
export async function storeCapture(paths, sourcePath, metadata) {
  await mkdir(paths.directory, { recursive: true })
  await copyFile(sourcePath, paths.latest)
  const info = await stat(paths.latest)
  const meta = {
    ...metadata,
    capturedAt: new Date().toISOString(),
    bytes: info.size,
  }
  await writeJsonFile(paths.meta, meta)
  return meta
}

/** Promote `latest.png` to `baseline.png`. */
export async function approveBaseline(paths) {
  const info = await stat(paths.latest).catch(() => undefined)
  if (!info) throw new Error('No latest capture to approve; run action=capture first.')
  await copyFile(paths.latest, paths.baseline)
  const meta = await readJsonFile(paths.meta)
  const approved = { ...meta, approvedAt: new Date().toISOString() }
  await writeJsonFile(paths.meta, approved)
  return approved
}

/** Describe every baseline entry under the root, newest first. */
export async function listVisualEntries(root) {
  const names = await readdir(root, { withFileTypes: true }).catch(() => [])
  const entries = []
  for (const name of names) {
    if (!name.isDirectory()) continue
    const directory = join(root, name.name)
    const baseline = await stat(join(directory, 'baseline.png')).catch(() => undefined)
    const latest = await stat(join(directory, 'latest.png')).catch(() => undefined)
    if (!baseline && !latest) continue
    const meta = await readJsonFile(join(directory, 'meta.json'))
    const result = await readJsonFile(join(directory, 'result.json'))
    entries.push({
      name: name.name,
      directory,
      baseline: baseline ? { path: join(directory, 'baseline.png'), modified: baseline.mtime.toISOString() } : undefined,
      latest: latest ? { path: join(directory, 'latest.png'), modified: latest.mtime.toISOString() } : undefined,
      meta,
      lastResult: typeof result.ratio === 'number' ? result : undefined,
    })
  }
  return entries.sort((left, right) => {
    const leftTime = left.latest?.modified || left.baseline?.modified || ''
    const rightTime = right.latest?.modified || right.baseline?.modified || ''
    return rightTime.localeCompare(leftTime)
  })
}
