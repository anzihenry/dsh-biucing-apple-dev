/**
 * Process execution and path plumbing shared by every Apple Dev tool.
 *
 * One module owns every child process so that cancellation, timeouts, output
 * caps and error reporting behave the same for `xcodebuild`, `xcrun simctl`,
 * `swift` and `codesign`. Every command runs through the Host's `subprocess`
 * service — never `node:child_process` — so the profile's execution world,
 * environment scrubbing, spill files and termination ladder apply.
 *
 * The runner is deliberately plain: `run()` resolves a result object and never
 * throws for a non-zero exit code; callers decide whether a failure is a tool
 * error or a legitimate result (a failing test run is a result).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { errorMessage, formatDuration } from './format.js'

/** Upper bound for a single command; the framework tool timeout stays below it. */
export const MAX_TIMEOUT_MS = 60 * 60 * 1000
/** Retained stream bytes: enough for a full build log, bounded for memory. */
export const MAX_STREAM_BYTES = 32 * 1024 * 1024
const MIN_TIMEOUT_MS = 1000
const DEFAULT_GRACE_MS = 5000

/** Normalized configuration with documented defaults. */
export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const derivedDataPath = stringOr(input.derivedDataPath, '.apple-dev/DerivedData')
  const logDirectory = stringOr(input.logDirectory, '.apple-dev/logs')
  return {
    xcodebuild: stringOr(input.xcodebuild, 'xcodebuild'),
    developerDir: stringOr(input.developerDir, ''),
    derivedDataPath,
    logDirectory,
    timeoutMs: boundedNumber(input.timeoutMs, 15 * 60 * 1000, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxOutputBytes: boundedNumber(input.maxOutputBytes, 4 * 1024 * 1024, 64 * 1024, MAX_STREAM_BYTES),
    // Xcode MCP bridge (`xcrun mcpbridge`). The bridge is a long-lived child
    // process; startup covers its initialize + tools/list handshake, while a
    // tool call may legitimately wait for a build, test run or preview render.
    mcpEnabled: input.mcpEnabled !== false,
    mcpCommand: stringOr(input.mcpCommand, 'xcrun'),
    mcpArgs: stringArray(input.mcpArgs, ['mcpbridge']),
    mcpStartupTimeoutMs: boundedNumber(input.mcpStartupTimeoutMs, 30 * 1000, MIN_TIMEOUT_MS, 5 * 60 * 1000),
    mcpToolCallTimeoutMs: boundedNumber(input.mcpToolCallTimeoutMs, 10 * 60 * 1000, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    mcpAllowMutations: input.mcpAllowMutations === true,
  }
}

function stringArray(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const items = value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
  return items.length > 0 ? items : [...fallback]
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function boundedNumber(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Absolute path for a user-supplied value; relative values resolve against `cwd`. */
export function resolveUserPath(cwd, value) {
  const requested = typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
  if (requested.length === 0) return cwd
  const expanded = requested.startsWith('~/') ? join(homeDirectory(), requested.slice(2)) : requested
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded)
}

function homeDirectory() {
  const home = typeof process.env.HOME === 'string' ? process.env.HOME : ''
  return home.length > 0 ? home : process.cwd()
}

/** True when `target` is `directory` or below it. */
export function isInsideDirectory(directory, target) {
  const relation = relative(resolvePath(directory), resolvePath(target))
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}

/** Working directory of the calling session, with safe fallbacks. */
export function sessionDirectory(ctx, exec) {
  try {
    const service = ctx.get('workingDirectory')
    if (service) {
      const session = exec && exec.agent ? exec.agent.session : undefined
      if (session) {
        const directory = service.get(session)
        if (directory) return directory
      }
      if (service.defaultDirectory) return service.defaultDirectory
    }
  } catch {
    /* fall through to the process directory */
  }
  return process.cwd()
}

/** Environment additions every Apple command needs. */
function commandEnvironment(config) {
  const env = {}
  if (config.developerDir.length > 0) env.DEVELOPER_DIR = config.developerDir
  return env
}

/** Human-readable representation of an argv, quoting only when necessary. */
export function formatCommand(argv) {
  return argv
    .map((part) => (/^[\w./:=@+-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`))
    .join(' ')
}

/**
 * Create the runner bound to one plugin instance.
 *
 * @param {object} ctx Host plugin context.
 * @param {object} config Normalized configuration from {@link resolveConfig}.
 * @returns {(argv: string[], options?: object) => Promise<object>} command executor.
 */
export function createRunner(ctx, config) {
  /**
   * Run one argv to completion with bounded output and one deadline.
   *
   * @param {string[]} argv exact executable and arguments.
   * @param {object} [options] cwd, signal, timeoutMs, maxBytes, stdin, label.
   */
  return async function run(argv, options = {}) {
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string')) {
      throw new Error('run() needs a non-empty argv of strings')
    }
    const subprocess = ctx.get('subprocess')
    if (!subprocess || typeof subprocess.spawn !== 'function') {
      throw new Error('The Host subprocess service is unavailable; Apple Dev commands need it.')
    }
    const cwd = resolvePath(options.cwd ?? process.cwd())
    const timeoutMs = boundedNumber(options.timeoutMs, config.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const maxBytes = boundedNumber(options.maxBytes, config.maxOutputBytes, 64 * 1024, MAX_STREAM_BYTES)
    const startedAt = Date.now()
    const command = formatCommand(argv)
    const label = typeof options.label === 'string' ? options.label : 'command'

    const controller = new AbortController()
    let timedOut = false
    let cancelled = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const externalSignal = options.signal
    const forwardAbort = () => {
      cancelled = true
      controller.abort()
    }
    if (externalSignal) {
      if (externalSignal.aborted) forwardAbort()
      else externalSignal.addEventListener('abort', forwardAbort, { once: true })
    }

    let handle
    try {
      handle = subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: options.stdin === undefined ? 'ignore' : options.stdin,
          stdout: { maxBytes, spill: { maxBytes: MAX_STREAM_BYTES } },
          stderr: { maxBytes, spill: { maxBytes: MAX_STREAM_BYTES } },
        },
        graceMs: DEFAULT_GRACE_MS,
        signal: controller.signal,
        env: options.env === undefined ? commandEnvironment(config) : { ...commandEnvironment(config), ...options.env },
      })
    } catch (error) {
      clearTimeout(timer)
      if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort)
      return {
        ok: false,
        command,
        argv,
        cwd,
        label,
        exitCode: null,
        signal: null,
        timedOut,
        cancelled,
        spawnError: errorMessage(error),
        stdout: '',
        stderr: '',
        truncated: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: Date.now() - startedAt,
      }
    }

    let outcome
    let spawnError
    try {
      outcome = await handle.done
    } catch (error) {
      spawnError = errorMessage(error)
      outcome = { exitCode: null, signal: null }
    } finally {
      clearTimeout(timer)
      if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort)
    }

    const stdoutRead = safeRead(handle.collected && handle.collected.stdout)
    const stderrRead = safeRead(handle.collected && handle.collected.stderr)
    const exitCode = typeof outcome.exitCode === 'number' ? outcome.exitCode : null
    const signal = outcome.signal ?? null
    return {
      ok: exitCode === 0 && !timedOut && !cancelled && spawnError === undefined,
      command,
      argv,
      cwd,
      label,
      exitCode,
      signal,
      timedOut,
      cancelled,
      spawnError,
      stdout: stdoutRead.text,
      stderr: stderrRead.text,
      stdoutTruncated: stdoutRead.lossy,
      stderrTruncated: stderrRead.lossy,
      stdoutSpillPath: stdoutRead.spillPath,
      stderrSpillPath: stderrRead.spillPath,
      truncated: stdoutRead.lossy || stderrRead.lossy,
      durationMs: Date.now() - startedAt,
    }
  }
}

function safeRead(reader) {
  if (!reader || typeof reader.readFrom !== 'function') {
    return { text: '', nextOffset: 0, lossy: false }
  }
  try {
    return reader.readFrom(0)
  } catch {
    return { text: '', nextOffset: 0, lossy: false }
  }
}

/** One-line outcome summary shared by the build, test and run tools. */
export function summarizeResult(result, { includeError = true } = {}) {
  if (result.spawnError) return `could not start \`${result.command}\`: ${result.spawnError}`
  if (result.timedOut) return `\`${result.command}\` timed out after ${formatDuration(result.durationMs)}`
  if (result.cancelled) return `\`${result.command}\` was cancelled`
  if (result.signal) return `\`${result.command}\` died from ${result.signal} after ${formatDuration(result.durationMs)}`
  return `\`${result.command}\` exited ${result.exitCode} in ${formatDuration(result.durationMs)}${includeError && result.stderr.trim() ? '' : ''}`
}

/** Throw a readable error when a command that must succeed did not. */
export function assertSucceeded(result, what) {
  if (result.ok) return result
  const detail = [result.spawnError, result.stderr.trim() || result.stdout.trim()].filter(Boolean).join('\n')
  const reason = result.timedOut ? 'timed out' : result.cancelled ? 'was cancelled' : `exited ${result.exitCode}`
  throw new Error(`${what} ${reason}${detail ? `:\n${detail.slice(-4000)}` : ''}`)
}

/** Write the complete command output under the log directory; returns the path. */
export async function saveLog(cwd, logDirectory, prefix, result) {
  const directory = resolveUserPath(cwd, logDirectory)
  try {
    await mkdir(directory, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(directory, `${prefix}-${stamp}.log`)
    const body = [
      `# ${prefix}`,
      `# command: ${result.command}`,
      `# cwd: ${result.cwd}`,
      `# exit: ${result.exitCode} signal=${result.signal ?? 'none'} timedOut=${result.timedOut} durationMs=${result.durationMs}`,
      '',
      '## stdout',
      result.stdout,
      '',
      '## stderr',
      result.stderr,
      '',
    ].join('\n')
    await writeFile(file, body, 'utf8')
    return file
  } catch {
    return undefined
  }
}

/** Resolve one executable in the profile's execution world. */
export async function resolveExecutable(ctx, command, { signal } = {}) {
  const subprocess = ctx.get('subprocess')
  if (!subprocess || typeof subprocess.resolveExecutable !== 'function') {
    throw new Error('The Host subprocess service is unavailable; Apple Dev commands need it.')
  }
  return subprocess.resolveExecutable(command, undefined, signal)
}

/** True when the executable resolves on PATH. */
export async function hasExecutable(ctx, command, options = {}) {
  try {
    await resolveExecutable(ctx, command, options)
    return true
  } catch {
    return false
  }
}

/** Most recent ISO timestamp, for `generatedAt` fields. */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * Why the Apple toolchain cannot run here, or `undefined` on macOS.
 * Tools return this as a readable result instead of throwing.
 */
export function platformProblem() {
  if (process.platform === 'darwin') return undefined
  return `Apple Dev tools require macOS; this Harness Host runs on ${process.platform}.`
}
