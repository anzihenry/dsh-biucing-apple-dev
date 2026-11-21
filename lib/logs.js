/**
 * Simulator unified-log queries and crash-report discovery.
 *
 * Two read-only diagnostics:
 *   - `show` runs `xcrun simctl spawn <udid> log show` for a booted simulator,
 *     with filters compiled into one `--predicate` string. Every filter value
 *     is quoted and escaped locally, so a message containing a quote cannot
 *     change the predicate structure.
 *   - `crashes` finds recent `.ips`/`.crash` reports as plain files (no
 *     commands), newest first, and reads the newest one so the model gets the
 *     summary plus a path to the complete report.
 *
 * Line/character caps live in `lib/tools-diag.js`; this module returns the
 * captured text and its facts.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { errorMessage } from './format.js'

/** Actions accepted by the `apple_dev_logs` tool. */
export const LOG_ACTIONS = ['show', 'crashes', 'symbolicate']

export const DEFAULT_LOG_WINDOW = '5m'
/** Longest accepted `--last` window (keeps one query bounded). */
export const MAX_LOG_WINDOW_SECONDS = 24 * 60 * 60
export const DEFAULT_LOG_LINES = 200
export const MAX_LOG_LINES = 2000
export const DEFAULT_CRASH_LIMIT = 25
export const MAX_CRASH_LIMIT = 100
const MAX_FILTER_LENGTH = 500
const MAX_CRASH_READ_BYTES = 256 * 1024

/* ------------------------------------------------------------------------- *
 * Pure parsers / builders (unit-tested in test/diag.test.mjs)
 * ------------------------------------------------------------------------- */

const WINDOW_PATTERN = /^(\d+)\s*([smhd])$/i
const WINDOW_UNITS = { s: 1, m: 60, h: 3600, d: 86400 }

/** Validate and normalize a `--last` window such as `30s`, `5m`, `2h`, `1d`. */
export function parseLogWindow(value, options = {}) {
  const fallback = options.defaultWindow ?? DEFAULT_LOG_WINDOW
  const requested = typeof value === 'string' ? value.trim() : ''
  const text = requested.length > 0 ? requested : String(fallback)
  const match = WINDOW_PATTERN.exec(text)
  if (!match) {
    throw new Error(`\`last\` must look like 30s, 5m, 2h or 1d (got ${JSON.stringify(requested || text)}).`)
  }
  const amount = Number(match[1])
  const unit = match[2].toLowerCase()
  const seconds = amount * WINDOW_UNITS[unit]
  if (!Number.isFinite(seconds) || amount <= 0) {
    throw new Error('`last` must be a positive duration such as 30s, 5m, 2h or 1d.')
  }
  const maxSeconds = Number.isFinite(options.maxSeconds) ? options.maxSeconds : MAX_LOG_WINDOW_SECONDS
  if (seconds > maxSeconds) {
    throw new Error(`\`last\` is capped at ${Math.round(maxSeconds / 3600)}h per query.`)
  }
  return { text: `${amount}${unit}`, seconds }
}

/** Quote one value as a log-predicate string literal. */
export function quoteLogPredicate(value) {
  return `"${String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function filterValue(value, name) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`\`${name}\` must be a string.`)
  const text = value.trim()
  if (text.length === 0) return undefined
  if (text.length > MAX_FILTER_LENGTH) throw new Error(`\`${name}\` is longer than ${MAX_FILTER_LENGTH} characters.`)
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`\`${name}\` must not contain control characters.`)
  return text
}

/**
 * Compile the supported log filters into one `--predicate` expression.
 * Returns `undefined` when no filter is set.
 */
export function buildLogPredicate(filters = {}) {
  const input = filters && typeof filters === 'object' ? filters : {}
  const clauses = []
  const process = filterValue(input.process, 'process')
  const subsystem = filterValue(input.subsystem, 'subsystem')
  const category = filterValue(input.category, 'category')
  const phrase = filterValue(input.message_contains, 'message_contains')
  if (process !== undefined) clauses.push(`process == ${quoteLogPredicate(process)}`)
  if (subsystem !== undefined) clauses.push(`subsystem == ${quoteLogPredicate(subsystem)}`)
  if (category !== undefined) clauses.push(`category == ${quoteLogPredicate(category)}`)
  if (phrase !== undefined) clauses.push(`eventMessage CONTAINS[c] ${quoteLogPredicate(phrase)}`)
  return clauses.length > 0 ? clauses.join(' AND ') : undefined
}

/** Exact argv for one simulator `log show`; every value stays one argument. */
export function buildLogShowArgv({ udid, window = DEFAULT_LOG_WINDOW, predicate } = {}) {
  const device = typeof udid === 'string' ? udid.trim() : ''
  if (device.length === 0) throw new Error('A simulator UDID is required for `log show`.')
  const argv = ['xcrun', 'simctl', 'spawn', device, 'log', 'show', '--style', 'compact', '--last', String(window)]
  if (typeof predicate === 'string' && predicate.trim().length > 0) argv.push('--predicate', predicate.trim())
  return argv
}

/** True for the crash-report file extensions macOS uses. */
export function isCrashReportName(name) {
  return typeof name === 'string' && /\.(ips|crash)$/i.test(name.trim())
}

/**
 * Crash-report directories for a simulator: the device data directory plus the
 * host-wide user report store. `path` overrides this in the tool.
 */
export function crashReportDirectories(udid, options = {}) {
  const home = typeof options.home === 'string' && options.home.trim().length > 0 ? options.home.trim() : homedir()
  const directories = []
  const device = typeof udid === 'string' ? udid.trim() : ''
  if (device.length > 0) {
    directories.push(join(home, 'Library', 'Developer', 'CoreSimulator', 'Devices', device, 'data', 'Library', 'Logs', 'DiagnosticReports'))
  }
  if (options.includeHost !== false) directories.push(join(home, 'Library', 'Logs', 'DiagnosticReports'))
  return directories
}

/** Newest first; entries without a usable timestamp last. */
export function sortCrashReports(entries) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === 'object') : []
  return [...list].sort((left, right) => {
    const leftTime = Number(left.modifiedAt)
    const rightTime = Number(right.modifiedAt)
    const leftValid = Number.isFinite(leftTime)
    const rightValid = Number.isFinite(rightTime)
    if (leftValid !== rightValid) return leftValid ? -1 : 1
    if (leftValid && leftTime !== rightTime) return rightTime - leftTime
    return String(left.name ?? '').localeCompare(String(right.name ?? ''))
  })
}

function firstText(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Parse crash-report metadata from an `.ips` JSON header or a legacy `.crash`
 * text header. The returned object never includes stack traces or paths.
 */
export function parseCrashReportMetadata(text) {
  const value = typeof text === 'string' ? text : ''
  const firstLine = value.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (firstLine.startsWith('{')) {
    try {
      const header = JSON.parse(firstLine)
      if (header && typeof header === 'object') {
        return {
          format: 'ips',
          appName: firstText(header.app_name) ?? firstText(header.name),
          version: firstText(header.app_version) ?? firstText(header.build_version),
          bundleId: firstText(header.bundleID) ?? firstText(header.bundle_id),
          timestamp: firstText(header.timestamp),
          osVersion: firstText(header.os_version),
          incidentId: firstText(header.incident_id),
          bugType: header.bug_type !== undefined && header.bug_type !== null ? String(header.bug_type) : undefined,
          exceptionType: undefined,
        }
      }
    } catch {
      /* fall through to the legacy header parser */
    }
  }
  const fields = {}
  for (const line of value.split(/\r?\n/).slice(0, 80)) {
    const match = /^([A-Za-z][A-Za-z0-9 _/-]*):\s*(.+)$/.exec(line)
    if (match) fields[match[1].trim()] = match[2].trim()
  }
  const pick = (...names) => {
    for (const name of names) {
      if (typeof fields[name] === 'string' && fields[name].length > 0) return fields[name]
    }
    return undefined
  }
  return {
    format: Object.keys(fields).length > 0 ? 'crash' : 'unknown',
    appName: (pick('Process', 'Process Name') ?? '').replace(/\s*\[\d+\]\s*$/, '') || undefined,
    version: pick('Version'),
    bundleId: pick('Identifier', 'Bundle ID'),
    timestamp: pick('Date/Time', 'Date'),
    osVersion: pick('OS Version'),
    incidentId: pick('Incident Identifier'),
    bugType: undefined,
    exceptionType: pick('Exception Type'),
  }
}

/* ------------------------------------------------------------------------- *
 * Command-backed / filesystem-backed operations
 * ------------------------------------------------------------------------- */

function failureReason(result) {
  if (result.spawnError) return `could not start \`${result.command}\`: ${result.spawnError}`
  if (result.timedOut) return `\`${result.command}\` timed out`
  if (result.cancelled) return `\`${result.command}\` was cancelled`
  const detail = [result.stderr, result.stdout]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0)
    .join('\n')
  return detail || `\`${result.command}\` exited ${result.exitCode}`
}

/**
 * Run one `log show` against a simulator.
 *
 * @param {Function} runner command executor from `lib/runner.js`.
 * @param {{ udid: string, name?: string }} device resolved simulator.
 * @param {object} [options] `{ cwd, signal, window, predicate, timeoutMs }`.
 */
export async function showLogs(runner, device, options = {}) {
  const udid = device && typeof device.udid === 'string' ? device.udid.trim() : ''
  if (udid.length === 0) return { ok: false, window: options.window, predicate: options.predicate, error: 'A simulator device is required for `log show`.' }
  const window = options.window ?? DEFAULT_LOG_WINDOW
  const predicate = options.predicate
  const argv = buildLogShowArgv({ udid, window, predicate })
  const result = await runner(argv, {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 120000,
    label: `simctl log show ${device.name ?? udid}`,
  })
  if (!result.ok) {
    return {
      ok: false,
      window,
      predicate,
      command: result.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
      error: failureReason(result),
    }
  }
  return {
    ok: true,
    window,
    predicate,
    command: result.command,
    exitCode: 0,
    durationMs: result.durationMs,
    output: typeof result.stdout === 'string' ? result.stdout : '',
    outputTruncated: Boolean(result.stdoutTruncated),
  }
}

/**
 * List `.ips`/`.crash` reports from the given directories, newest first.
 * Missing or unreadable directories are reported, not fatal.
 */
export async function listCrashReports(directories, options = {}) {
  const limit = clampLimit(options.limit, DEFAULT_CRASH_LIMIT, 1, MAX_CRASH_LIMIT)
  const reports = []
  const scanned = []
  const seenDirectories = new Set()
  for (const rawDirectory of Array.isArray(directories) ? directories : []) {
    const directory = typeof rawDirectory === 'string' ? rawDirectory.trim() : ''
    if (directory.length === 0 || seenDirectories.has(directory)) continue
    seenDirectories.add(directory)
    let names = []
    try {
      names = await readdir(directory)
    } catch {
      scanned.push({ directory, exists: false, count: 0 })
      continue
    }
    let count = 0
    for (const name of names) {
      if (!isCrashReportName(name)) continue
      const file = join(directory, name)
      let info
      try {
        info = await stat(file)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      count += 1
      reports.push({
        name,
        path: file,
        directory,
        modifiedAt: info.mtimeMs,
        modified: new Date(info.mtimeMs).toISOString(),
        size: info.size,
      })
    }
    scanned.push({ directory, exists: true, count })
  }
  const sorted = sortCrashReports(reports)
  return {
    reports: sorted.slice(0, limit),
    total: sorted.length,
    scanned,
    truncated: sorted.length > limit,
  }
}

/** Read one crash report (a bounded prefix) plus its parsed header. */
export async function readCrashReport(file, options = {}) {
  const path = typeof file === 'string' ? file.trim() : ''
  if (path.length === 0) return { ok: false, error: 'A crash report path is required.' }
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_CRASH_READ_BYTES
  try {
    const info = await stat(path)
    const buffer = await readFile(path)
    const truncated = buffer.length > maxBytes
    const text = buffer.subarray(0, maxBytes).toString('utf8')
    return {
      ok: true,
      path,
      size: info.size,
      modified: new Date(info.mtimeMs).toISOString(),
      modifiedAt: info.mtimeMs,
      truncated,
      metadata: parseCrashReportMetadata(text),
      text,
    }
  } catch (error) {
    return { ok: false, path, error: `Could not read ${path}: ${errorMessage(error)}` }
  }
}

function clampLimit(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}
