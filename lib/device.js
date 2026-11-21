/**
 * Physical-device control through `xcrun devicectl` (CoreDevice).
 *
 * Simulators are covered by `lib/simulator.js` (simctl). Real hardware needs a
 * different tool: devicectl speaks to paired devices, reports a stable JSON
 * document (`--json-output -`) and keeps human output on stderr, which makes
 * parsing reliable across releases.
 *
 * This module owns the argv builders and the JSON parsers; `lib/tools-device.js`
 * exposes them as the `apple_dev_device` tool. Every command is read-only
 * except install/uninstall/launch/terminate, which the tool documents.
 */

/** Actions accepted by the `apple_dev_device` tool. */
export const DEVICE_ACTIONS = ['list', 'info', 'apps', 'processes', 'install', 'uninstall', 'launch', 'terminate', 'screenshot']

/** Wrap one devicectl invocation with the shared JSON-output flags. */
function devicectl(args, { json = true } = {}) {
  const argv = ['xcrun', 'devicectl', ...args]
  if (json) argv.push('--json-output', '-', '--quiet')
  return argv
}

export function buildDeviceListArgv() {
  return devicectl(['list', 'devices'])
}

export function buildDeviceInfoArgv(selector) {
  return devicectl(['device', 'info', 'details', '--device', String(selector)])
}

export function buildDeviceAppsArgv(selector) {
  return devicectl(['device', 'info', 'apps', '--device', String(selector), '--include-all-apps'])
}

export function buildDeviceProcessesArgv(selector) {
  return devicectl(['device', 'info', 'processes', '--device', String(selector)])
}

export function buildDeviceInstallArgv(selector, appPath) {
  return devicectl(['device', 'install', 'app', '--device', String(selector), String(appPath)])
}

export function buildDeviceUninstallArgv(selector, bundleId) {
  return devicectl(['device', 'uninstall', 'app', '--device', String(selector), String(bundleId)])
}

export function buildDeviceLaunchArgv(selector, bundleId, { args = [], terminateExisting = false } = {}) {
  const argv = ['device', 'process', 'launch', '--device', String(selector)]
  if (terminateExisting) argv.push('--terminate-existing')
  argv.push(String(bundleId), ...(Array.isArray(args) ? args : []).map(String))
  return devicectl(argv)
}

export function buildDeviceTerminateArgv(selector, pid, { kill = false } = {}) {
  const argv = ['device', 'process', 'terminate', '--device', String(selector), '--pid', String(pid)]
  if (kill) argv.push('--kill')
  return devicectl(argv)
}

/** Screenshot output is a binary file: no JSON flags on this call. */
export function buildDeviceScreenshotArgv(selector, destination) {
  return devicectl(['device', 'capture', 'screenshot', '--device', String(selector), '--destination', String(destination)], { json: false })
}

/** Parse the JSON envelope devicectl writes to stdout. */
export function parseDevicectlJson(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw.length === 0) throw new Error('devicectl returned no JSON output.')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`devicectl output is not JSON: ${raw.slice(0, 200)}`)
  }
  const outcome = parsed?.info?.outcome
  if (outcome !== undefined && outcome !== 'success') {
    const message = parsed?.info?.error?.message || parsed?.info?.error || outcome
    throw new Error(`devicectl ${parsed?.info?.commandType || 'command'} failed: ${typeof message === 'string' ? message : JSON.stringify(message)}`)
  }
  return parsed
}

/**
 * Normalize one device entry. Modern devicectl exposes `properties`; older
 * builds (and the deprecated fields still present in v5 JSON) use
 * `hardwareProperties`/`deviceProperties`/`connectionProperties`.
 */
export function parseDevice(entry) {
  if (!entry || typeof entry !== 'object') return undefined
  const props = entry.properties && typeof entry.properties === 'object' ? entry.properties : {}
  const hardware = props.hardware || entry.hardwareProperties || {}
  const software = props.software || {}
  const state = props.state || {}
  const connection = props.connection || entry.connectionProperties || {}
  const legacyDevice = entry.deviceProperties || {}
  const developerMode = state.developerModeStatus && typeof state.developerModeStatus === 'object'
    ? Object.keys(state.developerModeStatus)[0] || 'unknown'
    : (legacyDevice.developerModeStatus || 'unknown')
  return {
    identifier: String(entry.identifier || ''),
    udid: String(hardware.udid || entry.hardwareProperties?.udid || ''),
    name: String(state.name || legacyDevice.name || entry.identifier || ''),
    model: String(hardware.marketingName || ''),
    productType: String(hardware.productType || ''),
    platform: String(hardware.platform || ''),
    osVersion: String(software.osVersionNumber?.stringValue || legacyDevice.osVersionNumber || ''),
    osBuild: String(software.osBuildVersions?.buildVersion?.name || legacyDevice.osBuildUpdate || ''),
    bootState: String(state.bootState || legacyDevice.bootState || ''),
    connection: String(connection.state || connection.tunnelState || ''),
    pairing: String(connection.pairingState || ''),
    reality: String(hardware.reality || ''),
    developerMode: String(developerMode),
    ddiServicesAvailable: typeof legacyDevice.ddiServicesAvailable === 'boolean' ? legacyDevice.ddiServicesAvailable : undefined,
  }
}

/** All devices from a list response, preserving devicectl's order. */
export function parseDeviceList(json) {
  const devices = Array.isArray(json?.result?.devices) ? json.result.devices : []
  return devices.map(parseDevice).filter(Boolean)
}

/** One device from a details/apps/processes response. */
export function parseDeviceDetails(json) {
  return parseDevice(json?.result)
}

/**
 * Resolve the device a command targets.
 *
 * Empty selector: prefer the only connected physical device, then the only
 * physical device, then the only device at all. A selector matches the UDID,
 * the CoreDevice identifier, or the device name (case-insensitive).
 *
 * @param {Array<object>} devices parsed devices.
 * @param {string} selector user-supplied UDID/identifier/name.
 * @returns {{device?: object, error?: string, candidates?: Array<object>}}
 */
export function selectDevice(devices, selector) {
  const list = Array.isArray(devices) ? devices : []
  const query = typeof selector === 'string' ? selector.trim() : ''
  if (query.length === 0) {
    const physical = list.filter((device) => device.reality === 'physical')
    const connected = physical.filter((device) => device.connection === 'connected')
    if (connected.length === 1) return { device: connected[0] }
    if (physical.length === 1) return { device: physical[0] }
    if (list.length === 1) return { device: list[0] }
    return {
      error: 'Select a device with `device` (UDID, CoreDevice identifier or exact name).',
      candidates: (physical.length > 0 ? physical : list).slice(0, 8),
    }
  }
  const needle = query.toLowerCase()
  const matches = list.filter((device) => [device.udid, device.identifier, device.name]
    .some((value) => typeof value === 'string' && value.length > 0 && value.toLowerCase() === needle))
  if (matches.length === 1) return { device: matches[0] }
  if (matches.length > 1) {
    return { error: `More than one device matches "${query}".`, candidates: matches.slice(0, 8) }
  }
  const partial = list.filter((device) => [device.udid, device.identifier, device.name]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle)))
  if (partial.length === 1) return { device: partial[0] }
  return {
    error: `No device matches "${query}".`,
    candidates: (partial.length > 0 ? partial : list).slice(0, 8),
  }
}

/** Apps from an `info apps --include-all-apps` response. */
export function parseApps(json) {
  const apps = Array.isArray(json?.result?.apps) ? json.result.apps : []
  return apps.map((app) => ({
    bundleId: String(app.bundleIdentifier || ''),
    name: String(app.name || ''),
    version: String(app.version || ''),
    build: String(app.bundleVersion || ''),
    url: String(app.url || ''),
    removable: app.removable === true,
    hidden: app.hidden === true,
    defaultApp: app.defaultApp === true,
  })).filter((app) => app.bundleId.length > 0)
}

/** Running processes from an `info processes` response. */
export function parseProcesses(json) {
  const rows = Array.isArray(json?.result?.runningProcesses) ? json.result.runningProcesses : []
  return rows.map((row) => ({
    pid: Number(row.processIdentifier) || 0,
    executable: String(row.executable || '').replace(/^file:\/\//, ''),
  })).filter((row) => row.pid > 0)
}

/** Match apps against a free-text query (bundle id or name). */
export function filterApps(apps, query) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (needle.length === 0) return apps
  return apps.filter((app) => app.bundleId.toLowerCase().includes(needle) || app.name.toLowerCase().includes(needle))
}
