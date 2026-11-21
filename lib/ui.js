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
import { basename, isAbsolute } from 'node:path'
import { clip, errorMessage } from './format.js'
import { listSimulators, resolveDevice, bootSimulator, eraseSimulator, openSimulatorApp, shutdownSimulator } from './simulator.js'
import { readToolchain } from './env.js'
import { nowIso, resolveUserPath } from './runner.js'

export const STATUS_PATH = '/dsh-biucing-apple-dev/status'
export const ACTION_PATH = '/dsh-biucing-apple-dev/action'
const MAX_BODY_BYTES = 16 * 1024
const STATUS_TTL_MS = 5000
const UI_ACTIONS = new Set(['boot', 'shutdown', 'open', 'erase', 'mcp_reconnect', 'mcp_open_workspace'])
/** A successful MCP probe is reused this long before the page re-probes. */
const MCP_TTL_MS = 15000
/** A failed probe is reused longer, so a closed Xcode cannot spawn a bridge per refresh. */
const MCP_FAILURE_TTL_MS = 30000
/** Bound for the whole probe: spawn + initialize + tools/list. */
const MCP_PROBE_TIMEOUT_MS = 8000

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
 * @param {object} [mcp] lazy Xcode MCP client; omitted in tests and old callers.
 * @returns {() => void} disposer unregistering both routes.
 */
export function registerAppleDevRoutes(scope, config, runner, mcp) {
  const webServer = scope.webServer
  if (!webServer || typeof webServer.register !== 'function') return () => {}

  let cached = null
  let cachedAt = 0
  let statusInFlight = null
  const actionBusy = new Set()
  const mcpEnabled = mcp !== undefined && config.mcpEnabled !== false
  const mcpBridge = `${config.mcpCommand || 'xcrun'} ${Array.isArray(config.mcpArgs) ? config.mcpArgs.join(' ') : 'mcpbridge'}`.trim()
  let mcpSnapshot = null
  let mcpProbedAt = 0
  let mcpProbe = null
  let mcpAbort = null

  /** Start one bounded background probe; the status route never waits on it. */
  function startMcpProbe() {
    if (!mcpEnabled || mcpProbe) return
    const controller = new AbortController()
    mcpAbort = controller
    const timer = setTimeout(() => controller.abort(), MCP_PROBE_TIMEOUT_MS)
    timer.unref?.()
    mcpProbe = (async () => {
      try {
        await mcp.listTools({ signal: controller.signal })
        const info = mcp.describe()
        mcpSnapshot = {
          state: info.state === 'ready' ? 'ready' : 'connecting',
          server: info.server,
          toolCount: typeof info.toolCount === 'number' ? info.toolCount : 0,
          approval: info.approval || 'unknown',
          bridge: mcpBridge,
        }
      } catch (error) {
        mcpSnapshot = { state: 'unavailable', error: errorMessage(error), bridge: mcpBridge }
      } finally {
        clearTimeout(timer)
        if (mcpAbort === controller) mcpAbort = null
        mcpProbedAt = Date.now()
        mcpProbe = null
      }
    })()
  }

  /**
   * Current MCP status: a fresh snapshot, a stale one while re-probing, or
   * "connecting" when nothing is cached yet or the caller forced a refresh.
   *
   * @param {boolean} force ignore the cache (the page's manual refresh).
   * @returns {object|undefined} status for the settings payload.
   */
  function mcpStatus(force) {
    if (mcp === undefined) return undefined
    if (!mcpEnabled) return { state: 'disabled', bridge: mcpBridge }
    if (force) {
      startMcpProbe()
      return { state: 'connecting', bridge: mcpBridge }
    }
    const ttl = mcpSnapshot && mcpSnapshot.state === 'ready' ? MCP_TTL_MS : MCP_FAILURE_TTL_MS
    if (mcpSnapshot && Date.now() - mcpProbedAt < ttl) return mcpSnapshot
    startMcpProbe()
    return mcpSnapshot ? Object.assign({}, mcpSnapshot, { stale: true }) : { state: 'connecting', bridge: mcpBridge }
  }

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
        const status = mcpStatus(url.searchParams.get('refresh') === '1')
        sendJson(res, 200, status === undefined ? payload : Object.assign({}, payload, { xcodeMcp: status }))
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
          if (action === 'mcp_reconnect' || action === 'mcp_open_workspace') {
            if (!mcp || config.mcpEnabled === false) {
              return sendJson(res, 400, { ok: false, action, error: 'Xcode MCP is not enabled on this Host.' })
            }
            if (action === 'mcp_reconnect') {
              mcp.reconnect?.()
              mcpSnapshot = null
              mcpProbedAt = 0
              startMcpProbe()
              return sendJson(res, 200, {
                ok: true,
                action,
                message: 'Reconnecting to Xcode MCP.',
                xcodeMcp: mcpStatus(false),
              })
            }
            const requested = typeof input.path === 'string' ? input.path.trim() : ''
            if (requested.length === 0) {
              return sendJson(res, 400, { ok: false, action, error: 'path is required (a .xcodeproj or .xcworkspace).' })
            }
            if (requested.length > 1024 || /[\u0000-\u001f\u007f]/.test(requested)) {
              return sendJson(res, 400, { ok: false, action, error: 'path is not a valid file path.' })
            }
            const expanded = resolveUserPath(process.cwd(), requested)
            if (!isAbsolute(expanded)) {
              return sendJson(res, 400, { ok: false, action, error: 'path must be absolute (or start with ~/).' })
            }
            if (!/\.(xcodeproj|xcworkspace)$/i.test(expanded)) {
              return sendJson(res, 400, { ok: false, action, error: 'path must end with .xcodeproj or .xcworkspace.' })
            }
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 120000)
            timer.unref?.()
            try {
              const opened = await mcp.callTool('XcodeOpenWorkspace', { path: expanded }, { signal: controller.signal, timeoutMs: 120000 })
              mcpSnapshot = null
              mcpProbedAt = 0
              if (opened.isError) {
                return sendJson(res, 200, {
                  ok: false,
                  action,
                  error: clip(opened.text || 'Xcode refused to open the workspace.', 800),
                  xcodeMcp: mcpStatus(false),
                })
              }
              return sendJson(res, 200, {
                ok: true,
                action,
                message: `Opened ${basename(expanded)}. Approve the prompt in Xcode if it appears.`,
                detail: clip(opened.text, 800),
                xcodeMcp: mcpStatus(false),
              })
            } finally {
              clearTimeout(timer)
            }
          }

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
      mcpAbort?.abort()
    } catch {
      /* the probe already settled */
    }
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
