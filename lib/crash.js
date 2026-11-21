/**
 * Crash-report parsing and symbolication for `apple_dev_logs`.
 *
 * Xcode 26+ writes `.ips` reports: one JSON header line followed by the JSON
 * payload (threads, usedImages, exception, termination). The payload carries
 * image base addresses, so a frame's absolute address is `base + imageOffset`.
 *
 * Symbolication runs `atos` only for frames the report did not already
 * symbolicate, once per image, and only when a matching dSYM binary is found.
 * System frames usually arrive symbolized; the app's dSYM is what unlocks the
 * frames that matter.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { clip, errorMessage } from './format.js'

/** Largest crash report this module reads. */
export const MAX_CRASH_REPORT_BYTES = 4 * 1024 * 1024
const MAX_DSYM_SCAN_DIRECTORIES = 200
const DEFAULT_MAX_FRAMES = 40
const MAX_MAX_FRAMES = 200

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16)
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/** Hex address for atos and reports. */
export function hexAddress(value) {
  return `0x${Math.max(0, Math.trunc(toNumber(value))).toString(16)}`
}

/**
 * Parse an .ips report into `{ header, payload }`.
 *
 * Accepts the two-document form Xcode writes (header line, then payload) and a
 * single JSON document for tools that strip the header.
 *
 * @param {string} text file content.
 * @returns {{header: object, payload: object}} parsed report.
 */
export function parseIps(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw.length === 0) throw new Error('The crash report is empty.')
  try {
    const single = JSON.parse(raw)
    if (single && typeof single === 'object' && (Array.isArray(single.threads) || single.psynch || single.exception)) {
      return { header: {}, payload: single }
    }
  } catch {
    /* fall through to the two-document form */
  }
  const newline = raw.indexOf('\n')
  if (newline <= 0) throw new Error('The crash report is not an .ips document (no JSON header line).')
  let header
  let payload
  try {
    header = JSON.parse(raw.slice(0, newline))
  } catch {
    throw new Error('The .ips header line is not valid JSON.')
  }
  try {
    payload = JSON.parse(raw.slice(newline + 1))
  } catch {
    throw new Error('The .ips payload is not valid JSON.')
  }
  return { header: header && typeof header === 'object' ? header : {}, payload: payload && typeof payload === 'object' ? payload : {} }
}

/** Read a crash-report file with a size bound. */
export async function readCrashText(path) {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`Not a file: ${path}`)
  if (info.size > MAX_CRASH_REPORT_BYTES) throw new Error(`Crash report is larger than ${MAX_CRASH_REPORT_BYTES} bytes: ${path}`)
  return readFile(path, 'utf8')
}

/** Read and parse one .ips file with a size bound. */
export async function readIpsFile(path) {
  return parseIps(await readCrashText(path))
}

/** Human facts extracted from a report for the summary section. */
export function crashFacts(report) {
  const header = report?.header && typeof report.header === 'object' ? report.header : {}
  const payload = report?.payload && typeof report.payload === 'object' ? report.payload : {}
  const exception = payload.exception && typeof payload.exception === 'object' ? payload.exception : {}
  const termination = payload.termination && typeof payload.termination === 'object' ? payload.termination : {}
  const threads = Array.isArray(payload.threads) ? payload.threads : []
  const faulting = Number.isInteger(payload.faultingThread) ? payload.faultingThread : -1
  return {
    app: String(header.app_name || payload.procName || ''),
    version: String(header.app_version || payload.version || ''),
    build: String(header.build_version || ''),
    osVersion: String(header.os_version || payload.osVersion || ''),
    platform: String(header.platform || ''),
    bugType: String(header.bug_type || payload.bug_type || ''),
    timestamp: String(header.timestamp || payload.captureTime || ''),
    pid: Number(payload.pid) || 0,
    exception: {
      type: String(exception.type || ''),
      signal: String(exception.signal || ''),
      codes: typeof exception.codes === 'string' ? exception.codes : '',
    },
    termination: {
      indicator: String(termination.indicator || ''),
      namespace: String(termination.namespace || ''),
      code: termination.code,
    },
    faultingThread: faulting,
    threadCount: threads.length,
  }
}

function frameOf(frame, images) {
  const imageIndex = Number(frame?.imageIndex)
  const image = images[imageIndex] && typeof images[imageIndex] === 'object' ? images[imageIndex] : {}
  const base = toNumber(image.base)
  const offset = toNumber(frame?.imageOffset)
  const imageName = String(image.name || basename(String(image.path || '')) || `image${Number.isFinite(imageIndex) ? imageIndex : '?'}`)
  return {
    imageIndex: Number.isFinite(imageIndex) ? imageIndex : -1,
    imageName,
    imagePath: String(image.path || ''),
    arch: String(image.arch || ''),
    base,
    offset,
    address: base + offset,
    symbol: typeof frame?.symbol === 'string' ? frame.symbol : '',
    symbolLocation: frame?.symbolLocation,
    sourceFile: typeof frame?.sourceFile === 'string' ? frame.sourceFile : '',
    sourceLine: frame?.sourceLine,
  }
}

/**
 * Threads with normalized frames and the report's image table.
 *
 * @param {object} report parsed .ips.
 * @returns {{images: Array<object>, threads: Array<object>}} normalized data.
 */
export function collectThreads(report) {
  const payload = report?.payload && typeof report.payload === 'object' ? report.payload : {}
  const images = Array.isArray(payload.usedImages) ? payload.usedImages : []
  const rawThreads = Array.isArray(payload.threads) ? payload.threads : []
  const faulting = Number.isInteger(payload.faultingThread) ? payload.faultingThread : -1
  return {
    images,
    threads: rawThreads.map((thread, index) => ({
      index,
      triggered: thread?.triggered === true || index === faulting,
      name: String(thread?.name || thread?.queue || ''),
      frames: (Array.isArray(thread?.frames) ? thread.frames : []).map((frame) => frameOf(frame, images)),
    })),
  }
}

async function addDsymBundle(directory, binaries) {
  const dwarf = join(directory, 'Contents', 'Resources', 'DWARF')
  const entries = await readdir(dwarf, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isFile()) binaries.set(entry.name.toLowerCase(), join(dwarf, entry.name))
  }
}

/**
 * Map lowercased binary names to dSYM DWARF paths.
 *
 * Accepts a `.dSYM` bundle, a directory containing bundles, or an `.app` whose
 * sibling `.dSYM` should be used. Missing paths yield an empty map.
 *
 * @param {string} dsymPath user-supplied path.
 * @returns {Promise<Map<string, string>>} binary name → DWARF file.
 */
export async function collectDsymBinaries(dsymPath) {
  const binaries = new Map()
  const root = typeof dsymPath === 'string' ? dsymPath.trim() : ''
  if (root.length === 0) return binaries
  const info = await stat(root).catch(() => undefined)
  if (!info) return binaries
  if (info.isDirectory()) {
    if (/\.dSYM$/i.test(root)) {
      await addDsymBundle(root, binaries)
    } else if (/\.app$/i.test(root)) {
      await addDsymBundle(`${root}.dSYM`, binaries)
      await addDsymBundle(root.replace(/\.app$/i, '.app.dSYM'), binaries)
    } else {
      const budget = { visited: 0 }
      await scanForDsyms(root, binaries, 0, budget)
    }
  }
  return binaries
}

async function scanForDsyms(directory, binaries, depth, budget) {
  if (depth > 3 || budget.visited >= MAX_DSYM_SCAN_DIRECTORIES) return
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (budget.visited >= MAX_DSYM_SCAN_DIRECTORIES) return
    budget.visited += 1
    const full = join(directory, entry.name)
    if (/\.dSYM$/i.test(entry.name)) {
      await addDsymBundle(full, binaries)
      continue
    }
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'Contents') continue
    await scanForDsyms(full, binaries, depth + 1, budget)
  }
}

/** First non-empty line of a command's stderr, for a compact failure note. */
function firstLine(value) {
  const line = String(value || '').split(/\r?\n/).find((entry) => entry.trim().length > 0)
  return line ? line.trim() : ''
}

/**
 * Symbolicate the crashed thread (or every thread) of a report.
 *
 * @param {object} options text, dsym, allThreads, maxFrames, runner, signal.
 * @returns {Promise<object>} facts, threads, notes, missing images.
 */
export async function symbolicateReport({ text, dsym = '', allThreads = false, maxFrames = DEFAULT_MAX_FRAMES, runner, signal } = {}) {
  if (typeof runner !== 'function') throw new Error('symbolicateReport needs a command runner.')
  const report = parseIps(text)
  const facts = crashFacts(report)
  const collected = collectThreads(report)
  const selected = allThreads ? collected.threads : collected.threads.filter((thread) => thread.triggered).slice(0, 1)
  const binaries = await collectDsymBinaries(dsym)
  const notes = []
  const missing = new Set()
  const frameLimit = Math.min(MAX_MAX_FRAMES, Math.max(1, Math.trunc(toNumber(maxFrames) || DEFAULT_MAX_FRAMES)))

  for (const thread of selected) {
    thread.frames = thread.frames.slice(0, frameLimit)
    const groups = new Map()
    for (const frame of thread.frames) {
      if (frame.symbol) continue
      if (frame.base <= 0) {
        missing.add(frame.imageName)
        continue
      }
      const key = frame.imageName.toLowerCase()
      if (!binaries.has(key)) {
        missing.add(frame.imageName)
        continue
      }
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(frame)
    }
    for (const [key, frames] of groups) {
      const dwarf = binaries.get(key)
      const arch = frames[0].arch || 'arm64'
      const argv = ['xcrun', 'atos', '-arch', arch, '-o', dwarf, '-l', hexAddress(frames[0].base), ...frames.map((frame) => hexAddress(frame.address))]
      let result
      try {
        result = await runner(argv, { signal })
      } catch (error) {
        notes.push(`atos failed for ${key}: ${errorMessage(error)}`)
        continue
      }
      if (!result.ok) {
        notes.push(`atos failed for ${key}: ${clip(firstLine(result.stderr) || `exit ${result.exitCode}`, 300)}`)
        continue
      }
      const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
      frames.forEach((frame, index) => {
        const line = lines[index]
        if (line && !/^0x[0-9a-f]+ \(in /i.test(line)) frame.resolved = line
        else missing.add(frame.imageName)
      })
    }
  }

  return {
    ok: true,
    facts,
    threads: selected,
    dsym: dsym ? String(dsym) : '',
    notes,
    missingImages: [...missing],
  }
}

/** Text report for the `symbolicate` action. */
export function formatSymbolicatedReport(value) {
  if (!value || typeof value !== 'object') return 'No symbolication result was returned.'
  if (value.error) return `Symbolication failed: ${value.error}`
  const facts = value.facts && typeof value.facts === 'object' ? value.facts : {}
  const lines = [`Crash: ${facts.app || 'unknown app'}${facts.version ? ` ${facts.version}` : ''}${facts.osVersion ? ` on ${facts.osVersion}` : ''}`]
  const exception = facts.exception || {}
  if (exception.type || exception.signal) {
    lines.push(`Exception: ${[exception.type, exception.signal].filter(Boolean).join(' / ')}${exception.codes ? ` (${exception.codes})` : ''}`)
  }
  const termination = facts.termination || {}
  if (termination.indicator) lines.push(`Termination: ${termination.indicator}`)
  for (const thread of Array.isArray(value.threads) ? value.threads : []) {
    lines.push('', `Thread ${thread.index}${thread.triggered ? ' (crashed)' : ''}`)
    thread.frames.forEach((frame, index) => {
      const symbol = frame.symbol || frame.resolved || `${frame.imageName} + ${frame.offset}`
      const source = frame.sourceFile ? ` (${frame.sourceFile}:${frame.sourceLine ?? '?'})` : ''
      lines.push(`  #${index} ${frame.imageName} ${hexAddress(frame.address)} ${symbol}${source}`)
    })
  }
  if (Array.isArray(value.notes) && value.notes.length > 0) {
    lines.push('', 'Notes:', ...value.notes.map((note) => `- ${note}`))
  }
  if (Array.isArray(value.missingImages) && value.missingImages.length > 0) {
    lines.push('', `No dSYM matched: ${value.missingImages.join(', ')} — pass \`dsym\` (a .dSYM bundle, its folder, or the .app next to it).`)
  }
  return clip(lines.join('\n'))
}
