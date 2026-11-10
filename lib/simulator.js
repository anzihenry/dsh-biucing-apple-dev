/**
 * Simulator lifecycle operations (`xcrun simctl`), shared by the simulator tool
 * and the settings-page action route.
 *
 * Every function returns a structured result (`{ ok, message, ... }`) rather
 * than throwing, because "the device was already booted" and "the device is
 * busy" are ordinary outcomes the model and the UI both render.
 */
import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseSimulatorList } from './env.js'

/** All known simulator devices, newest runtime first inside each platform. */
export async function listSimulators(runner, { signal } = {}) {
  const result = await runner(['xcrun', 'simctl', 'list', 'devices', '--json'], { signal, timeoutMs: 60000 })
  if (!result.ok) {
    return {
      ok: false,
      devices: [],
      error: result.spawnError || result.stderr.trim() || `simctl exited ${result.exitCode}`,
    }
  }
  return { ok: true, devices: parseSimulatorList(result.stdout) }
}

/** Devices the runtime still supports. */
function availableDevices(devices) {
  const available = devices.filter((device) => device.isAvailable !== false)
  return available.length > 0 ? available : devices
}

function compareVersions(a, b) {
  const left = String(a || '').split('.').map(Number)
  const right = String(b || '').split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] || 0) - (left[index] || 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Pick one device from a selector.
 *
 * Accepts a full UDID, a case-insensitive device name, `booted`, or an empty
 * selector meaning "the only booted device". Duplicate names prefer a booted
 * device and then the newest runtime.
 *
 * @returns {{ device?: object, error?: string, candidates?: object[] }}
 */
export function resolveDevice(devices, selector) {
  const list = Array.isArray(devices) ? devices : []
  if (list.length === 0) {
    return { error: 'No simulator devices exist. Install a simulator runtime in Xcode first.' }
  }
  const requested = typeof selector === 'string' ? selector.trim() : ''
  const booted = list.filter((device) => device.state === 'Booted')

  if (requested.length === 0) {
    if (booted.length === 1) return { device: booted[0] }
    if (booted.length === 0) {
      return { error: 'No simulator is booted. Pass `device` (a name or UDID) or boot one first.', candidates: availableDevices(list).slice(0, 12) }
    }
    return { error: 'Several simulators are booted; pass `device` to choose one.', candidates: booted }
  }

  if (requested === 'booted') {
    if (booted.length > 0) return { device: booted[0] }
    return { error: 'No simulator is booted.', candidates: availableDevices(list).slice(0, 12) }
  }

  const byUdid = list.find((device) => device.udid.toUpperCase() === requested.toUpperCase())
  if (byUdid) return { device: byUdid }

  const exact = list.filter((device) => device.name === requested)
  const loose = exact.length > 0 ? exact : list.filter((device) => device.name.toLowerCase() === requested.toLowerCase())
  const matches = loose.length > 0 ? availableDevices(loose) : []
  if (matches.length === 1) return { device: matches[0] }
  if (matches.length > 1) {
    const preferred = [...matches].sort((left, right) => {
      const bootedDifference = Number(right.state === 'Booted') - Number(left.state === 'Booted')
      if (bootedDifference !== 0) return bootedDifference
      return compareVersions(left.osVersion, right.osVersion)
    })[0]
    return { device: preferred, note: `Several devices are named "${requested}"; used ${preferred.platform} ${preferred.osVersion} (${preferred.udid}).` }
  }

  return {
    error: `No simulator matches "${requested}".`,
    candidates: availableDevices(list).slice(0, 12),
  }
}

function simctl(runner, args, options = {}) {
  return runner(['xcrun', 'simctl', ...args], { timeoutMs: 120000, ...options })
}

/** Boot a device (idempotent) and wait until it is ready. */
export async function bootSimulator(runner, device, { signal, waitMs = 180000 } = {}) {
  const boot = await simctl(runner, ['boot', device.udid], { signal, timeoutMs: 60000 })
  const alreadyBooted = /current state: Booted/i.test(boot.stdout) || /current state: Booted/i.test(boot.stderr)
  if (!boot.ok && !alreadyBooted) {
    return { ok: false, message: `Could not boot ${device.name}.`, error: boot.stderr.trim() || boot.spawnError || `exit ${boot.exitCode}` }
  }
  const status = await simctl(runner, ['bootstatus', device.udid, '-b'], { signal, timeoutMs: waitMs })
  if (!status.ok) {
    return {
      ok: false,
      message: `${device.name} started booting but did not become ready.`,
      error: status.stderr.trim() || status.spawnError || (status.timedOut ? 'boot timed out' : `exit ${status.exitCode}`),
    }
  }
  return { ok: true, message: `${device.name} (${device.platform} ${device.osVersion}) is booted.` }
}

/** Shut a device down (idempotent). */
export async function shutdownSimulator(runner, device, { signal } = {}) {
  const result = await simctl(runner, ['shutdown', device.udid], { signal })
  if (result.ok) return { ok: true, message: `${device.name} shut down.` }
  if (/current state: Shutdown/i.test(result.stderr) || /current state: Shutdown/i.test(result.stdout)) {
    return { ok: true, message: `${device.name} was already shut down.` }
  }
  return { ok: false, message: `Could not shut down ${device.name}.`, error: result.stderr.trim() || result.spawnError || `exit ${result.exitCode}` }
}

/** Erase a device's data; shuts it down first when needed. */
export async function eraseSimulator(runner, device, { signal } = {}) {
  if (device.state === 'Booted') {
    const stopped = await shutdownSimulator(runner, device, { signal })
    if (!stopped.ok) return stopped
  }
  const result = await simctl(runner, ['erase', device.udid], { signal, timeoutMs: 180000 })
  if (!result.ok) {
    return { ok: false, message: `Could not erase ${device.name}.`, error: result.stderr.trim() || result.spawnError || `exit ${result.exitCode}` }
  }
  return { ok: true, message: `${device.name} erased (all app data removed).` }
}

/**
 * Open the simulator GUI.
 *
 * Xcode 26+ ships the device UI as `DeviceHub.app` and no longer installs a
 * `Simulator.app`; older Xcodes use `Simulator.app`. Try both application names
 * first (LaunchServices resolves them quickly and is sandbox-friendly), then the
 * known bundle paths below the active developer directory.
 */
export async function openSimulatorApp(runner, { signal, developerDir } = {}) {
  const attempts = [
    { argv: ['open', '-a', 'DeviceHub'], app: 'DeviceHub' },
    { argv: ['open', '-a', 'Simulator'], app: 'Simulator' },
  ]
  let activeDeveloperDir = typeof developerDir === 'string' ? developerDir.trim() : ''
  if (activeDeveloperDir.length === 0) {
    const xcodeSelect = await runner(['xcode-select', '-p'], { signal, timeoutMs: 15000 })
    if (xcodeSelect.ok) activeDeveloperDir = xcodeSelect.stdout.trim()
  }
  if (activeDeveloperDir.length > 0) {
    // <Xcode>.app/Contents/Developer -> <Xcode>.app/Contents/Applications
    const contents = activeDeveloperDir.replace(/\/Developer\/?$/, '')
    for (const app of ['DeviceHub', 'Simulator']) {
      for (const suffix of [`/Applications/${app}.app`, `/Developer/Applications/${app}.app`]) {
        const candidate = `${contents}${suffix}`
        attempts.push({ argv: ['open', candidate], app: `${app} at ${candidate}`, path: candidate })
      }
    }
  }
  const failures = []
  for (const attempt of attempts) {
    if (attempt.path !== undefined) {
      try {
        const info = await stat(attempt.path)
        if (!info.isDirectory()) continue
      } catch {
        continue
      }
    }
    const result = await runner(attempt.argv, { signal, timeoutMs: 30000 })
    if (result.ok) {
      return { ok: true, message: `${attempt.app} opened.`, app: attempt.app }
    }
    failures.push(`${attempt.argv.join(' ')}: ${(result.stderr || result.spawnError || `exit ${result.exitCode}`).trim()}`)
  }
  return {
    ok: false,
    message: 'Could not open the simulator GUI. Headless simulator actions (boot/install/launch/screenshot) still work.',
    error: failures.join('; '),
  }
}

/** Install a `.app` bundle (`simctl install`). */
export async function installApp(runner, device, appPath, { signal } = {}) {
  const path = typeof appPath === 'string' ? appPath.trim() : ''
  if (path.length === 0) return { ok: false, message: 'An `.app` path is required.', error: 'missing app path' }
  if (!path.endsWith('.app')) return { ok: false, message: `Not an app bundle: ${path}`, error: 'expected a path ending in .app' }
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return { ok: false, message: `Not a directory: ${path}`, error: 'not a directory' }
  } catch (error) {
    return { ok: false, message: `App bundle not found: ${path}`, error: String(error) }
  }
  const result = await simctl(runner, ['install', device.udid, path], { signal, timeoutMs: 180000 })
  if (!result.ok) {
    return { ok: false, message: `Could not install ${path} on ${device.name}.`, error: result.stderr.trim() || result.spawnError || `exit ${result.exitCode}` }
  }
  return { ok: true, message: `Installed ${path} on ${device.name}.` }
}

/** Launch an installed app; returns the new PID when simctl reports one. */
export async function launchApp(runner, device, { bundleId, args = [], terminateRunning = false } = {}, { signal } = {}) {
  const bundle = typeof bundleId === 'string' ? bundleId.trim() : ''
  if (bundle.length === 0) return { ok: false, message: 'A bundle id is required.', error: 'missing bundle id' }
  const argv = ['launch']
  if (terminateRunning) argv.push('--terminate-running-process')
  argv.push(device.udid, bundle)
  for (const arg of Array.isArray(args) ? args : []) {
    if (typeof arg === 'string') argv.push(arg)
  }
  const result = await simctl(runner, argv, { signal, timeoutMs: 120000 })
  if (!result.ok) {
    return {
      ok: false,
      message: `Could not launch ${bundle} on ${device.name}.`,
      error: result.stderr.trim() || result.spawnError || `exit ${result.exitCode}`,
    }
  }
  const match = /:\s*(\d+)\s*$/.exec(result.stdout.trim()) || /:\s*(\d+)/.exec(result.stdout)
  return {
    ok: true,
    message: `${bundle} launched on ${device.name}${match ? ` (pid ${match[1]})` : ''}.`,
    pid: match ? Number(match[1]) : undefined,
    output: result.stdout.trim(),
  }
}

/** Terminate a running app (idempotent). */
export async function terminateApp(runner, device, bundleId, { signal } = {}) {
  const bundle = typeof bundleId === 'string' ? bundleId.trim() : ''
  if (bundle.length === 0) return { ok: false, message: 'A bundle id is required.', error: 'missing bundle id' }
  const result = await simctl(runner, ['terminate', device.udid, bundle], { signal, timeoutMs: 60000 })
  if (result.ok) return { ok: true, message: `${bundle} terminated on ${device.name}.` }
  if (/found nothing to terminate/i.test(result.stderr) || /not running/i.test(result.stderr)) {
    return { ok: true, message: `${bundle} was not running on ${device.name}.` }
  }
  return { ok: false, message: `Could not terminate ${bundle}.`, error: result.stderr.trim() || result.spawnError || `exit ${result.exitCode}` }
}

/** Container path for an installed app (`app`, `data`, `groups`). */
export async function appContainer(runner, device, bundleId, container = 'data', { signal } = {}) {
  const bundle = typeof bundleId === 'string' ? bundleId.trim() : ''
  if (bundle.length === 0) return { ok: false, message: 'A bundle id is required.', error: 'missing bundle id' }
  const allowed = container === 'app' || container === 'groups' ? container : 'data'
  const result = await simctl(runner, ['get_app_container', device.udid, bundle, allowed], { signal, timeoutMs: 60000 })
  if (!result.ok) {
    return { ok: false, message: `No ${allowed} container for ${bundle}.`, error: result.stderr.trim() || result.spawnError || `exit ${result.exitCode}` }
  }
  return { ok: true, message: `${allowed} container for ${bundle}.`, path: result.stdout.trim() }
}

/** Save a PNG screenshot of the device screen. */
export async function screenshotSimulator(runner, device, filePath, { signal } = {}) {
  const path = typeof filePath === 'string' ? filePath.trim() : ''
  if (path.length === 0) return { ok: false, message: 'A screenshot path is required.', error: 'missing path' }
  try {
    await mkdir(dirname(path), { recursive: true })
  } catch {
    /* the simctl error below is the actionable one */
  }
  const result = await simctl(runner, ['io', device.udid, 'screenshot', path], { signal, timeoutMs: 60000 })
  if (!result.ok) {
    return { ok: false, message: `Could not capture a screenshot of ${device.name}.`, error: result.stderr.trim() || result.spawnError || `exit ${result.exitCode}` }
  }
  return { ok: true, message: `Screenshot saved to ${path}.`, path }
}
