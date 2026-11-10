/**
 * Xcode toolchain discovery and the small parsers behind the environment tool.
 *
 * Every read is best-effort: a machine with only Command Line Tools (no full
 * Xcode, no simulator runtimes) must still produce a useful report instead of
 * failing the tool. Missing pieces become `warnings` entries.
 */
import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hasExecutable, nowIso, platformProblem, resolveExecutable } from './runner.js'

const SDK_PATTERN = /^(.+?)\s+-\s*sdk\s+(\S+)\s*$/
const IDENTITY_PATTERN = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"\s*$/

/** Parse `xcodebuild -version` output. */
export function parseXcodeVersion(text) {
  const value = typeof text === 'string' ? text : ''
  const version = /^Xcode\s+(.+)$/m.exec(value)
  const build = /^Build version\s+(\S+)$/m.exec(value)
  return { version: version ? version[1].trim() : undefined, build: build ? build[1].trim() : undefined }
}

/** Platform name for one SDK identifier (`iphonesimulator27.2` → `iOS Simulator`). */
export function platformForSdk(sdk) {
  const value = String(sdk || '').toLowerCase()
  if (value.startsWith('iphonesimulator')) return 'iOS Simulator'
  if (value.startsWith('iphoneos')) return 'iOS'
  if (value.startsWith('macosx')) return 'macOS'
  if (value.startsWith('appletvsimulator')) return 'tvOS Simulator'
  if (value.startsWith('appletvos')) return 'tvOS'
  if (value.startsWith('watchsimulator')) return 'watchOS Simulator'
  if (value.startsWith('watchos')) return 'watchOS'
  if (value.startsWith('xrsimulator')) return 'visionOS Simulator'
  if (value.startsWith('xros')) return 'visionOS'
  if (value.startsWith('driverkit')) return 'DriverKit'
  return 'unknown'
}

/** Parse `xcodebuild -showsdks` into `{ label, sdk, name, platform }` rows. */
export function parseSdks(text) {
  const rows = []
  const seen = new Set()
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = SDK_PATTERN.exec(line.trim())
    if (!match) continue
    const label = match[1].trim()
    const sdk = match[2].trim()
    if (seen.has(sdk)) continue
    seen.add(sdk)
    const name = label.replace(/\s+\d[\w.]*$/, '').trim()
    rows.push({ label, sdk, name, platform: platformForSdk(sdk) })
  }
  return rows
}

/** Parse `security find-identity -v -p codesigning` output. */
export function parseIdentities(text) {
  const identities = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = IDENTITY_PATTERN.exec(line)
    if (match) identities.push({ hash: match[1].toUpperCase(), name: match[2] })
  }
  const countMatch = /(\d+)\s+valid identities found/.exec(String(text || ''))
  return { identities, count: countMatch ? Number(countMatch[1]) : identities.length }
}

/** Platform name for a simulator runtime identifier. */
export function platformForRuntime(identifier) {
  const value = String(identifier || '')
  if (value.includes('SimRuntime.iOS')) return 'iOS'
  if (value.includes('SimRuntime.tvOS')) return 'tvOS'
  if (value.includes('SimRuntime.watchOS')) return 'watchOS'
  if (value.includes('SimRuntime.xrOS')) return 'visionOS'
  return 'unknown'
}

/** Version string for a simulator runtime identifier (`iOS-27-2` → `27.2`). */
export function versionForRuntime(identifier) {
  const match = /SimRuntime\.[A-Za-z]+-(\d+(?:-\d+)*)/.exec(String(identifier || ''))
  return match ? match[1].replaceAll('-', '.') : undefined
}

/**
 * Normalize `xcrun simctl list devices --json` output.
 *
 * JSON output is parsed from the first `{` because CoreSimulator warnings can
 * precede it. `state` is normalized to `Booted`, `Shutdown`, `Booting`, etc.
 */
export function parseSimulatorList(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return []
  const start = text.indexOf('{')
  if (start < 0) return []
  let payload
  try {
    payload = JSON.parse(text.slice(start))
  } catch {
    return []
  }
  const devices = payload && typeof payload === 'object' ? payload.devices : undefined
  if (!devices || typeof devices !== 'object') return []
  const rows = []
  for (const [runtimeIdentifier, list] of Object.entries(devices)) {
    if (!Array.isArray(list)) continue
    for (const device of list) {
      if (!device || typeof device !== 'object' || typeof device.udid !== 'string') continue
      rows.push({
        udid: device.udid,
        name: typeof device.name === 'string' ? device.name : device.udid,
        state: typeof device.state === 'string' ? device.state : 'Unknown',
        isAvailable: device.isAvailable !== false,
        runtimeIdentifier,
        platform: platformForRuntime(runtimeIdentifier),
        osVersion: versionForRuntime(runtimeIdentifier),
        deviceTypeIdentifier: typeof device.deviceTypeIdentifier === 'string' ? device.deviceTypeIdentifier : undefined,
        lastBootedAt: typeof device.lastBootedAt === 'string' ? device.lastBootedAt : undefined,
      })
    }
  }
  return rows.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name))
}

/** Normalize `xcrun simctl list runtimes --json` output. */
export function parseRuntimes(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return []
  const start = text.indexOf('{')
  if (start < 0) return []
  let payload
  try {
    payload = JSON.parse(text.slice(start))
  } catch {
    return []
  }
  const runtimes = Array.isArray(payload.runtimes) ? payload.runtimes : []
  return runtimes
    .filter((runtime) => runtime && typeof runtime.identifier === 'string')
    .map((runtime) => ({
      identifier: runtime.identifier,
      name: typeof runtime.name === 'string' ? runtime.name : runtime.identifier,
      version: typeof runtime.version === 'string' ? runtime.version : versionForRuntime(runtime.identifier),
      platform: platformForRuntime(runtime.identifier),
      isAvailable: runtime.isAvailable !== false,
      supportedDeviceTypes: Array.isArray(runtime.supportedDeviceTypes)
        ? runtime.supportedDeviceTypes.map((type) => type && type.name).filter((name) => typeof name === 'string')
        : [],
    }))
}

/** Installed Xcode applications under `/Applications` and `~/Applications`. */
export async function listXcodes() {
  const roots = ['/Applications']
  if (typeof process.env.HOME === 'string' && process.env.HOME.length > 0) roots.push(join(process.env.HOME, 'Applications'))
  const found = []
  for (const root of roots) {
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^Xcode[^/]*\.app$/.test(entry.name)) continue
      const appPath = join(root, entry.name)
      try {
        await access(join(appPath, 'Contents', 'Developer', 'usr', 'bin', 'xcodebuild'))
        found.push({ name: entry.name, path: appPath })
      } catch {
        /* an incomplete or stubbed Xcode.app */
      }
    }
  }
  return found.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
}

async function tolerant(run, argv, options = {}) {
  try {
    return await run(argv, { timeoutMs: 45000, ...options })
  } catch (error) {
    return { ok: false, command: argv.join(' '), exitCode: null, stdout: '', stderr: String(error), spawnError: String(error) }
  }
}

/**
 * Collect the whole toolchain picture.
 *
 * @param {object} ctx plugin context (executable resolution).
 * @param {object} config normalized config.
 * @param {Function} runner command runner.
 * @param {object} [options] `{ signal, includeDevices }`.
 */
export async function readToolchain(ctx, config, runner, options = {}) {
  const platformError = platformProblem()
  const report = {
    tool: 'apple_dev_env',
    ok: false,
    generatedAt: nowIso(),
    platform: process.platform,
    xcodebuild: {},
    developerDir: undefined,
    xcodes: [],
    sdks: [],
    runtimes: [],
    signing: { count: 0, identities: [] },
    swift: undefined,
    warnings: [],
  }
  if (platformError) {
    report.error = platformError
    return report
  }
  const signal = options.signal
  const xcodebuildCommand = config.xcodebuild
  const xcodebuildPresent = await hasExecutable(ctx, xcodebuildCommand, { signal })
  if (!xcodebuildPresent) {
    report.error = `\`${xcodebuildCommand}\` was not found. Install Xcode and its Command Line Tools (xcode-select --install).`
    report.warnings.push(report.error)
  } else {
    try {
      report.xcodebuild.path = await resolveExecutable(ctx, xcodebuildCommand, { signal })
    } catch {
      /* optional detail */
    }
  }

  const developerDir = await tolerant(runner, ['xcode-select', '-p'], { signal })
  if (developerDir.ok && developerDir.stdout.trim()) {
    report.developerDir = developerDir.stdout.trim()
  } else if (xcodebuildPresent) {
    report.warnings.push('xcode-select -p failed; the active developer directory is unknown.')
  }

  if (xcodebuildPresent) {
    const version = await tolerant(runner, [xcodebuildCommand, '-version'], { signal })
    if (version.ok) Object.assign(report.xcodebuild, parseXcodeVersion(version.stdout))
    else report.warnings.push(`xcodebuild -version failed: ${version.stderr.trim() || version.exitCode}`)

    const sdks = await tolerant(runner, [xcodebuildCommand, '-showsdks'], { signal })
    if (sdks.ok) report.sdks = parseSdks(sdks.stdout)
    else report.warnings.push('xcodebuild -showsdks failed.')

    const runtimesResult = await tolerant(runner, ['xcrun', 'simctl', 'list', 'runtimes', '--json'], { signal })
    if (runtimesResult.ok) report.runtimes = parseRuntimes(runtimesResult.stdout)
    else report.warnings.push('Could not list simulator runtimes (full Xcode with a simulator runtime is required).')

    if (options.includeDevices) {
      const devicesResult = await tolerant(runner, ['xcrun', 'simctl', 'list', 'devices', '--json'], { signal })
      if (devicesResult.ok) report.simulators = parseSimulatorList(devicesResult.stdout)
      else report.warnings.push('Could not list simulator devices.')
    }
  }

  const swift = await tolerant(runner, ['swift', '--version'], { signal })
  if (swift.ok) {
    const first = swift.stdout.split(/\r?\n/).find((line) => line.trim().length > 0)
    report.swift = first ? first.trim() : undefined
  }

  const identities = await tolerant(runner, ['security', 'find-identity', '-v', '-p', 'codesigning'], { signal })
  if (identities.ok) {
    const parsed = parseIdentities(identities.stdout)
    report.signing = { count: parsed.count, identities: parsed.identities }
  } else {
    report.warnings.push('Could not read code-signing identities (security find-identity failed).')
  }

  report.xcodes = await listXcodes()
  report.ok = xcodebuildPresent
  if (!xcodebuildPresent && !report.error) {
    report.error = 'Xcode command line tools are not available.'
  }
  return report
}
