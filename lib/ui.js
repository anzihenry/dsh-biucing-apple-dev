/**
 * The two loopback JSON routes the "Apple Dev" settings page uses.
 *
 * One operation, two callers: the simulator route below calls exactly the same
 * `lib/simulator.js` functions the `apple_dev_simulator` tool calls, and the
 * status route reads the same `lib/env.js` report the `apple_dev_env` tool
 * returns. There is deliberately no generic command endpoint here.
 *
 * Safety: same-origin requests only, bounded JSON bodies, a short status cache,
 * and an explicit allowlist of four harmless simulator actions.
 */
import { errorMessage } from './format.js'
import { listSimulators, resolveDevice, bootSimulator, eraseSimulator, openSimulatorApp, shutdownSimulator } from './simulator.js'
import { readToolchain } from './env.js'
import { nowIso } from './runner.js'

export const STATUS_PATH = '/dsh-biucing-apple-dev/status'
export const ACTION_PATH = '/dsh-biucing-apple-dev/action'
const MAX_BODY_BYTES = 16 * 1024
const STATUS_TTL_MS = 5000
const UI_ACTIONS = new Set(['boot', 'shutdown', 'open', 'erase'])

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** Reject cross-site requests; the page is same-origin by construction. */
function sameOriginRejection(req) {
  const host = req.headers && req.headers.host
  const fetchSite = req.headers && req.headers['sec-fetch-site']
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return 'Cross-site request refused.'
  const origin = req.headers && req.headers.origin
  if (origin) {
    try {
      if (!host || new URL(origin).host !== host) return 'Cross-origin request refused.'
    } catch {
      return 'Invalid Origin header.'
    }
  }
  return null
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Request body is too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim().length === 0) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('Request body is not valid JSON.'))
      }
    })
    req.on('error', reject)
  })
}

function statusPayload(report, devices) {
  return {
    ok: report.ok,
    generatedAt: report.generatedAt,
    platform: report.platform,
    toolchain: {
      xcodebuild: report.xcodebuild,
      developerDir: report.developerDir,
      xcodes: report.xcodes,
      sdks: report.sdks,
      runtimes: report.runtimes,
      swift: report.swift,
      warnings: report.warnings,
    },
    signing: report.signing,
    simulators: (Array.isArray(devices) ? devices : report.simulators || [])
      .filter((device) => device.isAvailable !== false)
      .map((device) => ({
      udid: device.udid,
      name: device.name,
      platform: device.platform,
      osVersion: device.osVersion,
      state: device.state,
      isAvailable: device.isAvailable,
    })),
    error: report.error,
  }
}

/**
 * Register the settings-page routes.
 *
 * @param {object} scope child context carrying `webServer`.
 * @param {object} config normalized config.
 * @param {Function} runner command runner.
 * @returns {() => void} disposer unregistering both routes.
 */
export function registerAppleDevRoutes(scope, config, runner) {
  const webServer = scope.webServer
  if (!webServer || typeof webServer.register !== 'function') return () => {}

  let cached = null
  let cachedAt = 0
  let statusInFlight = null
  const actionBusy = new Set()

  async function collectStatus({ force = false } = {}) {
    if (!force && cached && Date.now() - cachedAt < STATUS_TTL_MS) return cached
    if (statusInFlight) return statusInFlight
    statusInFlight = (async () => {
      const report = await readToolchain(scope, config, runner, { includeDevices: false })
      const listing = await listSimulators(runner, {})
      const payload = statusPayload(report, listing.devices)
      if (!listing.ok) payload.error = payload.error || listing.error
      cached = payload
      cachedAt = Date.now()
      return payload
    })().finally(() => {
      statusInFlight = null
    })
    return statusInFlight
  }

  const statusRoute = webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    async handler(req, res) {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        const rejection = sameOriginRejection(req)
        if (rejection) return sendJson(res, 403, { ok: false, error: rejection })
        const url = new URL(req.url || STATUS_PATH, 'http://127.0.0.1')
        const payload = await collectStatus({ force: url.searchParams.get('refresh') === '1' })
        sendJson(res, 200, payload)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: errorMessage(error), generatedAt: nowIso() })
      }
    },
  })

  const actionRoute = webServer.register({
    kind: 'exact',
    path: ACTION_PATH,
    async handler(req, res) {
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { allow: 'POST' })
          res.end()
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        const rejection = sameOriginRejection(req)
        if (rejection) return sendJson(res, 403, { ok: false, error: rejection })

        const input = await readJsonBody(req)
        const action = typeof input.action === 'string' ? input.action.trim() : ''
        if (!UI_ACTIONS.has(action)) {
          return sendJson(res, 400, { ok: false, error: `action must be one of: ${[...UI_ACTIONS].join(', ')}` })
        }
        if (actionBusy.has(action)) {
          return sendJson(res, 429, { ok: false, error: `An ${action} request is already running.` })
        }
        actionBusy.add(action)
        try {
          let result
          if (action === 'open') {
            result = await openSimulatorApp(runner, { developerDir: config.developerDir })
          } else {
            const selector = typeof input.device === 'string' ? input.device.trim() : ''
            if (selector.length === 0) return sendJson(res, 400, { ok: false, error: 'device (UDID or name) is required.' })
            const listing = await listSimulators(runner, {})
            if (!listing.ok) return sendJson(res, 500, { ok: false, error: listing.error })
            const resolved = resolveDevice(listing.devices, selector)
            if (resolved.error) {
              return sendJson(res, 404, { ok: false, error: resolved.error, simulators: listing.devices })
            }
            if (action === 'boot') result = await bootSimulator(runner, resolved.device, {})
            else if (action === 'shutdown') result = await shutdownSimulator(runner, resolved.device, {})
            else result = await eraseSimulator(runner, resolved.device, {})
          }
          const refreshed = await listSimulators(runner, {})
          return sendJson(res, result.ok ? 200 : 500, {
            ok: result.ok,
            action,
            message: result.message,
            error: result.ok ? undefined : result.error,
            simulators: refreshed.ok ? refreshed.devices.filter((device) => device.isAvailable !== false) : undefined,
          })
        } finally {
          actionBusy.delete(action)
        }
      } catch (error) {
        sendJson(res, 400, { ok: false, error: errorMessage(error) })
      }
    },
  })

  return () => {
    try {
      actionRoute()
    } catch {
      /* already disposed */
    }
    try {
      statusRoute()
    } catch {
      /* already disposed */
    }
  }
}
