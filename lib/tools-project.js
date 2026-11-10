/**
 * The project/build/test agent tools of the Apple Dev bundle:
 * `apple_dev_project`, `apple_dev_build`, `apple_dev_test`.
 *
 * Everything runs through the injected `runner` (the Host `subprocess` service),
 * paths resolve against the calling session's working directory, and full build
 * output is persisted with `saveLog()` while the model only sees a capped,
 * information-dense summary. A failing build or test is a RESULT (`ok: false`),
 * never a thrown tool error.
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  DEFAULT_TEXT_CHARS,
  clip,
  errorMessage,
  formatDuration,
  indent,
  plural,
  renderText,
  tailLines,
} from './format.js'
import { MAX_TIMEOUT_MS, platformProblem, resolveUserPath, saveLog, sessionDirectory } from './runner.js'
import { listSimulators } from './simulator.js'
import {
  chooseProject,
  discoverProjects,
  extractJson,
  filterBuildSettings,
  needsSwiftDescribeTypeJson,
  parseSwiftDescribe,
  parseXcodebuildList,
  parseXcodebuildListText,
  withSwiftDescribeTypeJson,
} from './project.js'
import {
  buildDestination,
  needsSwiftSandboxFallback,
  normalizePlatform,
  parseBuildOutput,
  pickDefaultSimulator,
  simulatorDestination,
  simulatorPlatformLabel,
  swiftSandboxFallbackArgv,
} from './build.js'
import { parseTestOutput } from './test.js'

const PROJECT_ACTIONS = ['list', 'info', 'build_settings']
const PROJECT_KINDS = ['workspace', 'project', 'package']
/** Leave headroom below the Host command deadline so the runner reports a timeout. */
const EFFECTIVE_MAX_TIMEOUT_MS = MAX_TIMEOUT_MS - 60_000
const TOOL_TIMEOUT_BASE_MS = 60_000
const MAX_TOOL_TIMEOUT_MS = 3_900_000
const MAX_SWIFT_FALLBACKS = 3

/* ------------------------------------------------------------------------- *
 * Argument handling
 * ------------------------------------------------------------------------- */

function objectArgs(args) {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {}
}

function optionalString(input, key) {
  const value = input[key]
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`\`${key}\` must be a string.`)
  return value.trim()
}

function optionalStringArray(input, key, maxItems = 50) {
  const value = input[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`\`${key}\` must be an array of strings.`)
  const items = value.map((item) => {
    if (typeof item !== 'string') throw new Error(`\`${key}\` must be an array of strings.`)
    return item.trim()
  })
  return items.filter((item) => item.length > 0).slice(0, maxItems)
}

function optionalInteger(input, key, fallback, minimum, maximum) {
  const value = input[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`\`${key}\` must be an integer.`)
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)))
}

function commandTimeout(input, config) {
  const requested = input.timeout_ms
  let value = config.timeoutMs
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== 'number' || !Number.isFinite(requested)) {
      throw new Error('`timeout_ms` must be a number of milliseconds.')
    }
    value = requested
  }
  return Math.min(EFFECTIVE_MAX_TIMEOUT_MS, Math.max(1_000, Math.trunc(value)))
}

function toolTimeout(config) {
  return Math.min(MAX_TOOL_TIMEOUT_MS, config.timeoutMs + TOOL_TIMEOUT_BASE_MS)
}

/**
 * Invoke the runner defensively: an unavailable Host subprocess service becomes
 * a readable failure result instead of a thrown tool error.
 */
async function runCommand(runner, argv, options) {
  try {
    return await runner(argv, options)
  } catch (error) {
    return {
      ok: false,
      command: argv.join(' '),
      argv,
      cwd: options ? options.cwd : undefined,
      label: options ? options.label : undefined,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      spawnError: errorMessage(error),
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      truncated: false,
      durationMs: 0,
    }
  }
}

function combinedOutput(result) {
  if (!result) return ''
  return [result.stdout, result.stderr].filter((part) => typeof part === 'string' && part.trim().length > 0).join('\n')
}

/** Last lines of a failing command, for the `error` field. */
function commandErrorText(result, lineCount = 20) {
  const text = combinedOutput(result).trim()
  if (text.length === 0) return `exit ${result.exitCode}`
  return tailLines(text, lineCount)
}

function formatDiagnostic(entry) {
  if (!entry || typeof entry !== 'object') return 'unknown error'
  const location = entry.file
    ? `${entry.file}${entry.line ? `:${entry.line}` : ''}${entry.column ? `:${entry.column}` : ''}: `
    : ''
  return `${location}${entry.message || 'unknown error'}`
}

function formatTestFailure(entry) {
  const name = [entry.suite, entry.name].filter(Boolean).join('.')
  const location = entry.file ? `${entry.file}${entry.line ? `:${entry.line}` : ''}: ` : ''
  return `${location}${name || 'unknown test'}${entry.message ? `: ${entry.message}` : ''}`
}

function platformFailure(tool, action, error) {
  return { tool, ok: false, ...(action ? { action } : {}), error, summary: error }
}

/* ------------------------------------------------------------------------- *
 * Discovery / inspection helpers
 * ------------------------------------------------------------------------- */

async function discoverAt(cwd, requestedPath) {
  const absolute = resolveUserPath(cwd, requestedPath)
  const discovery = await discoverProjects(absolute, { maxDepth: requestedPath ? 4 : 3 })
  return discovery
}

async function chooseTarget(cwd, requestedPath, kind) {
  const discovery = await discoverAt(cwd, requestedPath)
  return { discovery, choice: chooseProject(discovery.entries, { kind }) }
}

function targetArguments(entry) {
  return entry.kind === 'workspace' ? ['-workspace', entry.path] : ['-project', entry.path]
}

async function loadXcodeList(runner, config, entry, options = {}) {
  const argv = [config.xcodebuild, '-list', '-json', ...targetArguments(entry)]
  const result = await runCommand(runner, argv, {
    cwd: dirname(entry.path),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    label: 'xcodebuild -list',
  })
  const text = combinedOutput(result)
  const info = parseXcodebuildList(text) || parseXcodebuildListText(text)
  if (!info) {
    return {
      ok: false,
      command: result.command,
      exitCode: result.exitCode,
      error: commandErrorText(result) || `xcodebuild -list exited ${result.exitCode}`,
      result,
    }
  }
  return { ok: true, info, command: result.command, durationMs: result.durationMs, result }
}

async function loadBuildSettings(runner, config, entry, options = {}) {
  const argv = [config.xcodebuild, '-showBuildSettings', '-json', ...targetArguments(entry)]
  if (options.scheme) argv.push('-scheme', options.scheme)
  if (options.configuration) argv.push('-configuration', options.configuration)
  const result = await runCommand(runner, argv, {
    cwd: dirname(entry.path),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    label: 'xcodebuild -showBuildSettings',
  })
  const text = combinedOutput(result)
  const payload = extractJson(text)
  const filtered = payload === undefined ? undefined : filterBuildSettings(payload)
  if (!filtered || filtered.count === 0) {
    return {
      ok: false,
      command: result.command,
      exitCode: result.exitCode,
      error: commandErrorText(result) || `xcodebuild -showBuildSettings exited ${result.exitCode}`,
      result,
    }
  }
  return { ok: true, ...filtered, command: result.command, durationMs: result.durationMs, result }
}

/**
 * Run a `swift`/`xcrun swift` command, retrying with the documented fallbacks:
 * older/newer SwiftPM spell only one of `--json` and `--type json`, and the
 * nested SwiftPM sandbox cannot be applied when the Harness host already
 * sandboxes the process.
 *
 * @returns {Promise<{ result: object, attempts: number }>}
 */
async function runSwiftWithFallbacks(runner, baseArgv, options) {
  const tried = new Set()
  let argv = baseArgv
  let result
  for (let step = 0; step < MAX_SWIFT_FALLBACKS; step += 1) {
    tried.add(argv.join('\n'))
    result = await runCommand(runner, argv, options)
    if (result.ok || result.timedOut || result.cancelled) break
    const output = combinedOutput(result)
    const needsTypeJson = needsSwiftDescribeTypeJson(output) && !argv.includes('--type')
    const needsSandbox = needsSwiftSandboxFallback(output) && !argv.includes('--disable-sandbox')
    if (!needsTypeJson && !needsSandbox) break
    let next = argv
    if (needsTypeJson) next = withSwiftDescribeTypeJson(next)
    if (needsSandbox) next = swiftSandboxFallbackArgv(next)
    if (tried.has(next.join('\n'))) break
    argv = next
  }
  return { result, used: tried.size }
}

function swiftDescribeArgv(entry) {
  return ['xcrun', 'swift', 'package', '--package-path', entry.path, 'describe', '--json']
}

async function describeSwiftPackage(runner, config, entry, options = {}) {
  const { result, used } = await runSwiftWithFallbacks(runner, swiftDescribeArgv(entry), {
    cwd: entry.path,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    label: 'swift package describe',
  })
  const text = combinedOutput(result)
  const info = parseSwiftDescribe(text)
  if (!info) {
    return {
      ok: false,
      command: result.command,
      exitCode: result.exitCode,
      error: commandErrorText(result) || `swift package describe exited ${result.exitCode}`,
      result,
      attempts: used,
    }
  }
  return {
    ok: true,
    info,
    command: result.command,
    durationMs: result.durationMs,
    attempts: used,
    sandboxFallback: Array.isArray(result.argv) && result.argv.includes('--disable-sandbox'),
    result,
  }
}

/** True when SwiftPM needed its nested sandbox disabled to run at all. */
function usedSandboxFallback(result) {
  return Boolean(result && Array.isArray(result.argv) && result.argv.includes('--disable-sandbox'))
}

async function loadSimulatorDevices(runner, signal) {
  let listed
  try {
    listed = await listSimulators(runner, { signal })
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
  if (!listed.ok) {
    return { ok: false, error: listed.error || 'Could not list simulator devices.' }
  }
  return { ok: true, devices: listed.devices }
}

async function swiftCommand(runner, entry, baseArgv, options = {}) {
  const { result, used } = await runSwiftWithFallbacks(runner, baseArgv, {
    cwd: entry.path,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    label: options.label,
  })
  return { result, attempts: used }
}

/* ------------------------------------------------------------------------- *
 * apple_dev_project
 * ------------------------------------------------------------------------- */

async function executeProject(ctx, config, runner, args, exec) {
  const input = objectArgs(args)
  const action = typeof input.action === 'string' ? input.action.trim() : ''
  if (!PROJECT_ACTIONS.includes(action)) {
    throw new Error('`action` must be one of: list, info, build_settings.')
  }
  const blocked = platformProblem()
  if (blocked) return platformFailure('apple_dev_project', action, blocked)

  const cwd = sessionDirectory(ctx, exec)
  const signal = exec ? exec.signal : undefined
  const requestedPath = optionalString(input, 'path')
  const requestedKind = optionalString(input, 'kind')
  if (requestedKind.length > 0 && !PROJECT_KINDS.includes(requestedKind)) {
    throw new Error('`kind` must be one of: workspace, project, package.')
  }
  const timeoutMs = Math.min(commandTimeout(input, config), 300_000)
  const scheme = optionalString(input, 'scheme')
  const configuration = optionalString(input, 'configuration')

  if (action === 'list') {
    const depth = optionalInteger(input, 'depth', 3, 1, 10)
    const discovery = await discoverProjects(resolveUserPath(cwd, requestedPath), { maxDepth: depth, signal })
    return {
      tool: 'apple_dev_project',
      ok: true,
      action: 'list',
      root: discovery.root,
      depth: discovery.maxDepth,
      count: discovery.count,
      truncated: discovery.truncated,
      entries: discovery.entries,
    }
  }

  const { discovery, choice } = await chooseTarget(cwd, requestedPath, requestedKind || undefined)
  if (choice.error) {
    return {
      tool: 'apple_dev_project',
      ok: false,
      action,
      root: discovery.root,
      error: choice.error,
      candidates: discovery.entries,
    }
  }
  const entry = choice.entry

  if (action === 'info') {
    if (entry.kind === 'package') {
      const described = await describeSwiftPackage(runner, config, entry, { signal, timeoutMs })
      if (!described.ok) {
        return {
          tool: 'apple_dev_project',
          ok: false,
          action,
          kind: 'package',
          project: entry.path,
          error: described.error,
          command: described.command,
        }
      }
      return {
        tool: 'apple_dev_project',
        ok: true,
        action,
        kind: 'package',
        project: entry.path,
        name: described.info.name,
        targets: described.info.targets,
        products: described.info.products,
        platforms: described.info.platforms,
        dependencies: described.info.dependencies,
        command: described.command,
        durationMs: described.durationMs,
        notes: [
          choice.note,
          usedSandboxFallback(described.result)
            ? 'SwiftPM could not apply its nested sandbox here; retried with --disable-sandbox.'
            : undefined,
        ].filter(Boolean),
      }
    }
    const listed = await loadXcodeList(runner, config, entry, { signal, timeoutMs })
    if (!listed.ok) {
      return {
        tool: 'apple_dev_project',
        ok: false,
        action,
        kind: entry.kind,
        project: entry.path,
        error: listed.error,
        command: listed.command,
      }
    }
    return {
      tool: 'apple_dev_project',
      ok: true,
      action,
      kind: entry.kind,
      project: entry.path,
      name: listed.info.name || entry.name,
      schemes: listed.info.schemes,
      targets: listed.info.targets,
      configurations: listed.info.configurations,
      command: listed.command,
      durationMs: listed.durationMs,
      notes: [choice.note].filter(Boolean),
    }
  }

  // build_settings
  if (entry.kind === 'package') {
    return {
      tool: 'apple_dev_project',
      ok: false,
      action,
      kind: 'package',
      project: entry.path,
      error: '`build_settings` needs an Xcode project or workspace; use action "info" for Swift packages.',
    }
  }
  const settings = await loadBuildSettings(runner, config, entry, { signal, timeoutMs, scheme, configuration })
  if (!settings.ok) {
    return {
      tool: 'apple_dev_project',
      ok: false,
      action,
      kind: entry.kind,
      project: entry.path,
      scheme: scheme || undefined,
      configuration: configuration || undefined,
      error: settings.error,
      command: settings.command,
    }
  }
  return {
    tool: 'apple_dev_project',
    ok: true,
    action,
    kind: entry.kind,
    project: entry.path,
    scheme: scheme || undefined,
    configuration: configuration || undefined,
    targetCount: settings.count,
    targets: settings.targets,
    settings: settings.settings,
    command: settings.command,
    durationMs: settings.durationMs,
    notes: [choice.note].filter(Boolean),
  }
}

/* ------------------------------------------------------------------------- *
 * apple_dev_build
 * ------------------------------------------------------------------------- */

async function executeBuild(ctx, config, runner, args, exec) {
  const input = objectArgs(args)
  const blocked = platformProblem()
  if (blocked) return platformFailure('apple_dev_build', 'build', blocked)

  const cwd = sessionDirectory(ctx, exec)
  const signal = exec ? exec.signal : undefined
  const requestedPath = optionalString(input, 'path')
  const scheme = optionalString(input, 'scheme')
  const configuration = optionalString(input, 'configuration') || 'Debug'
  const destinationInput = optionalString(input, 'destination')
  const platform = optionalString(input, 'platform')
  const device = optionalString(input, 'device')
  const os = optionalString(input, 'os')
  const derivedDataInput = optionalString(input, 'derived_data_path')
  const extraArgs = optionalStringArray(input, 'extra_args')
  const timeoutMs = commandTimeout(input, config)
  const destinationWanted = Boolean(destinationInput || platform || device || os)

  const { discovery, choice } = await chooseTarget(cwd, requestedPath)
  if (choice.error) {
    return {
      tool: 'apple_dev_build',
      ok: false,
      action: 'build',
      root: discovery.root,
      error: choice.error,
      candidates: discovery.entries,
    }
  }
  const entry = choice.entry
  const notes = [choice.note]

  if (entry.kind === 'package') {
    const argv = ['xcrun', 'swift', 'build', '--package-path', entry.path, '-c', configuration.toLowerCase()]
    if (scheme) {
      argv.push('--product', scheme)
      notes.push(`\`scheme\` was interpreted as \`--product ${scheme}\` for the Swift package.`)
    }
    if (destinationWanted) notes.push('`destination`/`platform`/`device`/`os` are ignored for Swift packages.')
    argv.push(...extraArgs)
    const outcome = await swiftCommand(runner, entry, argv, { signal, timeoutMs, label: 'swift build' })
    return finalizeBuild(config, cwd, entry, outcome.result, {
      scheme: scheme || undefined,
      configuration,
      destination: undefined,
      notes,
    })
  }

  let destination
  if (destinationWanted) {
    let devices = []
    if (device) {
      const listed = await loadSimulatorDevices(runner, signal)
      if (!listed.ok) {
        return { tool: 'apple_dev_build', ok: false, action: 'build', project: entry.path, error: listed.error }
      }
      devices = listed.devices
    }
    destination = buildDestination(devices, { destination: destinationInput, platform, device, os })
    if (!destination.ok) {
      return {
        tool: 'apple_dev_build',
        ok: false,
        action: 'build',
        project: entry.path,
        error: destination.error || 'Could not resolve a build destination.',
        candidates: destination.candidates,
      }
    }
    if (destination.note) notes.push(destination.note)
  }

  const derivedDataPath = derivedDataInput
    ? resolveUserPath(cwd, derivedDataInput)
    : config.derivedDataPath
      ? resolveUserPath(cwd, config.derivedDataPath)
      : ''
  const argv = [config.xcodebuild, ...targetArguments(entry)]
  if (scheme) argv.push('-scheme', scheme)
  argv.push('-configuration', configuration)
  if (destination && destination.destination) argv.push('-destination', destination.destination)
  if (derivedDataPath) argv.push('-derivedDataPath', derivedDataPath)
  argv.push('build', ...extraArgs)

  const result = await runCommand(runner, argv, {
    cwd: dirname(entry.path),
    signal,
    timeoutMs,
    label: `${config.xcodebuild} build`,
  })
  return finalizeBuild(config, cwd, entry, result, {
    scheme: scheme || undefined,
    configuration,
    destination: destination && destination.destination,
    destinationDevice: destination && destination.device,
    notes,
  })
}

async function finalizeBuild(config, cwd, entry, result, options) {
  const combined = combinedOutput(result)
  const parsed = parseBuildOutput(combined)
  const logPath = await saveLog(cwd, config.logDirectory, 'build', result)
  const buildResult = parsed.result === 'unknown' ? (result.ok ? 'succeeded' : 'failed') : parsed.result
  const ok = result.ok && parsed.result !== 'failed'
  const warnings = parsed.warningCount > 0 ? `, ${plural(parsed.warningCount, 'warning')}` : ''
  let summary
  if (result.spawnError) summary = `Could not start the build: ${result.spawnError}`
  else if (result.timedOut) summary = `Build timed out after ${formatDuration(result.durationMs)}.`
  else if (result.cancelled) summary = 'Build was cancelled.'
  else if (ok) summary = `Build succeeded in ${formatDuration(result.durationMs)}${warnings}.`
  else {
    const errorCount = parsed.errorCount > 0 ? plural(parsed.errorCount, 'error') : `exit ${result.exitCode}`
    summary = `Build failed in ${formatDuration(result.durationMs)} with ${errorCount}${warnings}.`
  }

  const failureText = result.spawnError
    ? result.spawnError
    : result.timedOut
      ? 'Command timed out.'
      : result.cancelled
        ? 'Command was cancelled.'
        : parsed.errors.length > 0
          ? formatDiagnostic(parsed.errors[0])
          : commandErrorText(result)

  const value = {
    tool: 'apple_dev_build',
    ok,
    action: 'build',
    kind: entry.kind === 'package' ? 'package' : 'xcode',
    project: entry.path,
    scheme: options.scheme,
    configuration: options.configuration,
    destination: options.destination,
    destinationDevice: options.destinationDevice,
    exitCode: result.exitCode,
    timedOut: Boolean(result.timedOut),
    cancelled: Boolean(result.cancelled),
    spawnError: result.spawnError,
    durationMs: result.durationMs,
    result: buildResult,
    summary,
    errors: parsed.errors,
    errorCount: parsed.errorCount,
    errorsTruncated: parsed.errorsTruncated,
    warningCount: parsed.warningCount,
    failedCommands: parsed.failedCommands,
    logPath,
    command: result.command,
    outputTail: tailLines(combined, 60),
    notes: (options.notes || []).filter(Boolean),
    sandboxFallback: usedSandboxFallback(result),
  }
  if (value.sandboxFallback) {
    value.notes.push('SwiftPM could not apply its nested sandbox here; retried with --disable-sandbox.')
  }
  if (!ok) value.error = failureText
  return value
}

/* ------------------------------------------------------------------------- *
 * apple_dev_test
 * ------------------------------------------------------------------------- */

async function resolveTestScheme(runner, config, entry, requestedScheme, options) {
  if (entry.kind === 'package') return { scheme: undefined }
  if (requestedScheme) return { scheme: requestedScheme }
  const listed = await loadXcodeList(runner, config, entry, options)
  if (!listed.ok) return { error: listed.error }
  const schemes = listed.info.schemes
  if (schemes.length === 1) return { scheme: schemes[0], note: `Scheme auto-selected: ${schemes[0]}.` }
  if (schemes.length === 0) {
    return { error: `No schemes were found in ${entry.path}; pass \`scheme\`.` }
  }
  return {
    error: `Several schemes exist (${schemes.join(', ')}); pass \`scheme\` to choose one.`,
    schemes,
  }
}

async function executeTest(ctx, config, runner, args, exec) {
  const input = objectArgs(args)
  const blocked = platformProblem()
  if (blocked) return platformFailure('apple_dev_test', 'test', blocked)

  const cwd = sessionDirectory(ctx, exec)
  const signal = exec ? exec.signal : undefined
  const requestedPath = optionalString(input, 'path')
  const schemeInput = optionalString(input, 'scheme')
  const configuration = optionalString(input, 'configuration') || 'Debug'
  const destinationInput = optionalString(input, 'destination')
  const platform = optionalString(input, 'platform')
  const device = optionalString(input, 'device')
  const os = optionalString(input, 'os')
  const onlyTesting = optionalStringArray(input, 'only_testing')
  const resultBundleInput = optionalString(input, 'result_bundle_path')
  const derivedDataInput = optionalString(input, 'derived_data_path')
  const extraArgs = optionalStringArray(input, 'extra_args')
  const timeoutMs = commandTimeout(input, config)

  const { discovery, choice } = await chooseTarget(cwd, requestedPath)
  if (choice.error) {
    return {
      tool: 'apple_dev_test',
      ok: false,
      action: 'test',
      root: discovery.root,
      error: choice.error,
      candidates: discovery.entries,
    }
  }
  const entry = choice.entry
  const notes = [choice.note]

  if (entry.kind === 'package') {
    if (destinationInput || platform || device || os) notes.push('`destination`/`platform`/`device`/`os` are ignored for Swift packages.')
    if (onlyTesting.length > 0) notes.push('`only_testing` is ignored for Swift packages (`swift test --filter` uses test-name regexes).')
    if (resultBundleInput) notes.push('`result_bundle_path` is ignored for Swift packages.')
    const argv = ['xcrun', 'swift', 'test', '--package-path', entry.path, '-c', configuration.toLowerCase(), ...extraArgs]
    const outcome = await swiftCommand(runner, entry, argv, { signal, timeoutMs, label: 'swift test' })
    return finalizeTest(config, cwd, entry, outcome.result, {
      scheme: schemeInput || undefined,
      configuration,
      destination: undefined,
      onlyTesting: [],
      resultBundlePath: undefined,
      notes,
    })
  }

  const schemeResolution = await resolveTestScheme(runner, config, entry, schemeInput, { signal, timeoutMs })
  if (schemeResolution.error) {
    return {
      tool: 'apple_dev_test',
      ok: false,
      action: 'test',
      project: entry.path,
      error: schemeResolution.error,
      candidates: schemeResolution.schemes,
    }
  }
  const scheme = schemeResolution.scheme
  if (schemeResolution.note) notes.push(schemeResolution.note)

  let destination
  const platformInfo = normalizePlatform(platform)
  if (platform.length > 0 && !platformInfo) {
    return {
      tool: 'apple_dev_test',
      ok: false,
      action: 'test',
      project: entry.path,
      error: `Unknown platform "${platform}". Use iOS, tvOS, watchOS, visionOS, macOS, or "... device" for a physical device.`,
    }
  }
  if (destinationInput) {
    destination = { ok: true, destination: destinationInput, explicit: true }
  } else if (platformInfo && platformInfo.kind === 'macos' && !device) {
    destination = buildDestination([], { platform, os })
    if (!destination.ok) {
      return {
        tool: 'apple_dev_test',
        ok: false,
        action: 'test',
        project: entry.path,
        error: destination.error,
      }
    }
  } else {
    const listed = await loadSimulatorDevices(runner, signal)
    const devices = listed.ok ? listed.devices : []
    if (!listed.ok && (platform || device || os)) {
      return { tool: 'apple_dev_test', ok: false, action: 'test', project: entry.path, error: listed.error }
    }
    if (device) {
      destination = buildDestination(devices, { platform, device, os })
      if (!destination.ok) {
        return {
          tool: 'apple_dev_test',
          ok: false,
          action: 'test',
          project: entry.path,
          error: destination.error || 'Could not resolve a test destination.',
          candidates: destination.candidates,
        }
      }
    } else if (platformInfo && platformInfo.kind === 'device') {
      return {
        tool: 'apple_dev_test',
        ok: false,
        action: 'test',
        project: entry.path,
        error: `Testing on a physical ${platformInfo.family} device needs \`device\` or a full \`destination\`.`,
      }
    } else {
      const autoWanted = Boolean(platform || os) || devices.length > 0
      if (autoWanted) {
        const picked = pickDefaultSimulator(devices, { platform })
        if (picked) {
          destination = {
            ok: true,
            destination: simulatorDestination(picked, { os }),
            device: {
              name: picked.name,
              udid: picked.udid,
              platform: picked.platform,
              osVersion: picked.osVersion,
              state: picked.state,
            },
            platform: simulatorPlatformLabel(picked.platform),
          }
          notes.push(`Simulator auto-selected: ${picked.name} (${picked.platform} ${picked.osVersion || 'unknown'}).`)
        } else if (platform) {
          return {
            tool: 'apple_dev_test',
            ok: false,
            action: 'test',
            project: entry.path,
            error: `No ${platformInfo ? platformInfo.label : platform} simulator is available; pass \`device\` or a full \`destination\`.`,
          }
        } else {
          notes.push('No simulator is available; running without an explicit destination.')
        }
      } else if (!listed.ok) {
        notes.push('Could not list simulators; running without an explicit destination.')
      } else {
        notes.push('No simulators are available; running without an explicit destination.')
      }
    }
  }
  if (destination && destination.note) notes.push(destination.note)

  const resultBundlePath = resultBundleInput ? resolveUserPath(cwd, resultBundleInput) : ''
  if (resultBundlePath) {
    try {
      await mkdir(dirname(resultBundlePath), { recursive: true })
    } catch {
      /* xcodebuild reports the actionable error below */
    }
  }
  const derivedDataPath = derivedDataInput
    ? resolveUserPath(cwd, derivedDataInput)
    : config.derivedDataPath
      ? resolveUserPath(cwd, config.derivedDataPath)
      : ''
  const argv = [config.xcodebuild, ...targetArguments(entry)]
  if (scheme) argv.push('-scheme', scheme)
  argv.push('-configuration', configuration)
  if (destination && destination.destination) argv.push('-destination', destination.destination)
  if (derivedDataPath) argv.push('-derivedDataPath', derivedDataPath)
  for (const identifier of onlyTesting) argv.push(`-only-testing:${identifier}`)
  if (resultBundlePath) argv.push('-resultBundlePath', resultBundlePath)
  argv.push('test', ...extraArgs)

  const result = await runCommand(runner, argv, {
    cwd: dirname(entry.path),
    signal,
    timeoutMs,
    label: `${config.xcodebuild} test`,
  })
  return finalizeTest(config, cwd, entry, result, {
    scheme,
    configuration,
    destination: destination && destination.destination,
    destinationDevice: destination && destination.device,
    onlyTesting,
    resultBundlePath: resultBundlePath || undefined,
    notes,
  })
}

async function finalizeTest(config, cwd, entry, result, options) {
  const combined = combinedOutput(result)
  const parsed = parseTestOutput(combined)
  const logPath = await saveLog(cwd, config.logDirectory, 'test', result)
  const testResult = parsed.result === 'unknown' ? (result.ok ? 'passed' : 'failed') : parsed.result
  const ok = result.ok && parsed.result !== 'failed'
  const executed = parsed.executed
  const failures = parsed.failureCount !== undefined ? parsed.failureCount : parsed.caseCounts.failed
  const counts =
    executed !== undefined
      ? `${plural(executed, 'test')}, ${Number.isFinite(failures) ? plural(failures, 'failure') : 'failure count unknown'}`
      : parsed.caseCounts.passed + parsed.caseCounts.failed > 0
        ? `${plural(parsed.caseCounts.passed, 'passing test')}, ${plural(parsed.caseCounts.failed, 'failing test')}`
        : 'unknown test count'
  let summary
  if (result.spawnError) summary = `Could not start the tests: ${result.spawnError}`
  else if (result.timedOut) summary = `Tests timed out after ${formatDuration(result.durationMs)}.`
  else if (result.cancelled) summary = 'Test run was cancelled.'
  else if (ok) summary = `Tests passed in ${formatDuration(result.durationMs)} (${counts}).`
  else summary = `Tests failed in ${formatDuration(result.durationMs)} (${counts}).`

  const failureText = result.spawnError
    ? result.spawnError
    : result.timedOut
      ? 'Command timed out.'
      : result.cancelled
        ? 'Command was cancelled.'
        : parsed.failingTests.length > 0
          ? formatTestFailure(parsed.failingTests[0])
          : parsed.errors.length > 0
            ? formatDiagnostic(parsed.errors[0])
            : commandErrorText(result)

  const value = {
    tool: 'apple_dev_test',
    ok,
    action: 'test',
    kind: entry.kind === 'package' ? 'package' : 'xcode',
    project: entry.path,
    scheme: options.scheme,
    configuration: options.configuration,
    destination: options.destination,
    destinationDevice: options.destinationDevice,
    exitCode: result.exitCode,
    timedOut: Boolean(result.timedOut),
    cancelled: Boolean(result.cancelled),
    spawnError: result.spawnError,
    durationMs: result.durationMs,
    result: testResult,
    passed: testResult === 'passed' ? true : testResult === 'failed' ? false : undefined,
    summary,
    executed: parsed.executed,
    failureCount: parsed.failureCount,
    unexpectedFailures: parsed.unexpectedFailures,
    caseCounts: parsed.caseCounts,
    failingTests: parsed.failingTests,
    failingTestCount: parsed.failingTestCount,
    errors: parsed.errors,
    errorCount: parsed.errorCount,
    onlyTesting: options.onlyTesting,
    resultBundlePath: options.resultBundlePath,
    logPath,
    command: result.command,
    outputTail: tailLines(combined, 60),
    notes: (options.notes || []).filter(Boolean),
    sandboxFallback: usedSandboxFallback(result),
  }
  if (value.sandboxFallback) {
    value.notes.push('SwiftPM could not apply its nested sandbox here; retried with --disable-sandbox.')
  }
  if (!ok) value.error = failureText
  return value
}

/* ------------------------------------------------------------------------- *
 * Renders
 * ------------------------------------------------------------------------- */

function projectListText(value) {
  const result = value && typeof value === 'object' ? value : {}
  if (result.ok === false) return `Project discovery failed: ${result.error || 'unknown error'}`
  const lines = [`Apple project discovery under ${result.root}`]
  const entries = Array.isArray(result.entries) ? result.entries : []
  if (entries.length === 0) {
    lines.push('- no .xcodeproj, .xcworkspace or Package.swift found')
    lines.push('')
    lines.push('Next: pass `path` to a project directory, or search a shallower/deeper `depth`.')
    return lines.join('\n')
  }
  for (const entry of entries) {
    lines.push(`- ${String(entry.kind).padEnd(9)} ${entry.name}  ${entry.path}`)
  }
  lines.push('')
  lines.push(
    `${plural(result.count, 'candidate')}${result.truncated ? ' (truncated)' : ''}, searched to depth ${result.depth}.`,
  )
  return lines.join('\n')
}

function projectInfoText(value) {
  const result = value && typeof value === 'object' ? value : {}
  if (result.ok === false) return `Project inspection failed: ${result.error || 'unknown error'}`
  if (result.kind === 'package') {
    const targets = Array.isArray(result.targets) ? result.targets : []
    const products = Array.isArray(result.products) ? result.products : []
    const lines = [`Swift package: ${result.name || result.project}`]
    lines.push(`Path: ${result.project}`)
    lines.push(`Targets (${targets.length}):`)
    if (targets.length === 0) lines.push('  - none reported')
    for (const target of targets.slice(0, 30)) {
      const detail = [target.type, target.moduleType].filter(Boolean).join(', ')
      lines.push(`  - ${target.name || '(unnamed)'}${detail ? ` (${detail})` : ''}`)
    }
    lines.push(`Products (${products.length}):`)
    if (products.length === 0) lines.push('  - none reported')
    for (const product of products.slice(0, 20)) {
      const targetsText = Array.isArray(product.targets) && product.targets.length > 0 ? ` -> ${product.targets.join(', ')}` : ''
      lines.push(`  - ${product.name || '(unnamed)'} [${product.type}]${targetsText}`)
    }
    if (Array.isArray(result.platforms) && result.platforms.length > 0) {
      lines.push(
        `Platforms: ${result.platforms
          .map((platform) => [platform.name, platform.version].filter(Boolean).join(' '))
          .join(', ')}`,
      )
    }
    if (Array.isArray(result.dependencies) && result.dependencies.length > 0) {
      lines.push(`Dependencies: ${result.dependencies.join(', ')}`)
    }
    if (result.command) lines.push(`Command: ${result.command}`)
    for (const note of result.notes || []) lines.push(`Note: ${note}`)
    return lines.join('\n')
  }
  const lines = [`${result.kind === 'workspace' ? 'Xcode workspace' : 'Xcode project'}: ${result.name || result.project}`]
  lines.push(`Path: ${result.project}`)
  lines.push(`Schemes (${(result.schemes || []).length}): ${(result.schemes || []).join(', ') || 'none'}`)
  lines.push(`Targets (${(result.targets || []).length}): ${(result.targets || []).join(', ') || 'none'}`)
  lines.push(`Configurations: ${(result.configurations || []).join(', ') || 'none'}`)
  if (result.command) lines.push(`Command: ${result.command}`)
  for (const note of result.notes || []) lines.push(`Note: ${note}`)
  return lines.join('\n')
}

function buildSettingsText(value) {
  const result = value && typeof value === 'object' ? value : {}
  if (result.ok === false) return `Build settings failed: ${result.error || 'unknown error'}`
  const lines = [`Build settings for ${result.project}`]
  if (result.scheme) lines.push(`Scheme: ${result.scheme}`)
  if (result.configuration) lines.push(`Configuration: ${result.configuration}`)
  for (const target of (Array.isArray(result.targets) ? result.targets : []).slice(0, 8)) {
    lines.push('')
    lines.push(`Target ${target.target}:`)
    const settings = target.settings || {}
    const keys = Object.keys(settings)
    if (keys.length === 0) lines.push('  (none of the selected keys are set)')
    for (const key of keys) {
      const raw = settings[key]
      const text = Array.isArray(raw) ? raw.join(' ') : String(raw)
      lines.push(`  ${key} = ${text}`)
    }
  }
  if (result.command) {
    lines.push('')
    lines.push(`Command: ${result.command}`)
  }
  for (const note of result.notes || []) lines.push(`Note: ${note}`)
  return lines.join('\n')
}

function buildText(value) {
  const result = value && typeof value === 'object' ? value : {}
  const lines = [result.summary || (result.ok ? 'Build finished.' : 'Build failed.')]
  if (result.project) lines.push(`Project: ${result.project}`)
  if (result.scheme) lines.push(`Scheme: ${result.scheme}`)
  if (result.configuration) lines.push(`Configuration: ${result.configuration}`)
  if (result.destination) lines.push(`Destination: ${result.destination}`)
  if (result.command) lines.push(`Command: ${result.command}`)
  if (result.errorCount > 0) {
    lines.push(`Errors (${result.errorCount}):`)
    for (const error of (result.errors || []).slice(0, 15)) lines.push(`  - ${formatDiagnostic(error)}`)
    if (result.errorsTruncated) lines.push(`  - … ${result.errorCount - (result.errors || []).length} more errors in the log`)
  } else if (!result.ok && result.error) {
    lines.push(`Error: ${result.error}`)
  }
  if (result.warningCount > 0) lines.push(`Warnings: ${result.warningCount}`)
  if (Array.isArray(result.failedCommands) && result.failedCommands.length > 0) {
    lines.push('Failed steps:')
    for (const step of result.failedCommands.slice(0, 5)) lines.push(`  - ${step}`)
  }
  if (result.logPath) lines.push(`Log: ${result.logPath}`)
  for (const note of result.notes || []) lines.push(`Note: ${note}`)
  const tail = typeof result.outputTail === 'string' ? result.outputTail.trim() : ''
  if (tail.length > 0) {
    lines.push('')
    lines.push('Output tail:')
    lines.push(indent(clip(tailLines(tail, 30), 6000), '  '))
  }
  return clip(lines.join('\n'), DEFAULT_TEXT_CHARS)
}

function testText(value) {
  const result = value && typeof value === 'object' ? value : {}
  const lines = [result.summary || (result.ok ? 'Tests finished.' : 'Tests failed.')]
  if (result.project) lines.push(`Project: ${result.project}`)
  if (result.scheme) lines.push(`Scheme: ${result.scheme}`)
  if (result.configuration) lines.push(`Configuration: ${result.configuration}`)
  if (result.destination) lines.push(`Destination: ${result.destination}`)
  if (result.command) lines.push(`Command: ${result.command}`)
  const failing = Array.isArray(result.failingTests) ? result.failingTests : []
  if (failing.length > 0) {
    lines.push(`Failing tests (${result.failingTestCount || failing.length}):`)
    for (const failure of failing.slice(0, 20)) lines.push(`  - ${formatTestFailure(failure)}`)
    if (result.failingTestCount > failing.length) {
      lines.push(`  - … ${result.failingTestCount - failing.length} more in the log`)
    }
  } else if (!result.ok && result.error) {
    lines.push(`Error: ${result.error}`)
  }
  if (result.errorCount > 0 && failing.length === 0) {
    lines.push(`Errors (${result.errorCount}):`)
    for (const error of (result.errors || []).slice(0, 10)) lines.push(`  - ${formatDiagnostic(error)}`)
  }
  if (result.resultBundlePath) lines.push(`Result bundle: ${result.resultBundlePath}`)
  if (result.logPath) lines.push(`Log: ${result.logPath}`)
  for (const note of result.notes || []) lines.push(`Note: ${note}`)
  const tail = typeof result.outputTail === 'string' ? result.outputTail.trim() : ''
  if (tail.length > 0) {
    lines.push('')
    lines.push('Output tail:')
    lines.push(indent(clip(tailLines(tail, 30), 6000), '  '))
  }
  return clip(lines.join('\n'), DEFAULT_TEXT_CHARS)
}

function presentBuildCall(args) {
  const input = objectArgs(args)
  const scheme = typeof input.scheme === 'string' && input.scheme.length > 0 ? input.scheme : 'project'
  const configuration = typeof input.configuration === 'string' && input.configuration.length > 0 ? input.configuration : 'Debug'
  return {
    card: 'terminal',
    title: `xcodebuild build — ${scheme} (${configuration})`,
    description: 'Build an Xcode project/workspace or Swift package.',
    cwd: typeof input.path === 'string' && input.path.length > 0 ? input.path : undefined,
  }
}

function presentTestCall(args) {
  const input = objectArgs(args)
  const scheme = typeof input.scheme === 'string' && input.scheme.length > 0 ? input.scheme : 'project'
  return {
    card: 'terminal',
    title: `xcodebuild test — ${scheme}`,
    description: 'Run the test action for an Xcode project/workspace or Swift package.',
    cwd: typeof input.path === 'string' && input.path.length > 0 ? input.path : undefined,
  }
}

/**
 * Compact UI payload for the terminal result card. `presentResult` receives the
 * DSH `ToolResult` (content + projection), not the raw tool value, so the
 * interesting fields ride through `output.presentationMeta`.
 */
function buildPresentationMeta(value) {
  const result = value && typeof value === 'object' ? value : {}
  const meta = {}
  if (typeof result.summary === 'string') meta.summary = result.summary
  if (typeof result.error === 'string') meta.error = result.error
  if (typeof result.outputTail === 'string' && result.outputTail.trim().length > 0) {
    meta.output = tailLines(result.outputTail.trim(), 60)
  }
  if (typeof result.logPath === 'string') meta.logPath = result.logPath
  if (typeof result.exitCode === 'number') meta.exitCode = result.exitCode
  if (result.timedOut === true) meta.timedOut = true
  return meta
}

function presentRunResult(args, result) {
  const toolResult = result && typeof result === 'object' ? result : {}
  const meta = toolResult.meta && typeof toolResult.meta === 'object' ? toolResult.meta : {}
  const contentText = Array.isArray(toolResult.content)
    ? toolResult.content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
    : ''
  const body = typeof meta.output === 'string' && meta.output.length > 0 ? meta.output : clip(contentText, 4000)
  const output = [
    typeof meta.summary === 'string' ? meta.summary : '',
    typeof meta.error === 'string' ? meta.error : '',
    body,
    typeof meta.logPath === 'string' ? `Log: ${meta.logPath}` : '',
  ]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('\n')
  const view = {
    card: 'terminal',
    title: typeof meta.summary === 'string' && meta.summary.length > 0 ? meta.summary : 'Apple Dev command',
    output,
  }
  if (typeof meta.exitCode === 'number' && meta.timedOut !== true) view.exitCode = meta.exitCode
  return view
}

/** Shared tail of the build and test tool shapes (parameters differ per tool). */
const PATH_PARAMETER = {
  type: 'string',
  description:
    'Path to the project, workspace, Package.swift, or a directory to search. Defaults to the session working directory.',
}
const DESTINATION_PARAMETER = {
  type: 'string',
  description:
    'Explicit `xcodebuild -destination` value, e.g. "platform=iOS Simulator,name=iPhone 16". Overrides platform/device/os.',
}
const PLATFORM_PARAMETER = {
  type: 'string',
  description:
    'Target platform: iOS, tvOS, watchOS, visionOS, macOS, or e.g. "iOS device"/"iphoneos". Simulator is the default for the mobile platforms.',
}
const DEVICE_PARAMETER = {
  type: 'string',
  description: 'Simulator device name or UDID (resolved through `xcrun simctl list devices`).',
}
const OS_PARAMETER = {
  type: 'string',
  description: 'Simulator runtime version for the destination, e.g. "18.2" (used with `device`, or when a test simulator is auto-selected).',
}
const CONFIGURATION_PARAMETER = {
  type: 'string',
  description: 'Build configuration. Defaults to Debug.',
}
const EXTRA_ARGS_PARAMETER = {
  type: 'array',
  items: { type: 'string' },
  maxItems: 50,
  description: 'Additional arguments appended to the command (e.g. build settings, -quiet, -resultBundlePath).',
}
const TIMEOUT_PARAMETER = {
  type: 'integer',
  minimum: 1_000,
  maximum: EFFECTIVE_MAX_TIMEOUT_MS,
  description: 'Command timeout in milliseconds. Defaults to the plugin configuration (15 minutes).',
}
const DERIVED_DATA_PARAMETER = {
  type: 'string',
  description:
    'Derived data directory for xcodebuild. Defaults to the plugin configuration (.apple-dev/DerivedData under the session directory).',
}

/* ------------------------------------------------------------------------- *
 * Factory
 * ------------------------------------------------------------------------- */

/**
 * Create the project, build and test tools.
 *
 * @param {object} ctx Cordis plugin context.
 * @param {object} config normalized configuration (see `resolveConfig`).
 * @param {(argv: string[], options?: object) => Promise<object>} runner command runner.
 * @returns {object[]} three plain tool definitions.
 */
export function createProjectTools(ctx, config, runner) {
  return [
    {
      name: 'apple_dev_project',
      description:
        'Inspect an Xcode project, workspace or Swift package. Actions: "list" discovers .xcodeproj/.xcworkspace/Package.swift candidates under a directory (depth-limited, ignores build/DerivedData/Pods/.build); "info" reports schemes, targets and build configurations for Xcode, or targets, products, platforms and dependencies for a Swift package; "build_settings" returns selected xcodebuild build settings (bundle id, product path, signing, SDK, deployment target, ...) per target.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: PROJECT_ACTIONS,
            description: 'What to inspect.',
          },
          path: PATH_PARAMETER,
          kind: {
            type: 'string',
            enum: PROJECT_KINDS,
            description: 'Restrict discovery/selection to one container kind. Defaults to workspace > project > package.',
          },
          depth: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description: 'For action "list": how many directory levels to search. Defaults to 3.',
          },
          scheme: {
            type: 'string',
            description: 'For action "build_settings": optional scheme whose build settings to show.',
          },
          configuration: {
            type: 'string',
            description: 'For action "build_settings": optional build configuration.',
          },
          timeout_ms: TIMEOUT_PARAMETER,
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => {
          const action = value && typeof value === 'object' ? value.action : undefined
          const text =
            action === 'info'
              ? projectInfoText(value)
              : action === 'build_settings'
                ? buildSettingsText(value)
                : projectListText(value)
          return renderText(clip(text, DEFAULT_TEXT_CHARS))
        },
      },
      timeoutMs: toolTimeout(config),
      async execute(args, exec) {
        return executeProject(ctx, config, runner, args, exec)
      },
    },
    {
      name: 'apple_dev_build',
      description:
        'Build an Xcode project/workspace (xcodebuild build), or a Swift package with no scheme (swift build --package-path). Discovers the project automatically when `path` is omitted, resolves a simulator destination from `device`/`platform`/`os` when `destination` is not given, writes a derived data directory, and returns a structured result: ok, exitCode, timedOut, durationMs, summary, parsed compile errors with file:line, warning count, full log path and a short output tail. A failed build is a normal result with ok:false, never a tool error.',
      parameters: {
        type: 'object',
        properties: {
          path: PATH_PARAMETER,
          scheme: {
            type: 'string',
            description: 'Xcode scheme. For a Swift package, mapped to `swift build --product`.',
          },
          configuration: CONFIGURATION_PARAMETER,
          destination: DESTINATION_PARAMETER,
          platform: PLATFORM_PARAMETER,
          device: DEVICE_PARAMETER,
          os: OS_PARAMETER,
          derived_data_path: DERIVED_DATA_PARAMETER,
          extra_args: EXTRA_ARGS_PARAMETER,
          timeout_ms: TIMEOUT_PARAMETER,
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => renderText(buildText(value)),
        presentationMeta: (args, value) => buildPresentationMeta(value),
      },
      timeoutMs: toolTimeout(config),
      presentCall: presentBuildCall,
      presentResult: presentRunResult,
      async execute(args, exec) {
        return executeBuild(ctx, config, runner, args, exec)
      },
    },
    {
      name: 'apple_dev_test',
      description:
        'Run tests with `xcodebuild test` (or `swift test` for a Swift package without a scheme). Auto-selects the only scheme when `scheme` is omitted and auto-picks a booted or iPhone simulator when no destination is given. Supports `only_testing` filters and a result bundle path. Returns ok, counts (executed / failures), per-test failures with file:line, full log path and a short output tail; failing tests are a result (ok:false), not a tool error.',
      parameters: {
        type: 'object',
        properties: {
          path: PATH_PARAMETER,
          scheme: {
            type: 'string',
            description: 'Xcode scheme to test. Auto-selected when the project has exactly one scheme; ignored for Swift packages.',
          },
          configuration: CONFIGURATION_PARAMETER,
          destination: DESTINATION_PARAMETER,
          platform: PLATFORM_PARAMETER,
          device: DEVICE_PARAMETER,
          os: OS_PARAMETER,
          only_testing: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 50,
            description: 'Xcode test identifiers as accepted by `-only-testing:` (e.g. "MyAppTests/LoginTests/testSuccess").',
          },
          result_bundle_path: {
            type: 'string',
            description: 'Where xcodebuild writes the .xcresult bundle.',
          },
          derived_data_path: DERIVED_DATA_PARAMETER,
          extra_args: EXTRA_ARGS_PARAMETER,
          timeout_ms: TIMEOUT_PARAMETER,
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => renderText(testText(value)),
        presentationMeta: (args, value) => buildPresentationMeta(value),
      },
      timeoutMs: toolTimeout(config),
      presentCall: presentTestCall,
      presentResult: presentRunResult,
      async execute(args, exec) {
        return executeTest(ctx, config, runner, args, exec)
      },
    },
  ]
}

