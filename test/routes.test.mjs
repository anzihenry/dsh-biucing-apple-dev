/**
 * Route-level tests for the settings-page API, using mocked request/response
 * objects and a fake runner. They pin the JSON contract the Client module
 * depends on without needing the plugin to be installed.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { registerAppleDevRoutes, STATUS_PATH, ACTION_PATH } from '../lib/ui.js'

const DEVICES_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [
      { udid: 'AAAAAAAA-0000-0000-0000-000000000001', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
      { udid: 'AAAAAAAA-0000-0000-0000-000000000002', name: 'iPhone Air', state: 'Booted', isAvailable: true },
      { udid: 'AAAAAAAA-0000-0000-0000-000000000003', name: 'Stale Phone', state: 'Shutdown', isAvailable: false },
    ],
  },
})

function fakeRunner(calls = []) {
  return async (argv) => {
    calls.push(argv)
    const joined = argv.join(' ')
    if (joined.startsWith('xcrun simctl list devices')) {
      return { ok: true, argv, command: joined, exitCode: 0, stdout: DEVICES_JSON, stderr: '' }
    }
    if (joined.startsWith('xcrun simctl boot ') || joined.startsWith('xcrun simctl shutdown ')) {
      return { ok: true, argv, command: joined, exitCode: 0, stdout: '', stderr: '' }
    }
    if (joined.startsWith('xcrun simctl bootstatus ')) {
      return { ok: true, argv, command: joined, exitCode: 0, stdout: 'Monitoring boot status\n', stderr: '' }
    }
    if (joined === 'xcrun simctl list runtimes --json') {
      return {
        ok: true,
        argv,
        command: joined,
        exitCode: 0,
        stdout: JSON.stringify({ runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2', name: 'iOS 27.2', version: '27.2', isAvailable: true }] }),
        stderr: '',
      }
    }
    if (joined === 'xcodebuild -version') {
      return { ok: true, argv, command: joined, exitCode: 0, stdout: 'Xcode 27.2\nBuild version 27B52\n', stderr: '' }
    }
    if (joined === 'xcode-select -p') {
      return { ok: true, argv, command: joined, exitCode: 0, stdout: '/Applications/Xcode-27.2.0.app/Contents/Developer\n', stderr: '' }
    }
    if (joined === 'xcodebuild -showsdks') {
      return { ok: true, argv, command: joined, exitCode: 0, stdout: 'iOS SDKs:\n\tiOS 27.2                      \t-sdk iphoneos27.2\n', stderr: '' }
    }
    return { ok: false, argv, command: joined, exitCode: 1, stdout: '', stderr: 'unsupported in fake runner' }
  }
}

function fakeScope() {
  const routes = new Map()
  const disposers = []
  const webServer = {
    register(route) {
      routes.set(route.path, route)
      const dispose = () => routes.delete(route.path)
      disposers.push(dispose)
      return dispose
    },
  }
  const scope = {
    webServer,
    routes,
    get(name) {
      if (name === 'subprocess') {
        return { resolveExecutable: async (command) => `/usr/bin/${command}` }
      }
      return undefined
    },
  }
  return scope
}

function mockRequest({ method = 'GET', url, headers = {}, body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:63971', 'sec-fetch-site': 'same-origin', ...headers }
  if (body !== undefined) {
    req.destroy = () => {}
    queueMicrotask(() => {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      req.emit('end')
    })
  }
  return req
}

function mockResponse() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      Object.assign(this.headers, headers || {})
    },
    end(body) {
      this.body = body || ''
    },
  }
  return res
}

async function call(scope, path, request) {
  const route = scope.routes.get(path)
  assert.ok(route, `route ${path} must be registered`)
  const res = mockResponse()
  await route.handler(request, res)
  return res
}

function json(res) {
  return JSON.parse(res.body)
}

test('registerAppleDevRoutes registers both exact routes and disposes them', () => {
  const scope = fakeScope()
  const dispose = registerAppleDevRoutes(scope, { xcodebuild: 'xcodebuild' }, fakeRunner())
  assert.equal(scope.routes.get(STATUS_PATH).kind, 'exact')
  assert.equal(scope.routes.get(ACTION_PATH).kind, 'exact')
  dispose()
  assert.equal(scope.routes.size, 0)
})

test('GET status returns the toolchain contract and available simulators only', async () => {
  const scope = fakeScope()
  registerAppleDevRoutes(scope, { xcodebuild: 'xcodebuild' }, fakeRunner())
  const res = await call(scope, STATUS_PATH, mockRequest({ url: STATUS_PATH }))
  assert.equal(res.status, 200)
  const payload = json(res)
  assert.equal(payload.platform, 'darwin')
  assert.equal(payload.toolchain.xcodebuild.version, '27.2')
  assert.equal(payload.toolchain.xcodebuild.build, '27B52')
  assert.ok(Array.isArray(payload.toolchain.sdks))
  assert.equal(payload.signing.count, 0)
  assert.equal(payload.simulators.length, 2)
  assert.ok(payload.simulators.every((device) => device.isAvailable !== false))
  assert.deepEqual(Object.keys(payload.simulators[0]).sort(), ['isAvailable', 'name', 'osVersion', 'platform', 'state', 'udid'])
  assert.equal(typeof payload.generatedAt, 'string')
})

test('status cache serves repeat requests and refresh=1 bypasses it', async () => {
  const scope = fakeScope()
  const calls = []
  registerAppleDevRoutes(scope, { xcodebuild: 'xcodebuild' }, fakeRunner(calls))
  await call(scope, STATUS_PATH, mockRequest({ url: STATUS_PATH }))
  const afterFirst = calls.length
  await call(scope, STATUS_PATH, mockRequest({ url: STATUS_PATH }))
  assert.equal(calls.length, afterFirst, 'a cached status must not run commands again')
  await call(scope, STATUS_PATH, mockRequest({ url: `${STATUS_PATH}?refresh=1` }))
  assert.ok(calls.length > afterFirst)
})

test('cross-origin status and action requests are refused', async () => {
  const scope = fakeScope()
  registerAppleDevRoutes(scope, { xcodebuild: 'xcodebuild' }, fakeRunner())
  const status = await call(scope, STATUS_PATH, mockRequest({ url: STATUS_PATH, headers: { 'sec-fetch-site': 'cross-site' } }))
  assert.equal(status.status, 403)
  const action = await call(scope, ACTION_PATH, mockRequest({ method: 'POST', url: ACTION_PATH, headers: { origin: 'https://evil.example' }, body: { action: 'boot', device: 'iPhone 17' } }))
  assert.equal(action.status, 403)
})

test('POST boot resolves the device, boots it and returns refreshed simulators', async () => {
  const scope = fakeScope()
  const calls = []
  registerAppleDevRoutes(scope, { xcodebuild: 'xcodebuild' }, fakeRunner(calls))
  const res = await call(scope, ACTION_PATH, mockRequest({ method: 'POST', url: ACTION_PATH, body: { action: 'boot', device: 'iPhone 17' } }))
  assert.equal(res.status, 200)
  const payload = json(res)
  assert.equal(payload.ok, true)
  assert.equal(payload.action, 'boot')
  assert.match(payload.message, /booted/i)
  assert.equal(payload.simulators.length, 2, 'action responses carry the available devices')
  assert.ok(payload.simulators.every((device) => device.isAvailable !== false))
  assert.ok(calls.some((argv) => argv.join(' ').includes('simctl boot AAAAAAAA-0000-0000-0000-000000000001')))
})

test('POST action validates the allowlist, device and JSON body', async () => {
  const scope = fakeScope()
  registerAppleDevRoutes(scope, { xcodebuild: 'xcodebuild' }, fakeRunner())
  const badAction = await call(scope, ACTION_PATH, mockRequest({ method: 'POST', url: ACTION_PATH, body: { action: 'rm -rf', device: 'iPhone 17' } }))
  assert.equal(badAction.status, 400)
  assert.match(json(badAction).error, /action must be one of/)
  const noDevice = await call(scope, ACTION_PATH, mockRequest({ method: 'POST', url: ACTION_PATH, body: { action: 'boot' } }))
  assert.equal(noDevice.status, 400)
  const badJson = await call(scope, ACTION_PATH, mockRequest({ method: 'POST', url: ACTION_PATH, body: '{nope' }))
  assert.equal(badJson.status, 400)
  const unknownDevice = await call(scope, ACTION_PATH, mockRequest({ method: 'POST', url: ACTION_PATH, body: { action: 'boot', device: 'iPhone 99' } }))
  assert.equal(unknownDevice.status, 404)
  const wrongMethod = await call(scope, ACTION_PATH, mockRequest({ method: 'GET', url: ACTION_PATH }))
  assert.equal(wrongMethod.status, 405)
})

test('DELETE status is rejected with an allow header', async () => {
  const scope = fakeScope()
  registerAppleDevRoutes(scope, { xcodebuild: 'xcodebuild' }, fakeRunner())
  const res = await call(scope, STATUS_PATH, mockRequest({ method: 'DELETE', url: STATUS_PATH }))
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, HEAD')
})

test('status carries the Xcode MCP snapshot once the background probe settles', async () => {
  const scope = fakeScope()
  const fakeMcp = {
    async listTools() {
      return [{ name: 'BuildProject' }]
    },
    describe() {
      return {
        state: 'ready',
        server: { name: 'xcode-tools', version: '25464' },
        protocolVersion: '2025-06-18',
        toolCount: 54,
        approval: 'granted',
      }
    },
  }
  registerAppleDevRoutes(scope, { xcodebuild: 'xcodebuild', mcpCommand: 'xcrun', mcpArgs: ['mcpbridge'] }, fakeRunner(), fakeMcp)
  const first = json(await call(scope, STATUS_PATH, mockRequest({ url: STATUS_PATH })))
  assert.equal(first.xcodeMcp.state, 'connecting', 'the first answer must not wait for the bridge')
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = json(await call(scope, STATUS_PATH, mockRequest({ url: STATUS_PATH })))
  assert.equal(second.xcodeMcp.state, 'ready')
  assert.equal(second.xcodeMcp.toolCount, 54)
  assert.equal(second.xcodeMcp.server.name, 'xcode-tools')
  assert.equal(second.xcodeMcp.bridge, 'xcrun mcpbridge')
  assert.equal(second.toolchain.xcodebuild.version, '27.2', 'the cached toolchain section still applies')

  const forced = json(await call(scope, STATUS_PATH, mockRequest({ url: `${STATUS_PATH}?refresh=1` })))
  assert.equal(forced.xcodeMcp.state, 'connecting', 'refresh=1 must bypass the probe cache')
  await new Promise((resolve) => setTimeout(resolve, 10))
  const reconnected = json(await call(scope, STATUS_PATH, mockRequest({ url: STATUS_PATH })))
  assert.equal(reconnected.xcodeMcp.state, 'ready')
})

test('status reports a disabled or failed MCP surface instead of hanging', async () => {
  const disabledScope = fakeScope()
  registerAppleDevRoutes(
    disabledScope,
    { xcodebuild: 'xcodebuild', mcpEnabled: false },
    fakeRunner(),
    { async listTools() { throw new Error('must not be called') } },
  )
  const disabled = json(await call(disabledScope, STATUS_PATH, mockRequest({ url: STATUS_PATH })))
  assert.equal(disabled.xcodeMcp.state, 'disabled')

  const failingScope = fakeScope()
  registerAppleDevRoutes(
    failingScope,
    { xcodebuild: 'xcodebuild' },
    fakeRunner(),
    { async listTools() { throw new Error('bridge refused') }, describe() { return {} } },
  )
  await call(failingScope, STATUS_PATH, mockRequest({ url: STATUS_PATH }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  const failing = json(await call(failingScope, STATUS_PATH, mockRequest({ url: STATUS_PATH })))
  assert.equal(failing.xcodeMcp.state, 'unavailable')
  assert.match(failing.xcodeMcp.error, /bridge refused/)
})

test('a status payload without an MCP client stays backward compatible', async () => {
  const scope = fakeScope()
  registerAppleDevRoutes(scope, { xcodebuild: 'xcodebuild' }, fakeRunner())
  const payload = json(await call(scope, STATUS_PATH, mockRequest({ url: STATUS_PATH })))
  assert.equal(Object.hasOwn(payload, 'xcodeMcp'), false)
})

function fakeMcp(overrides = {}) {
  const calls = []
  return {
    calls,
    async listTools() {
      return [{ name: 'BuildProject' }]
    },
    describe() {
      return { state: 'ready', server: { name: 'xcode-tools', version: '25464' }, toolCount: 1, approval: 'granted' }
    },
    reconnect() {
      calls.push({ reconnect: true })
    },
    async callTool(name, args) {
      calls.push({ name, args })
      if (overrides.result) return overrides.result
      return { isError: false, text: '{"workspaceIdentifier":"workspace1","workspacePath":"/tmp/Demo.xcodeproj"}', images: [] }
    },
  }
}

test('POST mcp_reconnect resets the bridge through the allowed action', async () => {
  const scope = fakeScope()
  const mcp = fakeMcp()
  registerAppleDevRoutes(scope, { xcodebuild: 'xcodebuild' }, fakeRunner(), mcp)
  const res = await call(scope, ACTION_PATH, mockRequest({ method: 'POST', url: ACTION_PATH, body: { action: 'mcp_reconnect' } }))
  assert.equal(res.status, 200)
  const payload = json(res)
  assert.equal(payload.ok, true)
  assert.equal(payload.action, 'mcp_reconnect')
  assert.equal(mcp.calls.filter((call) => call.reconnect).length, 1)
  assert.equal(payload.xcodeMcp.state, 'connecting', 'the card is told to probe again')
})

test('POST mcp_open_workspace validates the path and calls XcodeOpenWorkspace', async () => {
  const scope = fakeScope()
  const mcp = fakeMcp()
  registerAppleDevRoutes(scope, { xcodebuild: 'xcodebuild' }, fakeRunner(), mcp)

  const opened = await call(scope, ACTION_PATH, mockRequest({ method: 'POST', url: ACTION_PATH, body: { action: 'mcp_open_workspace', path: '/tmp/Demo.xcodeproj' } }))
  assert.equal(opened.status, 200)
  const payload = json(opened)
  assert.equal(payload.ok, true)
  assert.match(payload.message, /Demo\.xcodeproj/)
  const callRecord = mcp.calls.find((entry) => entry.name === 'XcodeOpenWorkspace')
  assert.deepEqual(callRecord.args, { path: '/tmp/Demo.xcodeproj' })

  const missing = await call(scope, ACTION_PATH, mockRequest({ method: 'POST', url: ACTION_PATH, body: { action: 'mcp_open_workspace' } }))
  assert.equal(missing.status, 400)
  const wrongKind = await call(scope, ACTION_PATH, mockRequest({ method: 'POST', url: ACTION_PATH, body: { action: 'mcp_open_workspace', path: '/tmp/notes.txt' } }))
  assert.equal(wrongKind.status, 400)
  const control = await call(scope, ACTION_PATH, mockRequest({ method: 'POST', url: ACTION_PATH, body: { action: 'mcp_open_workspace', path: '/tmp/a\u0000.xcodeproj' } }))
  assert.equal(control.status, 400)
})

test('MCP actions report a refused open and a disabled surface', async () => {
  const refusedScope = fakeScope()
  const refused = fakeMcp({ result: { isError: true, text: 'SourceFileNotFoundInProjectError', images: [] } })
  registerAppleDevRoutes(refusedScope, { xcodebuild: 'xcodebuild' }, fakeRunner(), refused)
  const refusedRes = await call(refusedScope, ACTION_PATH, mockRequest({ method: 'POST', url: ACTION_PATH, body: { action: 'mcp_open_workspace', path: '/tmp/Demo.xcodeproj' } }))
  assert.equal(refusedRes.status, 200)
  assert.equal(json(refusedRes).ok, false)
  assert.match(json(refusedRes).error, /SourceFileNotFound/)

  const disabledScope = fakeScope()
  registerAppleDevRoutes(disabledScope, { xcodebuild: 'xcodebuild', mcpEnabled: false }, fakeRunner(), fakeMcp())
  const disabledRes = await call(disabledScope, ACTION_PATH, mockRequest({ method: 'POST', url: ACTION_PATH, body: { action: 'mcp_reconnect' } }))
  assert.equal(disabledRes.status, 400)
  assert.match(json(disabledRes).error, /not enabled/)
})
