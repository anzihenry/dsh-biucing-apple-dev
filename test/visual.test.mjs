/**
 * Visual-regression tests: BMP round-trip, pixel diff metrics, and the full
 * capture → approve → compare flow through sips (macOS only).
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/runner.js'
import {
  compareRgb,
  encodeBmp,
  parseBmp,
  visualPaths,
} from '../lib/visual.js'
import { createVisualTools, formatVisualReport } from '../lib/tools-visual.js'

const MAC = process.platform === 'darwin'

function color(width, height, [r, g, b]) {
  const rgb = new Uint8Array(width * height * 3)
  for (let index = 0; index < width * height; index += 1) {
    rgb[index * 3] = r
    rgb[index * 3 + 1] = g
    rgb[index * 3 + 2] = b
  }
  return { width, height, rgb }
}

/** Runner over real sips, mirroring the plugin's runner result shape. */
function sipsRunner() {
  return (argv, options = {}) => new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { signal: options.signal }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        argv,
        command: argv.join(' '),
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout,
        stderr,
      })
    })
  })
}

test('BMP encode/parse round-trips RGB pixels', () => {
  const image = color(5, 3, [10, 120, 240])
  image.rgb[0] = 1
  image.rgb[1] = 2
  image.rgb[2] = 3
  const parsed = parseBmp(encodeBmp(image.width, image.height, image.rgb))
  assert.equal(parsed.width, 5)
  assert.equal(parsed.height, 3)
  assert.deepEqual([parsed.rgb[0], parsed.rgb[1], parsed.rgb[2]], [1, 2, 3])
  assert.deepEqual([...parsed.rgb.slice(3, 6)], [10, 120, 240])
})

test('parseBmp decodes 32-bit BI_BITFIELDS with a V4 header', () => {
  const headerSize = 124
  const pixelOffset = 14 + headerSize
  const buffer = Buffer.alloc(pixelOffset + 8)
  buffer.write('BM', 0, 'ascii')
  buffer.writeUInt32LE(buffer.length, 2)
  buffer.writeUInt32LE(pixelOffset, 10)
  buffer.writeUInt32LE(headerSize, 14)
  buffer.writeInt32LE(2, 18)
  buffer.writeInt32LE(-1, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(32, 28)
  buffer.writeUInt32LE(3, 30)
  buffer.writeUInt32LE(8, 34)
  buffer.writeUInt32LE(0x00ff0000, 54)
  buffer.writeUInt32LE(0x0000ff00, 58)
  buffer.writeUInt32LE(0x000000ff, 62)
  buffer.writeUInt32LE(0xff000000, 66)
  buffer.writeUInt32LE(0xff112233, pixelOffset)
  buffer.writeUInt32LE(0xff445566, pixelOffset + 4)
  const parsed = parseBmp(buffer)
  assert.deepEqual([...parsed.rgb.slice(0, 6)], [0x11, 0x22, 0x33, 0x44, 0x55, 0x66])
})

test('compareRgb reports identical, single-pixel and size-mismatch cases', () => {
  const base = color(10, 10, [20, 30, 40])
  assert.equal(compareRgb(base, base).diffPixels, 0)

  const changed = color(10, 10, [20, 30, 40])
  changed.rgb[(4 * 10 + 7) * 3] = 200
  const diff = compareRgb(base, changed, { tolerance: 5 })
  assert.equal(diff.diffPixels, 1)
  assert.equal(diff.ratio, 1 / 100)
  assert.deepEqual(diff.bbox, { x: 7, y: 4, width: 1, height: 1 })
  assert.equal(diff.diffRgb[(4 * 10 + 7) * 3], 255, 'diff pixels are red')

  const resized = compareRgb(base, color(12, 10, [20, 30, 40]))
  assert.equal(resized.sizeMismatch, true)
  assert.equal(resized.ratio, 1)
  assert.equal(compareRgb(base, changed, { tolerance: 200 }).diffPixels, 0, 'tolerance absorbs small deltas')
})

test('visual tool captures, approves, compares and lists baselines', { skip: !MAC }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-visual-'))
  try {
    const runner = sipsRunner()
    const config = resolveConfig({ visualDirectory: join(root, 'visual') })
    const ctx = { get: (service) => (service === 'workingDirectory' ? { defaultDirectory: root } : undefined) }
    const tool = createVisualTools(ctx, config, runner, undefined)[0]

    const makePng = async (name, rgb) => {
      const bmp = join(root, `${name}.bmp`)
      const png = join(root, `${name}.png`)
      await writeFile(bmp, encodeBmp(8, 8, color(8, 8, rgb).rgb))
      const converted = await runner(['sips', '-s', 'format', 'png', bmp, '--out', png])
      assert.equal(converted.ok, true, converted.stderr)
      return png
    }
    const first = await makePng('first', [10, 20, 30])
    const second = await makePng('second', [10, 20, 30])
    const third = await makePng('third', [90, 20, 30])

    const captured = await tool.execute({ action: 'capture', source: 'file', image: first, name: 'home' }, {})
    assert.equal(captured.ok, true, captured.error)
    assert.equal(captured.baselineExists, false)
    assert.ok(await stat(captured.latest))

    const approved = await tool.execute({ action: 'approve', name: 'home' }, {})
    assert.equal(approved.ok, true, approved.error)

    const same = await tool.execute({ action: 'compare', name: 'home' }, {})
    assert.equal(same.ok, true, same.error)
    assert.equal(same.match, true)
    assert.equal(same.diffPixels, 0)

    await tool.execute({ action: 'capture', source: 'file', image: second, name: 'home' }, {})
    const stillSame = await tool.execute({ action: 'compare', name: 'home' }, {})
    assert.equal(stillSame.match, true, 'a fresh capture of the same pixels still matches')

    await tool.execute({ action: 'capture', source: 'file', image: third, name: 'home' }, {})
    const changed = await tool.execute({ action: 'compare', name: 'home', tolerance: 5 }, {})
    assert.equal(changed.ok, true, changed.error)
    assert.equal(changed.match, false)
    assert.equal(changed.diffPixels, 64)
    assert.ok(await stat(changed.diffPath), 'a diff image is written')
    assert.match(formatVisualReport(changed), /DIFF/)

    const listed = await tool.execute({ action: 'list' }, {})
    assert.equal(listed.entries.length, 1)
    assert.equal(listed.entries[0].name, 'home')
    assert.ok(listed.entries[0].baseline)
    assert.ok(listed.entries[0].latest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('visual tool captures a Preview snapshot through MCP', { skip: !MAC }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-preview-'))
  try {
    const runner = sipsRunner()
    const config = resolveConfig({ visualDirectory: join(root, 'visual') })
    const png = join(root, 'preview.png')
    const bmp = join(root, 'preview.bmp')
    await writeFile(bmp, encodeBmp(4, 4, color(4, 4, [1, 2, 3]).rgb))
    assert.equal((await runner(['sips', '-s', 'format', 'png', bmp, '--out', png])).ok, true)

    const calls = []
    const mcp = {
      async callTool(name, args) {
        calls.push({ name, args })
        return { isError: false, text: JSON.stringify({ displayName: 'LoginScreen', snapshot: { path: png } }), images: [] }
      },
    }
    const ctx = { get: (service) => (service === 'workingDirectory' ? { defaultDirectory: root } : undefined) }
    const tool = createVisualTools(ctx, config, runner, mcp)[0]
    const captured = await tool.execute({ action: 'capture', source: 'preview', source_file: 'Sources/Login.swift', workspace: 'w1' }, {})
    assert.equal(captured.ok, true, captured.error)
    assert.equal(captured.name, 'LoginScreen')
    assert.equal(calls[0].name, 'RenderPreview')
    assert.equal(calls[0].args.workspaceIdentifier, 'w1')
    assert.ok(await stat(visualPaths(root, config, 'LoginScreen').latest))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
