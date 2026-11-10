/**
 * Agent tools for the Apple toolchain and simulator lifecycle.
 *
 * `apple_dev_env` answers "what can this Mac build and run?" — Xcode version,
 * active developer directory, SDKs, simulator runtimes/devices, Swift version
 * and signing identities. `apple_dev_simulator` owns device lifecycle and the
 * install/launch/terminate loop used to run a built app.
 *
 * Both return structured plain objects and render a compact text report; the
 * same libraries back the settings page routes in `lib/ui.js`.
 */
import {
  clip,
  errorMessage,
  formatDuration,
  indent,
  plural,
  renderText,
  sections,
  tailLines,
} from './format.js'
import { platformProblem, resolveUserPath, sessionDirectory } from './runner.js'
import { readToolchain } from './env.js'
import {
  appContainer,
  bootSimulator,
  eraseSimulator,
  installApp,
  launchApp,
  listSimulators,
  openSimulatorApp,
  resolveDevice,
  screenshotSimulator,
  shutdownSimulator,
  terminateApp,
} from './simulator.js'

const SIMULATOR_ACTIONS = [
  'list',
  'boot',
  'shutdown',
  'erase',
  'open',
  'install',
  'launch',
  'terminate',
  'screenshot',
  'app_container',
]

const DEVICE_ACTIONS = new Set(['boot', 'shutdown', 'erase', 'install', 'launch', 'terminate', 'screenshot', 'app_container'])

/** Group devices by platform for stable, readable output. */
export function groupByPlatform(devices) {
  const groups = new Map()
  for (const device of Array.isArray(devices) ? devices : []) {
    const key = device.platform || 'unknown'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(device)
  }
  return groups
}

/** One line per device: name, OS version, state. */
export function formatDeviceLine(device) {
  const version = device.osVersion ? ` ${device.osVersion}` : ''
  const unavailable = device.isAvailable === false ? ' (unavailable)' : ''
  return `${device.name}${version} — ${device.state}${unavailable} (${device.udid})`
}

/** Text report for `apple_dev_env`. */
export function formatEnvReport(value) {
  if (!value || typeof value !== 'object') return 'No toolchain information was returned.'
  if (value.error && !value.xcodebuild?.version) return `Apple toolchain problem: ${value.error}`
  const lines = []
  const xcode = value.xcodebuild || {}
  lines.push(`Xcode: ${xcode.version ? `${xcode.version} (${xcode.build || 'unknown build'})` : 'not installed'}`)
  if (xcode.path) lines.push(`xcodebuild: ${xcode.path}`)
  lines.push(`Developer directory: ${value.developerDir || 'unknown (xcode-select has no path)'}`)
  lines.push(`Platform: ${value.platform || 'unknown'}`)
  if (value.swift) lines.push(`Swift: ${value.swift}`)
  if (Array.isArray(value.sdks) && value.sdks.length > 0) {
    lines.push(`SDKs (${value.sdks.length}): ${value.sdks.map((sdk) => sdk.label).join(', ')}`)
  }
  if (Array.isArray(value.runtimes) && value.runtimes.length > 0) {
    const names = [...new Set(value.runtimes.map((runtime) => runtime.name))]
    lines.push(`Simulator runtimes: ${names.join(', ')}`)
  }
  if (Array.isArray(value.xcodes) && value.xcodes.length > 0) {
    lines.push(`Installed Xcodes: ${value.xcodes.map((xcodeApp) => xcodeApp.name).join(', ')}`)
  }
  const signing = value.signing || { count: 0, identities: [] }
  lines.push(`Code-signing identities: ${plural(signing.count || 0, 'identity', 'identities')}`)
  if (Array.isArray(signing.identities) && signing.identities.length > 0) {
    lines.push(indent(signing.identities.map((identity) => identity.name).join('\n')))
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', 'Warnings:', indent(value.warnings.join('\n')))
  }
  if (Array.isArray(value.simulators)) {
    lines.push('', 'Simulators:', indent(formatSimulatorSummary(value.simulators)))
  }
  return clip(lines.join('\n'))
}

const STATE_ICON = { Booted: '● booted', Shutdown: '○ shutdown', Booting: '◐ booting', ShuttingDown: '◐ shutting down' }

/** Grouped simulator list used as text in both tools. */
export function formatSimulatorSummary(devices) {
  const list = Array.isArray(devices) ? devices : []
  if (list.length === 0) return 'No simulator devices. Install a runtime in Xcode first.'
  const available = list.filter((device) => device.isAvailable !== false)
  const shown = available.length > 0 ? available : list
  const booted = shown.filter((device) => device.state === 'Booted').length
  const stale = list.length - shown.length
  const rows = [`${plural(shown.length, 'available device', 'available devices')}${stale > 0 ? ` of ${list.length} total` : ''}, ${booted} booted`]
  for (const [platform, group] of groupByPlatform(shown)) {
    rows.push('', platform)
    const sorted = [...group].sort((left, right) => {
      const bootedDifference = Number(right.state === 'Booted') - Number(left.state === 'Booted')
      if (bootedDifference !== 0) return bootedDifference
      return String(right.osVersion || '').localeCompare(String(left.osVersion || ''), undefined, { numeric: true })
    })
    for (const device of sorted.slice(0, 16)) rows.push(`  ${formatDeviceLine(device)}`)
    if (sorted.length > 16) rows.push(`  … ${sorted.length - 16} more`)
  }
  if (stale > 0) rows.push('', `${stale} unavailable device(s) omitted; they need a current runtime in Xcode.`)
  return clip(rows.join('\n'))
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function boolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function number(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

/** The device a bare `boot` should start: newest available iPhone, else any. */
export function preferredBootDevice(devices) {
  const available = (Array.isArray(devices) ? devices : []).filter((device) => device.isAvailable !== false)
  if (available.length === 0) return undefined
  const byVersion = (left, right) => {
    const leftParts = String(left.osVersion || '').split('.').map(Number)
    const rightParts = String(right.osVersion || '').split('.').map(Number)
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
      const difference = (rightParts[index] || 0) - (leftParts[index] || 0)
      if (difference !== 0) return difference
    }
    return 0
  }
  const iphones = available.filter((device) => device.platform === 'iOS' && /^iPhone/i.test(device.name))
  const pool = iphones.length > 0 ? iphones : available
  return [...pool].sort((left, right) => byVersion(left, right) || left.name.localeCompare(right.name, undefined, { numeric: true }))[0]
}

/** Resolve the target device for one simulator action. */
async function resolveTarget(runner, selector, { signal, forBoot = false } = {}) {
  const listing = await listSimulators(runner, { signal })
  if (!listing.ok) return { error: listing.error, devices: [] }
  const resolved = resolveDevice(listing.devices, selector)
  if (resolved.error && forBoot && selector.trim().length === 0) {
    const preferred = preferredBootDevice(listing.devices)
    if (preferred) {
      return {
        device: preferred,
        devices: listing.devices,
        note: `No device given; booting ${preferred.name} ${preferred.platform} ${preferred.osVersion}. Pass \`device\` to choose another.`,
      }
    }
  }
  if (resolved.error) {
    return {
      error: resolved.error,
      devices: resolved.candidates || listing.devices.slice(0, 12),
    }
  }
  return { device: resolved.device, devices: listing.devices, note: resolved.note }
}

function createEnvTool(ctx, config, runner) {
  return {
    name: 'apple_dev_env',
    description:
      'Report the local Apple toolchain: Xcode version and active developer directory, installed Xcodes, SDKs, simulator runtimes and devices, Swift version, and code-signing identities. Call this first in an Apple project to learn which build/test destinations exist before building or testing.',
    parameters: {
      type: 'object',
      properties: {
        include_devices: {
          type: 'boolean',
          description: 'Also list simulator devices (default true; adds one simctl call).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(formatEnvReport(value)),
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const problem = platformProblem()
      if (problem) return { tool: 'apple_dev_env', ok: false, error: problem }
      try {
        return await readToolchain(ctx, config, runner, {
          signal: exec.signal,
          includeDevices: boolean(input.include_devices, true),
        })
      } catch (error) {
        return { tool: 'apple_dev_env', ok: false, error: errorMessage(error) }
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect Apple toolchain', kind: 'other' }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result && result.ok ? 'Apple toolchain' : 'Apple toolchain unavailable',
      content: [{ type: 'text', text: formatEnvReport(result) }],
    }),
  }
}

function createSimulatorTool(ctx, config, runner) {
  return {
    name: 'apple_dev_simulator',
    description:
      'Manage Apple simulators: list devices and their state, boot/shutdown/erase/open, then install a built .app, launch or terminate it by bundle id, capture a screenshot, or print an app container path. Use `apple_dev_env` first to see available devices; pass `device` as a UDID or exact device name (empty means the only booted device).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: SIMULATOR_ACTIONS,
          description: 'Operation to perform.',
        },
        device: {
          type: 'string',
          description: 'Simulator UDID or exact device name. Empty means the only booted device; "booted" means any booted device.',
        },
        app_path: {
          type: 'string',
          description: 'For action=install: path to the built .app bundle (relative paths resolve against the session directory).',
        },
        bundle_id: {
          type: 'string',
          description: 'For launch/terminate/app_container: the app bundle identifier.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'For action=launch: launch arguments passed to the app.',
        },
        terminate_running: {
          type: 'boolean',
          description: 'For action=launch: terminate an already running instance first.',
        },
        container: {
          type: 'string',
          enum: ['data', 'app', 'groups'],
          description: 'For action=app_container: which container to print (default data).',
        },
        output_path: {
          type: 'string',
          description: 'For action=screenshot: PNG path (default .apple-dev/screenshots/<device>-<time>.png under the session directory).',
        },
        boot_timeout_ms: {
          type: 'number',
          description: 'For action=boot: how long to wait until the device is ready (default 180000).',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(formatSimulatorReport(value)),
    },
    timeoutMs: 600000,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const problem = platformProblem()
      if (problem) return { tool: 'apple_dev_simulator', ok: false, error: problem }
      const action = text(input.action)
      if (!SIMULATOR_ACTIONS.includes(action)) {
        throw new Error(`action must be one of: ${SIMULATOR_ACTIONS.join(', ')}`)
      }
      const cwd = sessionDirectory(ctx, exec)
      const selector = text(input.device).trim()
      const signal = exec.signal
      const report = { tool: 'apple_dev_simulator', action, ok: false }

      try {
        if (action === 'list') {
          const listing = await listSimulators(runner, { signal })
          return { ...report, ok: listing.ok, devices: listing.devices, booted: listing.devices.filter((device) => device.state === 'Booted').length, error: listing.error }
        }

        if (action === 'open') {
          const opened = await openSimulatorApp(runner, { signal, developerDir: config.developerDir })
          return { ...report, ...opened }
        }

        let target
        if (DEVICE_ACTIONS.has(action)) {
          target = await resolveTarget(runner, selector, { signal, forBoot: action === 'boot' })
          if (target.error) {
            return { ...report, ok: false, error: target.error, candidates: target.devices }
          }
          report.device = target.device
          if (target.note) report.note = target.note
        }

        if (action === 'boot') {
          if (target.device.state === 'Booted') {
            return { ...report, ok: true, message: `${target.device.name} is already booted.` }
          }
          const booted = await bootSimulator(runner, target.device, {
            signal,
            waitMs: number(input.boot_timeout_ms, 180000),
          })
          if (booted.ok) report.device = { ...target.device, state: 'Booted' }
          return { ...report, ...booted }
        }

        if (action === 'shutdown') {
          const stopped = await shutdownSimulator(runner, target.device, { signal })
          if (stopped.ok) report.device = { ...target.device, state: 'Shutdown' }
          return { ...report, ...stopped }
        }

        if (action === 'erase') {
          const erased = await eraseSimulator(runner, target.device, { signal })
          if (erased.ok) report.device = { ...target.device, state: 'Shutdown' }
          return { ...report, ...erased }
        }

        if (action === 'install') {
          const appPath = resolveUserPath(cwd, text(input.app_path))
          const installed = await installApp(runner, target.device, appPath, { signal })
          return { ...report, ...installed, appPath }
        }

        if (action === 'launch') {
          const launched = await launchApp(
            runner,
            target.device,
            { bundleId: text(input.bundle_id), args: stringList(input.args), terminateRunning: boolean(input.terminate_running) },
            { signal },
          )
          return { ...report, ...launched }
        }

        if (action === 'terminate') {
          const terminated = await terminateApp(runner, target.device, text(input.bundle_id), { signal })
          return { ...report, ...terminated }
        }

        if (action === 'app_container') {
          const containerResult = await appContainer(runner, target.device, text(input.bundle_id), text(input.container, 'data'), { signal })
          return { ...report, ...containerResult }
        }

        if (action === 'screenshot') {
          const requested = text(input.output_path).trim()
          const fallback = `.apple-dev/screenshots/${target.device.name.replace(/[^\\w.-]+/g, '-')}-${Date.now().toString(36)}.png`
          const filePath = resolveUserPath(cwd, requested.length > 0 ? requested : fallback)
          const shot = await screenshotSimulator(runner, target.device, filePath, { signal })
          return { ...report, ...shot }
        }

        return { ...report, ok: false, error: `Unsupported action: ${action}` }
      } catch (error) {
        return { ...report, ok: false, error: errorMessage(error) }
      }
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: `Simulator: ${args && typeof args === 'object' && typeof args.action === 'string' ? args.action : 'list'}`,
      description: args && typeof args === 'object' && typeof args.device === 'string' ? args.device : undefined,
    }),
    presentResult: (_args, result) => ({
      card: 'terminal',
      title: result && result.ok ? 'Simulator' : 'Simulator action failed',
      output: clip(formatSimulatorReport(result), 4000),
      exitCode: result && result.ok ? 0 : 1,
    }),
  }
}

/** Text report for `apple_dev_simulator`. */
export function formatSimulatorReport(value) {
  if (!value || typeof value !== 'object') return 'No simulator result was returned.'
  const header = value.action ? `Simulator ${value.action}` : 'Simulator'
  if (value.action === 'list') {
    return sections(header, formatSimulatorSummary(value.devices || []))
  }
  const lines = [header]
  if (value.device) lines.push(`Device: ${formatDeviceLine(value.device)}`)
  if (value.message) lines.push(value.message)
  if (value.note) lines.push(value.note)
  if (!value.ok && value.error) lines.push(`Error: ${value.error}`)
  if (Array.isArray(value.candidates) && value.candidates.length > 0) {
    lines.push('Matching devices:', indent(value.candidates.map(formatDeviceLine).join('\n')))
  }
  if (value.path) lines.push(`Path: ${value.path}`)
  if (typeof value.pid === 'number') lines.push(`PID: ${value.pid}`)
  if (typeof value.durationMs === 'number') lines.push(`Duration: ${formatDuration(value.durationMs)}`)
  if (value.output && typeof value.output === 'string') lines.push('', tailLines(value.output.trim(), 20))
  return clip(lines.join('\n'))
}

export function createEnvTools(ctx, config, runner) {
  return [createEnvTool(ctx, config, runner), createSimulatorTool(ctx, config, runner)]
}
