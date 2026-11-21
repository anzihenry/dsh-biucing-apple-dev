/**
 * `apple_dev_device`: physical-device control through xcrun devicectl.
 *
 * Simulators use `apple_dev_simulator` (simctl). This tool is the real-hardware
 * counterpart: list paired devices, read details/apps/processes, install and
 * uninstall an app, launch/terminate a process, and capture the screen.
 */
import { stat } from 'node:fs/promises'
import { clip, errorMessage, formatDuration, indent, plural, renderText } from './format.js'
import { platformProblem, resolveUserPath, sessionDirectory } from './runner.js'
import {
  DEVICE_ACTIONS,
  buildDeviceAppsArgv,
  buildDeviceInfoArgv,
  buildDeviceInstallArgv,
  buildDeviceLaunchArgv,
  buildDeviceListArgv,
  buildDeviceProcessesArgv,
  buildDeviceScreenshotArgv,
  buildDeviceTerminateArgv,
  buildDeviceUninstallArgv,
  filterApps,
  parseApps,
  parseDeviceDetails,
  parseDeviceList,
  parseDevicectlJson,
  parseProcesses,
  selectDevice,
} from './device.js'

const DEFAULT_LIST_LIMIT = 40
const MAX_LIST_LIMIT = 200

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function number(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function boolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * One line per device: name, model, OS, pairing/tunnel state, UDID.
 *
 * `connection` is CoreDevice's tunnel state, not command availability: a
 * paired device can report a disconnected tunnel while info/apps/screenshot
 * still work over the local network, so the two facts are rendered separately.
 */
export function formatDeviceRow(device) {
  const model = device.model ? ` (${device.model})` : ''
  const os = device.osVersion ? ` · ${device.platform} ${device.osVersion}` : ''
  const link = device.pairing
    ? ` · ${device.pairing}${device.connection ? ` · tunnel ${device.connection}` : ''}`
    : device.connection ? ` · tunnel ${device.connection}` : ''
  const udid = device.udid ? ` · ${device.udid}` : ''
  return `${device.name || device.identifier}${model}${os}${link}${udid}`
}

/** Text report for `apple_dev_device`. */
export function formatDeviceReport(value) {
  if (!value || typeof value !== 'object') return 'No device result was returned.'
  if (value.error && !value.device && !Array.isArray(value.devices)) return `Device error: ${value.error}`
  const header = value.action === 'list' ? 'Devices' : value.device ? formatDeviceRow(value.device) : 'Device'
  if (value.action === 'list') {
    const lines = [header]
    if (Array.isArray(value.devices) && value.devices.length > 0) {
      lines.push(indent(value.devices.map((device) => `- ${formatDeviceRow(device)}`).join('\n')))
    } else {
      lines.push('No physical devices are paired with this Mac. Connect one, trust it, then retry.')
    }
    if (typeof value.total === 'number' && value.total > (value.devices || []).length) {
      lines.push(`… ${value.total - value.devices.length} more; raise \`limit\` to see them.`)
    }
    return clip(lines.join('\n'))
  }

  const lines = [header]
  const details = value.details || {}
  if (details.udid) lines.push(`UDID: ${details.udid}`)
  if (details.identifier) lines.push(`Identifier: ${details.identifier}`)
  if (details.osBuild) lines.push(`Build: ${details.osBuild}`)
  if (details.developerMode) lines.push(`Developer mode: ${details.developerMode}`)
  if (typeof details.ddiServicesAvailable === 'boolean') lines.push(`DDI services: ${details.ddiServicesAvailable ? 'available' : 'unavailable'}`)
  if (value.message) lines.push(value.message)
  if (value.path) lines.push(`Path: ${value.path}`)
  if (typeof value.pid === 'number') lines.push(`PID: ${value.pid}`)
  if (typeof value.durationMs === 'number') lines.push(`Duration: ${formatDuration(value.durationMs)}`)
  if (Array.isArray(value.apps) && value.action === 'apps') {
    lines.push(`${plural(value.total, 'app')}${value.query ? ` matching "${value.query}"` : ''}`)
    for (const app of value.apps) {
      lines.push(`- ${app.bundleId}${app.version ? ` ${app.version}` : ''}${app.name && app.name !== app.bundleId ? ` — ${app.name}` : ''}`)
    }
  }
  if (Array.isArray(value.processes) && value.action === 'processes') {
    lines.push(`${plural(value.total, 'process', 'processes')}${value.query ? ` matching "${value.query}"` : ''}`)
    for (const process of value.processes) lines.push(`- ${process.pid} ${process.executable}`)
  }
  if (value.error) lines.push(`Error: ${value.error}`)
  return clip(lines.join('\n'))
}

/** Run one command and parse its devicectl JSON envelope. */
async function runJson(runner, argv, { signal, timeoutMs } = {}) {
  const result = await runner(argv, { signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exited ${result.exitCode}`
    throw new Error(`${result.command} failed: ${clip(detail, 1200)}`)
  }
  return parseDevicectlJson(result.stdout)
}

/** List devices and resolve the requested one. */
async function resolveDevice(runner, selector, { signal, timeoutMs } = {}) {
  const json = await runJson(runner, buildDeviceListArgv(), { signal, timeoutMs })
  const devices = parseDeviceList(json)
  const resolved = selectDevice(devices, selector)
  return { devices, ...resolved }
}

function createDeviceTool(ctx, config, runner) {
  return {
    name: 'apple_dev_device',
    description:
      'Control physical Apple devices through xcrun devicectl (simulators use apple_dev_simulator instead). Pairing and CoreDevice tunnel state are reported separately: a disconnected tunnel can still serve info/apps/screenshot over the local network. Actions: list paired devices, info (model/OS/build/developer mode/DDI), apps and processes (installed apps, running PIDs), install a built .app, uninstall by bundle id, launch a bundle with arguments, terminate a PID, or capture a screenshot. The device is a UDID, CoreDevice identifier or exact name; omitted means the only connected physical device.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: DEVICE_ACTIONS, description: 'Operation to perform.' },
        device: { type: 'string', description: 'UDID, CoreDevice identifier or exact device name. Empty means the only connected physical device.' },
        app_path: { type: 'string', description: 'For action=install: path to the built .app bundle (relative paths resolve against the session directory).' },
        bundle_id: { type: 'string', description: 'For action=launch or uninstall: the app bundle identifier.' },
        args: { type: 'array', items: { type: 'string' }, description: 'For action=launch: command-line arguments passed to the app.' },
        terminate_running: { type: 'boolean', description: 'For action=launch: terminate an already running instance first.' },
        pid: { type: 'number', description: 'For action=terminate: process id (see action=processes).' },
        kill: { type: 'boolean', description: 'For action=terminate: send SIGKILL instead of the default signal.' },
        query: { type: 'string', description: 'For action=apps or processes: case-insensitive filter on bundle id/name or executable path.' },
        limit: { type: 'number', description: `Maximum rows for apps/processes (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).` },
        output_path: { type: 'string', description: 'For action=screenshot: PNG path (default .apple-dev/screenshots/device-<name>-<time>.png).' },
        timeout_ms: { type: 'number', description: 'Per-command timeout in milliseconds (default from plugin config).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(formatDeviceReport(value)),
    },
    timeoutMs: 900000,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const problem = platformProblem()
      if (problem) return { tool: 'apple_dev_device', ok: false, error: problem }
      const action = text(input.action)
      if (!DEVICE_ACTIONS.includes(action)) {
        throw new Error(`action must be one of: ${DEVICE_ACTIONS.join(', ')}`)
      }
      const cwd = sessionDirectory(ctx, exec)
      const signal = exec.signal
      const timeoutMs = number(input.timeout_ms, undefined)
      const startedAt = Date.now()
      const report = { tool: 'apple_dev_device', action, ok: false }

      try {
        if (action === 'list') {
          const listing = await resolveDevice(runner, '', { signal, timeoutMs })
          const physical = listing.devices.filter((device) => device.reality === 'physical')
          const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(number(input.limit, DEFAULT_LIST_LIMIT))))
          const selected = (physical.length > 0 ? physical : listing.devices).slice(0, limit)
          return {
            ...report,
            ok: true,
            devices: selected,
            total: physical.length > 0 ? physical.length : listing.devices.length,
            durationMs: Date.now() - startedAt,
          }
        }

        const listing = await resolveDevice(runner, text(input.device), { signal, timeoutMs })
        if (listing.error) {
          return { ...report, ok: false, error: listing.error, candidates: listing.candidates, durationMs: Date.now() - startedAt }
        }
        const device = listing.device
        report.device = device
        const selector = device.identifier || device.udid
        if (!selector) return { ...report, ok: false, error: 'The selected device has no identifier.' }

        if (action === 'info') {
          const json = await runJson(runner, buildDeviceInfoArgv(selector), { signal, timeoutMs })
          const details = parseDeviceDetails(json) || device
          return { ...report, ok: true, details, durationMs: Date.now() - startedAt }
        }

        if (action === 'apps') {
          const json = await runJson(runner, buildDeviceAppsArgv(selector), { signal, timeoutMs })
          const query = text(input.query)
          const all = filterApps(parseApps(json), query)
          const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(number(input.limit, DEFAULT_LIST_LIMIT))))
          return { ...report, ok: true, query, total: all.length, apps: all.slice(0, limit), durationMs: Date.now() - startedAt }
        }

        if (action === 'processes') {
          const json = await runJson(runner, buildDeviceProcessesArgv(selector), { signal, timeoutMs })
          const query = text(input.query).trim().toLowerCase()
          const all = parseProcesses(json).filter((row) => query.length === 0 || row.executable.toLowerCase().includes(query))
          const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(number(input.limit, DEFAULT_LIST_LIMIT))))
          return { ...report, ok: true, query, total: all.length, processes: all.slice(0, limit), durationMs: Date.now() - startedAt }
        }

        if (action === 'install') {
          const appPath = resolveUserPath(cwd, text(input.app_path))
          if (!text(input.app_path).trim()) return { ...report, ok: false, error: 'app_path is required for install.' }
          const info = await stat(appPath).catch(() => undefined)
          if (!info || !info.isDirectory()) return { ...report, ok: false, error: `Not a .app bundle: ${appPath}` }
          const json = await runJson(runner, buildDeviceInstallArgv(selector, appPath), { signal, timeoutMs })
          return { ...report, ok: true, message: `Installed ${appPath} on ${device.name}.`, result: json.result, durationMs: Date.now() - startedAt }
        }

        if (action === 'uninstall') {
          const bundleId = text(input.bundle_id).trim()
          if (!bundleId) return { ...report, ok: false, error: 'bundle_id is required for uninstall.' }
          await runJson(runner, buildDeviceUninstallArgv(selector, bundleId), { signal, timeoutMs })
          return { ...report, ok: true, message: `Uninstalled ${bundleId} from ${device.name}.`, durationMs: Date.now() - startedAt }
        }

        if (action === 'launch') {
          const bundleId = text(input.bundle_id).trim()
          if (!bundleId) return { ...report, ok: false, error: 'bundle_id is required for launch.' }
          const json = await runJson(runner, buildDeviceLaunchArgv(selector, bundleId, {
            args: stringList(input.args),
            terminateExisting: boolean(input.terminate_running),
          }), { signal, timeoutMs })
          const pid = Number(json?.result?.processIdentifier)
          return {
            ...report,
            ok: true,
            message: `Launched ${bundleId} on ${device.name}.`,
            ...(Number.isFinite(pid) && pid > 0 ? { pid } : {}),
            durationMs: Date.now() - startedAt,
          }
        }

        if (action === 'terminate') {
          const pid = number(input.pid, undefined)
          if (!Number.isFinite(pid) || pid <= 0) {
            return { ...report, ok: false, error: 'pid is required for terminate; use action=processes to find it.' }
          }
          await runJson(runner, buildDeviceTerminateArgv(selector, pid, { kill: boolean(input.kill) }), { signal, timeoutMs })
          return { ...report, ok: true, message: `Terminated PID ${pid} on ${device.name}.`, durationMs: Date.now() - startedAt }
        }

        if (action === 'screenshot') {
          const requested = text(input.output_path).trim()
          const name = (device.name || 'device').replace(/[^\w.-]+/g, '-')
          const fallback = `.apple-dev/screenshots/device-${name}-${timestamp()}.png`
          const filePath = resolveUserPath(cwd, requested.length > 0 ? requested : fallback)
          const result = await runner(buildDeviceScreenshotArgv(selector, filePath), { signal, timeoutMs })
          if (!result.ok) throw new Error(result.stderr.trim() || result.stdout.trim() || `devicectl exited ${result.exitCode}`)
          return { ...report, ok: true, path: filePath, message: `Captured the screen of ${device.name}.`, durationMs: Date.now() - startedAt }
        }

        return { ...report, ok: false, error: `Unsupported action: ${action}` }
      } catch (error) {
        return { ...report, ok: false, error: errorMessage(error), durationMs: Date.now() - startedAt }
      }
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: `Device: ${args && typeof args === 'object' ? text(args.action, 'list') : 'list'}`,
      description: args && typeof args === 'object' ? text(args.device) : undefined,
    }),
    presentResult: (_args, result) => ({
      card: 'terminal',
      title: result && result.ok ? 'Device' : 'Device action failed',
      output: clip(formatDeviceReport(result), 4000),
      exitCode: result && result.ok ? 0 : 1,
    }),
  }
}

export function createDeviceTools(ctx, config, runner) {
  return [createDeviceTool(ctx, config, runner)]
}
