/**
 * Tests for the Xcode MCP gateway: the stdio JSON-RPC client, the compact
 * catalog, the mutation guard, and the connection/approval error paths.
 *
 * The bridge is faked at the subprocess-service seam: a PassThrough pair per
 * stream speaks the same newline-delimited JSON-RPC Xcode's `mcpbridge` does,
 * so the framing, request correlation and timeout logic all run for real.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createXcodeMcp, McpLineDecoder, normalizeCallResult, summarizeTool, isApprovalRequired } from '../lib/mcp.js'
import { collectImagePaths, createMcpTools, formatCallResult, formatMcpStatus, formatToolCatalog, shapeCatalog, MUTATING_TOOLS, parseWorkspaces } from '../lib/tools-mcp.js'
import { resolveConfig } from '../lib/runner.js'

const TOOLS = [
  {
    name: 'XcodeOpenWorkspace',
    description: 'Opens an Xcode workspace or project at the given path and returns its workspace identifier.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'BuildProject',
    description: 'Builds an Xcode project and waits until the build completes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'RenderPreview',
    description: 'Builds and renders a Preview and waits until a snapshot of the resulting UI is available.\nMore detail here.',
    inputSchema: { type: 'object', properties: { sourceFilePath: { type: 'string' } }, required: ['sourceFilePath'] },
  },
  {
    name: 'XcodeWrite',
    description: 'Creates or overwrites files with content.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } }, required: ['filePath', 'content'] },
  },
]

/** A subprocess service whose children speak scripted MCP. */
function fakeSubprocess(handler) {
  const state = { spawns: 0, spec: null }
  const service = {
    state,
    async resolveExecutable(name) {
      return `/fake/${name}`
    },
    spawn(spec) {
      state.spawns += 1
      state.spec = spec
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let settle
      const done = new Promise((resolve) => {
        settle = resolve
      })
      const handle = {
        stdin,
        stdout,
        stderr,
        collected: {},
        done,
        terminate() {
          settle({ exitCode: 0, signal: null })
          stdout.end()
        },
        async waitForExit() {
          return true
        },
      }
      let buffer = ''
      stdin.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line.length > 0) handler(JSON.parse(line), (reply) => stdout.write(`${JSON.stringify(reply)}\n`), handle)
          newline = buffer.indexOf('\n')
        }
      })
      return handle
    },
  }
  return service
}

function fakeContext(subprocess) {
  return {
    get(service) {
      return service === 'subprocess' ? subprocess : undefined
    },
    logger: { warn() {} },
  }
}

/** Standard MCP server script: initialize, tools/list (two pages), tools/call. */
function standardHandler(callImpl) {
  return (message, reply) => {
    if (message.method === 'initialize') {
      reply({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'xcode-tools', version: '25464' },
          instructions: 'Request Xcode perform the action you specify.',
        },
      })
      return
    }
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return
    if (message.method === 'tools/list') {
      const cursor = message.params && message.params.cursor
      if (!cursor) {
        reply({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.slice(0, 2), nextCursor: 'page-2' } })
      } else {
        reply({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.slice(2) } })
      }
      return
    }
    if (message.method === 'tools/call') {
      callImpl(message, reply)
    }
  }
}

function baseConfig(overrides = {}) {
  return resolveConfig({ mcpToolCallTimeoutMs: 5000, ...overrides })
}

test('resolveConfig exposes bounded MCP defaults and rejects junk', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.mcpEnabled, true)
  assert.equal(defaults.mcpCommand, 'xcrun')
  assert.deepEqual(defaults.mcpArgs, ['mcpbridge'])
  assert.equal(defaults.mcpToolCallTimeoutMs, 600000)
  assert.equal(defaults.mcpAllowMutations, false)

  const tuned = resolveConfig({ mcpEnabled: false, mcpArgs: [' ', ''], mcpToolCallTimeoutMs: 1, mcpAllowMutations: 'yes' })
  assert.equal(tuned.mcpEnabled, false)
  assert.deepEqual(tuned.mcpArgs, ['mcpbridge'])
  assert.equal(tuned.mcpToolCallTimeoutMs, 1000)
  assert.equal(tuned.mcpAllowMutations, false)
})

test('McpLineDecoder survives split chunks, multiple messages per chunk and junk lines', () => {
  const messages = []
  const errors = []
  const decoder = new McpLineDecoder((message) => messages.push(message), (error) => errors.push(error))
  const whole = `${JSON.stringify({ id: 1, result: { ok: true } })}\n${JSON.stringify({ method: 'progress' })}\n`
  decoder.push('not json\n')
  decoder.push(whole.slice(0, 12))
  decoder.push(whole.slice(12))
  assert.equal(errors.length, 0)
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0], { id: 1, result: { ok: true } })
})

test('client initializes, paginates the tool catalog, and calls a tool', async () => {
  const subprocess = fakeSubprocess(
    standardHandler((message, reply) => {
      if (message.params.name === 'XcodeOpenWorkspace') {
        reply({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: '{"workspaceIdentifier":"workspace1"}' }] },
        })
        return
      }
      reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'done' }] } })
    }),
  )
  const ctx = fakeContext(subprocess)
  const client = createXcodeMcp(ctx, baseConfig())
  const tools = await client.ensure({ cwd: '/tmp' })
  assert.equal(tools.length, 4)
  assert.equal(client.describe().toolCount, 4)
  assert.equal(client.describe().server.name, 'xcode-tools')
  assert.equal(subprocess.state.spawns, 1)
  assert.deepEqual(subprocess.state.spec.argv, ['/fake/xcrun', 'mcpbridge'])
  assert.equal(subprocess.state.spec.stdio.stdin, 'pipe')

  const result = await client.callTool('XcodeOpenWorkspace', { path: '/tmp/Demo.xcodeproj' }, { cwd: '/tmp' })
  assert.equal(result.isError, false)
  assert.match(result.text, /workspace1/)
  client.dispose()
})

test('client reports a tool error result and serializes overlapping calls', async () => {
  const seen = []
  const subprocess = fakeSubprocess(
    standardHandler((message, reply) => {
      seen.push(message.params.name)
      const delay = message.params.name === 'BuildProject' ? 20 : 0
      setTimeout(() => {
        reply({
          jsonrpc: '2.0',
          id: message.id,
          result: message.params.name === 'BuildProject'
            ? { isError: true, content: [{ type: 'text', text: 'build failed: no scheme' }] }
            : { content: [{ type: 'text', text: 'ok' }] },
        })
      }, delay)
    }),
  )
  const client = createXcodeMcp(fakeContext(subprocess), baseConfig())
  const [first, second] = await Promise.all([
    client.callTool('BuildProject', {}, { cwd: '/tmp' }),
    client.callTool('RenderPreview', { sourceFilePath: '/tmp/A.swift' }, { cwd: '/tmp' }),
  ])
  assert.equal(first.isError, true)
  assert.match(first.text, /no scheme/)
  assert.equal(second.text, 'ok')
  // Serialized: the first request is fully answered before the second is sent.
  assert.deepEqual(seen, ['BuildProject', 'RenderPreview'])
  client.dispose()
})

test('client refuses to hang: a silent bridge times out', async () => {
  const subprocess = fakeSubprocess(standardHandler(() => {}))
  const client = createXcodeMcp(fakeContext(subprocess), baseConfig())
  await client.ensure({ cwd: '/tmp' })
  await assert.rejects(
    client.callTool('RenderPreview', { sourceFilePath: '/tmp/A.swift' }, { cwd: '/tmp', timeoutMs: 60 }),
    /timed out after 60ms/,
  )
  client.dispose()
})

test('client reconnect after the bridge exits', async () => {
  let calls = 0
  const subprocess = fakeSubprocess(
    standardHandler((message, reply) => {
      calls += 1
      if (calls === 1) {
        // Simulate transport death before answering.
        reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'first' }] } })
        return
      }
      reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'second' }] } })
    }),
  )
  const client = createXcodeMcp(fakeContext(subprocess), baseConfig())
  assert.equal((await client.callTool('BuildProject', {}, { cwd: '/tmp' })).text, 'first')
  client.dispose()
  const restarted = createXcodeMcp(fakeContext(subprocess), baseConfig())
  assert.equal((await restarted.callTool('BuildProject', {}, { cwd: '/tmp' })).text, 'second')
  assert.equal(subprocess.state.spawns, 2)
  restarted.dispose()
})

test('normalizeCallResult keeps text and image blocks only', () => {
  const result = normalizeCallResult({
    isError: false,
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      { type: 'audio', data: 'zzz' },
      { type: 'resource', resource: { text: 'resource text' } },
    ],
  })
  assert.equal(result.text, 'hello\n\nresource text')
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].mimeType, 'image/png')
})

test('catalog shaping filters by query and marks mutating tools', () => {
  const shaped = shapeCatalog(TOOLS, { query: 'preview' })
  assert.equal(shaped.total, 4)
  assert.equal(shaped.count, 1)
  assert.equal(shaped.tools[0].name, 'RenderPreview')
  assert.deepEqual(shaped.tools[0].required, ['sourceFilePath'])
  assert.equal(shaped.tools[0].mutating, false)

  const write = shapeCatalog(TOOLS, { query: 'write' })
  assert.equal(write.tools[0].mutating, true)
  assert.ok(MUTATING_TOOLS.has('XcodeWrite'))
  assert.equal(shapeCatalog(TOOLS, { limit: 2 }).count, 2)
})

test('summarizeTool keeps one short sentence', () => {
  assert.equal(
    summarizeTool({ description: 'Builds and renders a Preview and waits until a snapshot is available.\nSecond line.' }),
    'Builds and renders a Preview and waits until a snapshot is available.',
  )
  assert.ok(summarizeTool({ description: 'x'.repeat(300) }).length <= 110)
})

test('approval errors are recognized from Xcode text', () => {
  assert.equal(isApprovalRequired("This agent isn't approved to use Xcode's tools yet. Call XcodeOpenWorkspace first."), true)
  assert.equal(isApprovalRequired('build failed'), false)
})

test('parseWorkspaces accepts JSON in either shape', () => {
  assert.deepEqual(parseWorkspaces('{"workspaces":[{"identifier":"workspace1","path":"/tmp/A.xcodeproj"}]}'), [
    { identifier: 'workspace1', path: '/tmp/A.xcodeproj' },
  ])
  assert.deepEqual(parseWorkspaces('[{"id":"w2","filePath":"/tmp/B.xcworkspace"}]'), [{ identifier: 'w2', path: '/tmp/B.xcworkspace' }])
  assert.deepEqual(parseWorkspaces('* workspaceIdentifier: workspace1, workspacePath: /tmp/A.xcodeproj'), [
    { identifier: 'workspace1', path: '/tmp/A.xcodeproj' },
  ])
  assert.equal(parseWorkspaces('not json'), undefined)
})

test('gateway tools: status, catalog, approval and mutation guard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-dev-mcp-'))
  const config = baseConfig({ logDirectory: join(directory, 'logs') })
  const calls = []
  const fakeMcp = {
    async ensure() {
      return TOOLS
    },
    describe() {
      return { state: 'ready', server: { name: 'xcode-tools', version: '25464' }, protocolVersion: '2025-06-18', toolCount: 4, instructions: '' }
    },
    async listTools() {
      return TOOLS
    },
    async callTool(name, args, options) {
      calls.push({ name, args, options })
      if (name === 'RenderPreview') {
        return {
          isError: false,
          text: 'preview rendered',
          images: [{ mimeType: 'image/png', data: Buffer.from('fake-png').toString('base64') }],
        }
      }
      if (name === 'BuildProject') {
        return { isError: true, text: "This agent isn't approved to use Xcode's tools yet. Call XcodeOpenWorkspace first.", images: [] }
      }
      return { isError: false, text: 'ok', images: [] }
    },
  }
  const ctx = {
    get(service) {
      if (service === 'workingDirectory') return { defaultDirectory: directory }
      return undefined
    },
    logger: { warn() {} },
  }
  const tools = Object.fromEntries(createMcpTools(ctx, config, undefined, fakeMcp).map((tool) => [tool.name, tool]))
  const exec = { signal: undefined }

  const status = await tools.apple_dev_xcode_status.execute({}, exec)
  assert.equal(status.ok, true)
  assert.equal(status.toolCount, 4)
  assert.match(formatMcpStatus(status), /Xcode MCP: connected/)

  const catalog = await tools.apple_dev_xcode_tools.execute({ query: 'BuildProject' }, exec)
  assert.equal(catalog.count, 1)
  assert.equal(catalog.tools[0].name, 'BuildProject')
  assert.match(formatToolCatalog(catalog), /BuildProject/)

  const preview = await tools.apple_dev_xcode_call.execute(
    { tool: 'RenderPreview', arguments: { sourceFilePath: '/tmp/A.swift' } },
    exec,
  )
  assert.equal(preview.ok, true)
  assert.equal(preview.images.length, 1)
  const bytes = await readFile(preview.images[0].path)
  assert.equal(bytes.toString('utf8'), 'fake-png')
  assert.match(formatCallResult(preview), /Images:/)

  const blocked = await tools.apple_dev_xcode_call.execute({ tool: 'XcodeWrite', arguments: { filePath: '/tmp/A.swift', content: 'x' } }, exec)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'mutation_blocked')
  assert.equal(calls.some((call) => call.name === 'XcodeWrite'), false)

  const approval = await tools.apple_dev_xcode_call.execute({ tool: 'BuildProject' }, exec)
  assert.equal(approval.ok, false)
  assert.equal(approval.approvalRequired, true)
  assert.match(formatCallResult(approval), /XcodeOpenWorkspace/)

  const unknownAction = await tools.apple_dev_xcode_status.execute({ workspaces: true }, exec)
  assert.equal(unknownAction.ok, true)

  await rm(directory, { recursive: true, force: true })
})

test('gateway reports a disabled surface and mutation-enabled catalog', async () => {
  const disabled = createMcpTools({ get: () => undefined }, resolveConfig({ mcpEnabled: false }), undefined, {})
  const status = await disabled.find((tool) => tool.name === 'apple_dev_xcode_status').execute({}, {})
  assert.equal(status.ok, false)
  assert.match(status.error, /disabled/)

  const enabled = resolveConfig({ mcpAllowMutations: true })
  const tools = createMcpTools({ get: () => undefined }, enabled, undefined, {
    async listTools() {
      return TOOLS
    },
    describe() {
      return { state: 'ready', toolCount: 4 }
    },
  })
  const catalog = await tools.find((tool) => tool.name === 'apple_dev_xcode_tools').execute({}, {})
  assert.equal(catalog.mutatingAllowed, true)
})

test('call copies image artifacts referenced by path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-dev-artifact-'))
  const snapshot = join(directory, 'RenderPreview - line 27.png')
  await writeFile(snapshot, Buffer.from('png-bytes'))
  const config = baseConfig({ logDirectory: join(directory, 'logs') })
  const fakeMcp = {
    async listTools() {
      return TOOLS
    },
    describe() {
      return { state: 'ready', toolCount: 4 }
    },
    async callTool() {
      return { isError: false, text: JSON.stringify({ snapshot: { path: snapshot } }), images: [] }
    },
  }
  const ctx = {
    get(service) {
      return service === 'workingDirectory' ? { defaultDirectory: directory } : undefined
    },
  }
  const tool = createMcpTools(ctx, config, undefined, fakeMcp).find((entry) => entry.name === 'apple_dev_xcode_call')
  const result = await tool.execute({ tool: 'RenderPreview', arguments: {} }, {})
  assert.equal(result.ok, true)
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].source, snapshot)
  assert.equal((await readFile(result.images[0].path)).toString('utf8'), 'png-bytes')
  assert.deepEqual(collectImagePaths({ a: [{ b: '/tmp/x.png' }], c: 'no.png.txt' }), ['/tmp/x.png'])
  await rm(directory, { recursive: true, force: true })
})
