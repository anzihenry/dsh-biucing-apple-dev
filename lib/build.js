/**
 * Build output parsing and destination construction for `apple_dev_build`.
 *
 * `xcodebuild` reports build success in its output rather than only through the
 * exit code (a scheme can "succeed" while a later step fails), so the tool
 * combines both. Destination strings are built here — never by string
 * concatenation in the tool — because `xcodebuild -destination` has a small,
 * strict grammar and a malformed one fails every build.
 */
import { resolveDevice } from './simulator.js'

const IF_FAILED_COMMANDS_HEADER = /^The following build commands failed:/
const BUILD_SUCCEEDED = /^\*\* BUILD SUCCEEDED \*\*$/
const BUILD_FAILED = /^\*\* BUILD FAILED \*\*$/
const BUILD_COMPLETE = /^Build complete!/
const FILE_DIAGNOSTIC = /^(.+?):(\d+)(?::(\d+))?:\s*(error|warning|note):\s*(.+)$/
const BARE_ERROR = /^(?:(?:fatal|swift) error|error):\s*(.+)$/
const BARE_WARNING = /^warning:\s*(.+)$/

const MAX_ERRORS = 40
const MAX_WARNINGS = 20

function emptyBuildParse() {
  return {
    result: 'unknown',
    succeeded: undefined,
    errors: [],
    errorCount: 0,
    errorsTruncated: false,
    warnings: [],
    warningCount: 0,
    failedCommands: [],
    failedCommandCount: 0,
  }
}

/**
 * Parse combined `xcodebuild`/`swift build` output.
 *
 * Recognizes `** BUILD SUCCEEDED **`, `** BUILD FAILED **`, SwiftPM's
 * `Build complete!`, compiler diagnostics in `path:line[:col]: error: message`
 * form (also `error: message`), warnings, and the "The following build commands
 * failed:" block.
 *
 * @param {string} text
 * @returns {{ result: 'succeeded'|'failed'|'unknown', succeeded: boolean|undefined,
 *   errors: object[], errorCount: number, errorsTruncated: boolean,
 *   warnings: object[], warningCount: number,
 *   failedCommands: string[], failedCommandCount: number }}
 */
export function parseBuildOutput(text) {
  const value = typeof text === 'string' ? text : ''
  const parsed = emptyBuildParse()
  const seenErrors = new Set()
  const seenWarnings = new Set()
  const seenCommands = new Set()
  let inFailedCommands = false
  let sawSucceeded = false
  let sawFailed = false

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (inFailedCommands) {
      if (line.length === 0) {
        inFailedCommands = false
        continue
      }
      if (/^\s+/.test(rawLine)) {
        const command = line.replace(/,$/, '').trim()
        if (command.length > 0 && !seenCommands.has(command)) {
          seenCommands.add(command)
          parsed.failedCommandCount += 1
          if (parsed.failedCommands.length < 10) parsed.failedCommands.push(command)
        }
        continue
      }
      inFailedCommands = false
    }
    if (BUILD_SUCCEEDED.test(line)) {
      sawSucceeded = true
      continue
    }
    if (BUILD_FAILED.test(line)) {
      sawFailed = true
      continue
    }
    if (BUILD_COMPLETE.test(line)) {
      sawSucceeded = true
      continue
    }
    if (IF_FAILED_COMMANDS_HEADER.test(line)) {
      inFailedCommands = true
      continue
    }

    const diagnostic = FILE_DIAGNOSTIC.exec(line)
    if (diagnostic) {
      const entry = {
        file: diagnostic[1].trim(),
        line: Number(diagnostic[2]),
        column: diagnostic[3] === undefined ? undefined : Number(diagnostic[3]),
        message: diagnostic[5].trim(),
        raw: line,
      }
      if (diagnostic[4] === 'error') {
        const key = `${entry.file}:${entry.line}:${entry.column ?? ''}:${entry.message}`
        if (!seenErrors.has(key)) {
          seenErrors.add(key)
          parsed.errorCount += 1
          if (parsed.errors.length < MAX_ERRORS) parsed.errors.push(entry)
        }
      } else if (diagnostic[4] === 'warning') {
        const key = `w:${entry.file}:${entry.line}:${entry.column ?? ''}:${entry.message}`
        if (!seenWarnings.has(key)) {
          seenWarnings.add(key)
          parsed.warningCount += 1
          if (parsed.warnings.length < MAX_WARNINGS) parsed.warnings.push(entry)
        }
      }
      continue
    }

    const bareError = BARE_ERROR.exec(line)
    if (bareError) {
      const message = bareError[1].trim()
      const key = `e:${message}`
      if (message.length > 0 && !seenErrors.has(key)) {
        seenErrors.add(key)
        parsed.errorCount += 1
        if (parsed.errors.length < MAX_ERRORS) {
          parsed.errors.push({ file: undefined, line: undefined, column: undefined, message, raw: line })
        }
      }
      continue
    }

    const bareWarning = BARE_WARNING.exec(line)
    if (bareWarning) {
      const message = bareWarning[1].trim()
      const key = `w:${message}`
      if (message.length > 0 && !seenWarnings.has(key)) {
        seenWarnings.add(key)
        parsed.warningCount += 1
        if (parsed.warnings.length < MAX_WARNINGS) {
          parsed.warnings.push({ file: undefined, line: undefined, column: undefined, message, raw: line })
        }
      }
      continue
    }
  }

  parsed.errorsTruncated = parsed.errorCount > parsed.errors.length
  if (sawSucceeded && !sawFailed) {
    parsed.succeeded = true
    parsed.result = 'succeeded'
  } else if (sawFailed) {
    parsed.succeeded = false
    parsed.result = 'failed'
  } else if (parsed.errorCount > 0) {
    parsed.succeeded = false
    parsed.result = 'failed'
  } else if (sawSucceeded) {
    parsed.succeeded = true
    parsed.result = 'succeeded'
  }
  return parsed
}

/* ------------------------------------------------------------------------- *
 * Destinations
 * ------------------------------------------------------------------------- */

const PLATFORM_ALIASES = new Map([
  ['ios', { kind: 'simulator', family: 'iOS' }],
  ['ios simulator', { kind: 'simulator', family: 'iOS' }],
  ['ios-simulator', { kind: 'simulator', family: 'iOS' }],
  ['iphonesimulator', { kind: 'simulator', family: 'iOS' }],
  ['tvos', { kind: 'simulator', family: 'tvOS' }],
  ['tvos simulator', { kind: 'simulator', family: 'tvOS' }],
  ['appletvsimulator', { kind: 'simulator', family: 'tvOS' }],
  ['watchos', { kind: 'simulator', family: 'watchOS' }],
  ['watchos simulator', { kind: 'simulator', family: 'watchOS' }],
  ['watchsimulator', { kind: 'simulator', family: 'watchOS' }],
  ['visionos', { kind: 'simulator', family: 'visionOS' }],
  ['visionos simulator', { kind: 'simulator', family: 'visionOS' }],
  ['xros simulator', { kind: 'simulator', family: 'visionOS' }],
  ['xrsimulator', { kind: 'simulator', family: 'visionOS' }],
  ['iphoneos', { kind: 'device', family: 'iOS' }],
  ['ios device', { kind: 'device', family: 'iOS' }],
  ['appletvos', { kind: 'device', family: 'tvOS' }],
  ['tvos device', { kind: 'device', family: 'tvOS' }],
  ['watchos device', { kind: 'device', family: 'watchOS' }],
  ['visionos device', { kind: 'device', family: 'visionOS' }],
  ['xros', { kind: 'device', family: 'visionOS' }],
  ['macos', { kind: 'macos', family: 'macOS' }],
  ['macosx', { kind: 'macos', family: 'macOS' }],
  ['osx', { kind: 'macos', family: 'macOS' }],
  ['mac', { kind: 'macos', family: 'macOS' }],
  ['mac catalina', { kind: 'macos', family: 'macOS' }],
  ['mac catalyst', { kind: 'macos', family: 'macOS' }],
])

/**
 * Normalize a user-facing platform name.
 *
 * `ios`/`tvos`/`watchos`/`visionos` mean the simulator; `macos` means a Mac
 * destination; `iphoneos`/`xros`/`... device` mean a physical-device build.
 *
 * @param {string} value
 * @returns {{ kind: 'simulator'|'device'|'macos', family: string, label: string }|undefined}
 */
export function normalizePlatform(value) {
  const key = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  if (key.length === 0) return undefined
  const alias = PLATFORM_ALIASES.get(key)
  if (!alias) return undefined
  const label =
    alias.kind === 'macos' ? 'macOS' : alias.kind === 'simulator' ? `${alias.family} Simulator` : alias.family
  return { kind: alias.kind, family: alias.family, label }
}

/** Destination platform label for a simulator family (`iOS` → `iOS Simulator`). */
export function simulatorPlatformLabel(family) {
  return family && family !== 'unknown' ? `${family} Simulator` : 'iOS Simulator'
}

/**
 * Build `platform=<label>,id=<udid>` (or the `name=...,OS=...` form) for one
 * simulator device.
 *
 * @param {object} device row from `listSimulators` (udid, name, platform, osVersion).
 * @param {{ os?: string, platform?: string }} [options]
 * @returns {string}
 */
export function simulatorDestination(device, options = {}) {
  const info = normalizePlatform(options.platform)
  const family =
    info && (info.kind === 'simulator' || info.kind === 'device')
      ? info.family
      : typeof device.platform === 'string' && device.platform !== 'unknown'
        ? device.platform
        : 'iOS'
  const label = info && info.kind === 'simulator' ? info.label : simulatorPlatformLabel(family)
  const os = typeof options.os === 'string' ? options.os.trim() : ''
  if (os.length > 0) return `platform=${label},name=${device.name},OS=${os}`
  return `platform=${label},id=${device.udid}`
}

function publicDevice(device) {
  return {
    name: device.name,
    udid: device.udid,
    platform: device.platform,
    osVersion: device.osVersion,
    state: device.state,
  }
}

/**
 * Resolve build/test destination inputs into one `xcodebuild -destination` value.
 *
 * Precedence: explicit `destination` > `device` (resolved against the simulator
 * list) > `platform` (generic). When nothing is given the result carries no
 * destination so the caller can let `xcodebuild` choose or auto-pick a device.
 *
 * @param {object[]} devices simulator rows (`listSimulators`).
 * @param {{ destination?: string, platform?: string, device?: string, os?: string }} input
 * @returns {{ ok: boolean, destination?: string, error?: string, candidates?: object[],
 *   device?: object, platform?: string, generic?: boolean, explicit?: boolean, note?: string }}
 */
export function buildDestination(devices, input = {}) {
  const explicit = typeof input.destination === 'string' ? input.destination.trim() : ''
  if (explicit.length > 0) return { ok: true, destination: explicit, explicit: true }
  const os = typeof input.os === 'string' && input.os.trim().length > 0 ? input.os.trim() : undefined
  const selector = typeof input.device === 'string' && input.device.trim().length > 0 ? input.device.trim() : ''
  const requestedPlatform =
    typeof input.platform === 'string' && input.platform.trim().length > 0 ? input.platform.trim() : ''
  const platform = normalizePlatform(requestedPlatform)
  if (requestedPlatform.length > 0 && !platform) {
    return {
      ok: false,
      error: `Unknown platform "${requestedPlatform}". Use iOS, tvOS, watchOS, visionOS, macOS, or "... device" for a physical device.`,
    }
  }
  if (platform && platform.kind === 'macos') {
    if (selector.length > 0) {
      return { ok: false, error: '`device` selects a simulator; do not combine it with platform macOS.' }
    }
    if (os) return { ok: false, error: '`os` only applies to a simulator or device destination, not macOS.' }
    return { ok: true, destination: 'platform=macOS', platform: 'macOS' }
  }
  if (selector.length > 0) {
    const resolved = resolveDevice(Array.isArray(devices) ? devices : [], selector)
    if (resolved.error) {
      return { ok: false, error: resolved.error, candidates: (resolved.candidates || []).map(publicDevice) }
    }
    const device = resolved.device
    if (platform && platform.kind === 'device' && platform.family !== device.platform) {
      return {
        ok: false,
        error: `Device ${device.name} is a ${device.platform} simulator but platform "${requestedPlatform}" expects ${platform.family}.`,
      }
    }
    return {
      ok: true,
      destination: simulatorDestination(device, { os, platform: platform ? platform.label : device.platform }),
      device: publicDevice(device),
      platform: simulatorPlatformLabel(device.platform),
      note: resolved.note,
    }
  }
  if (platform) {
    return { ok: true, destination: `generic/platform=${platform.label}`, platform: platform.label, generic: true }
  }
  return {
    ok: true,
    destination: undefined,
    note: 'No destination was specified; xcodebuild chooses its default.',
  }
}

/**
 * Pick a sensible simulator when the caller gave no destination.
 *
 * Prefers a booted device of the preferred platform family, then any booted
 * device, then an iPhone-like device of that family.
 *
 * @param {object[]} devices simulator rows.
 * @param {{ platform?: string }} [options]
 * @returns {object|undefined}
 */
export function pickDefaultSimulator(devices, options = {}) {
  const list = (Array.isArray(devices) ? devices : []).filter(
    (device) => device && typeof device.udid === 'string' && device.isAvailable !== false,
  )
  if (list.length === 0) return undefined
  const info = normalizePlatform(options.platform)
  const family = info && (info.kind === 'simulator' || info.kind === 'device') ? info.family : undefined
  const preferredFamily = family || 'iOS'
  const familyDevices = list.filter((device) => device.platform === preferredFamily)
  if (family && familyDevices.length === 0) return undefined
  const pool = familyDevices.length > 0 ? familyDevices : list
  const bootedInPool = pool.filter((device) => device.state === 'Booted')
  if (bootedInPool.length > 0) return bootedInPool[0]
  if (!family) {
    const bootedAnywhere = list.filter((device) => device.state === 'Booted')
    if (bootedAnywhere.length > 0) return bootedAnywhere[0]
  }
  const iphone = pool.find((device) => /iphone/i.test(device.name))
  return iphone || pool[0]
}

/* ------------------------------------------------------------------------- *
 * SwiftPM outer-sandbox fallback
 * ------------------------------------------------------------------------- */

/**
 * True when SwiftPM could not apply its own sandbox because the outer
 * environment (the Harness host sandbox) forbids nested `sandbox-exec`.
 * In that case the build never started, so retrying without SwiftPM's sandbox
 * is safe and is the only way to compile the package manifest.
 */
export function needsSwiftSandboxFallback(text) {
  const value = String(text ?? '')
  return /sandbox_apply:\s*Operation not permitted/.test(value)
}

/**
 * Insert `--disable-sandbox` into a `swift`/`xcrun swift` invocation.
 * Returns a copy; the input argv is not mutated.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function swiftSandboxFallbackArgv(argv) {
  const result = Array.isArray(argv) ? argv.slice() : []
  const swiftIndex = result.findIndex((part) => part === 'swift' || /\/swift$/.test(part))
  if (swiftIndex < 0 || swiftIndex > 1) return result
  const subcommand = result[swiftIndex + 1]
  if (subcommand === 'package') {
    return [
      ...result.slice(0, swiftIndex + 2),
      '--disable-sandbox',
      ...result.slice(swiftIndex + 2),
    ]
  }
  if (subcommand === 'build' || subcommand === 'test') {
    return [
      ...result.slice(0, swiftIndex + 2),
      '--disable-sandbox',
      ...result.slice(swiftIndex + 2),
    ]
  }
  return result
}
