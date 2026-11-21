/**
 * Xcode MCP client: JSON-RPC 2.0 over Xcode's stdio bridge (`xcrun mcpbridge`).
 *
 * Xcode 26+ ships an MCP server that exposes the IDE's own capabilities —
 * workspaces, build, run, tests, previews, device interaction, project and
 * String Catalog editing, documentation search — as tools. The bridge is a
 * long-lived child process speaking newline-delimited JSON-RPC on stdin/stdout.
 *
 * The process still goes through the Host `subprocess` service. Its `pipe`
 * stdio mode exists for exactly this case (the service documents JSON-RPC as
 * the protocol-framing consumer), so this module never imports
 * `node:child_process`; the service keeps ownership of the process range,
 * environment scrubbing and termination.
 *
 * Everything here is lazy: no process starts at plugin load. The first tool
 * call connects, initializes, and caches the tool catalog.
 */
import { StringDecoder } from 'node:string_decoder'
import { errorMessage } from './format.js'

/** MCP protocol version spoken by the SDK generation this client targets. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'
/** Stable identity Xcode keys agent approval on; do not change casually. */
export const MCP_CLIENT_INFO = Object.freeze({ name: 'dsh-biucing-apple-dev', version: '0.5.0' })
/** A single JSON-RPC line larger than this means the bridge is not speaking the protocol. */
const MAX_LINE_BYTES = 32 * 1024 * 1024
/** Retained bridge stderr, reported when a call fails for an opaque reason. */
const MAX_STDERR_CHARS = 8000

/** A failure attributable to one stage of the MCP exchange. */
export class McpError extends Error {
  /**
   * @param {string} message readable text, safe to show the model.
   * @param {object} [options] stage, tool, cause.
   */
  constructor(message, { stage = 'unknown', tool, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'McpError'
    this.stage = stage
    if (tool !== undefined) this.tool = tool
  }
}

/** True when Xcode answered "this agent is not approved yet". */
export function isApprovalRequired(value) {
  const text = typeof value === 'string' ? value : errorMessage(value)
  return /isn't approved to use Xcode's tools yet/i.test(text)
}

/** The one action that makes Xcode show its approval prompt. */
export function approvalHint() {
  return [
    'If Xcode reports that this agent is not approved, call apple_dev_xcode_call with',
    'tool "XcodeOpenWorkspace" and arguments {"path": "<absolute .xcodeproj or .xcworkspace>"}.',
    'Opening a workspace is what makes Xcode ask the user to approve this agent and the folder;',
    'one approval is reused by later calls and survives plugin reloads.',
  ].join(' ')
}

/** One in-memory JSON-RPC message reader over arbitrary chunk boundaries. */
export class McpLineDecoder {
  /**
   * @param {(message: object) => void} onMessage parsed JSON-RPC message.
   * @param {(error: McpError) => void} onError framing failure (the stream is unusable).
   */
  constructor(onMessage, onError) {
    this.onMessage = onMessage
    this.onError = onError
    this.decoder = new StringDecoder('utf8')
    this.buffer = ''
    this.failed = false
  }

  /** Feed one stdout chunk. */
  push(chunk) {
    if (this.failed) return
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) this.#parse(line)
      newline = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.failed = true
      this.onError(new McpError(`Xcode MCP bridge produced a line larger than ${MAX_LINE_BYTES} bytes; it is not speaking JSON-RPC.`, { stage: 'protocol' }))
    }
  }

  /** Flush a trailing partial line at stream end. */
  end() {
    if (this.failed) return
    const line = this.buffer.trim()
    this.buffer = ''
    if (line.length > 0) this.#parse(line)
  }

  #parse(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      // A non-JSON line is a bridge diagnostic, not a protocol message.
      return
    }
    if (message && typeof message === 'object') this.onMessage(message)
  }
}

/**
 * Create the one MCP client a plugin instance owns.
 *
 * @param {object} ctx Host plugin context (needs the `subprocess` service).
 * @param {object} config normalized config from `resolveConfig`.
 * @returns {XcodeMcpClient} lazily-connected client.
 */
export function createXcodeMcp(ctx, config) {
  return new XcodeMcpClient(ctx, config)
}

/** Lazily connected, serialized MCP client for one Xcode bridge process. */
export class XcodeMcpClient {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.state = 'idle'
    this.handle = null
    this.decoder = null
    this.nextId = 0
    this.pending = new Map()
    this.tools = null
    this.server = null
    this.instructions = ''
    this.connecting = null
    this.stderrTail = ''
    this.exit = null
    this.approval = 'unknown'
    this.closed = false
    this.queue = Promise.resolve()
  }

  /** Cached server identity and catalog size, for status rendering. */
  describe() {
    return {
      state: this.state,
      server: this.server,
      protocolVersion: MCP_PROTOCOL_VERSION,
      toolCount: Array.isArray(this.tools) ? this.tools.length : 0,
      instructions: this.instructions,
      approval: this.approval,
      exit: this.exit,
    }
  }

  /**
   * Connect if needed and return the cached tool catalog.
   *
   * @param {object} [options] signal and cwd for the spawned bridge.
   * @returns {Promise<Array<object>>} MCP tool definitions.
   */
  async ensure({ signal, cwd } = {}) {
    if (this.closed) throw new McpError('The Xcode MCP client was disposed.', { stage: 'closed' })
    if (this.state === 'ready' && this.handle) return this.tools
    if (!this.connecting) {
      this.connecting = this.#connect({ signal, cwd }).finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  /** The tool catalog, connecting when necessary. */
  async listTools(options = {}) {
    return this.ensure(options)
  }

  /**
   * Call one MCP tool. Calls are serialized because one Xcode window serves
   * one active scheme/destination at a time; overlapping calls would interleave
   * their run destinations.
   *
   * @param {string} name raw MCP tool name.
   * @param {object} args tool arguments.
   * @param {object} [options] signal, timeoutMs, cwd.
   * @returns {Promise<{isError: boolean, text: string, images: Array<object>}>} normalized result.
   */
  async callTool(name, args, { signal, timeoutMs, cwd } = {}) {
    await this.ensure({ signal, cwd })
    const run = this.queue.then(() => this.#callOnce(name, args, { signal, timeoutMs }))
    // Keep the chain alive after a failure without leaking it to callers.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Tear down the current bridge but keep the client usable: the next call
   * spawns a fresh bridge. Used by the settings page's reconnect button.
   */
  reconnect() {
    if (this.closed) return
    const handle = this.handle
    this.handle = null
    this.state = 'idle'
    this.server = null
    this.tools = null
    this.approval = 'unknown'
    this.exit = null
    this.#rejectPending(new McpError('The Xcode MCP bridge was reset for reconnect.', { stage: 'reset' }))
    try {
      handle?.terminate?.()
    } catch {
      /* the provider already stopped it */
    }
  }

  /** Terminate the bridge and reject anything still pending. */
  dispose() {
    this.closed = true
    this.state = 'closed'
    const handle = this.handle
    this.handle = null
    this.#rejectPending(new McpError('The Xcode MCP client was disposed.', { stage: 'closed' }))
    if (handle) {
      try {
        handle.terminate()
      } catch {
        /* the provider already stopped it */
      }
    }
  }

  async #connect({ signal, cwd }) {
    const subprocess = this.ctx.get('subprocess')
    if (!subprocess || typeof subprocess.spawn !== 'function') {
      throw new McpError('The Host subprocess service is unavailable; Xcode MCP needs it.', { stage: 'spawn' })
    }
    let executable
    try {
      executable = await subprocess.resolveExecutable(this.config.mcpCommand, undefined, signal)
    } catch (error) {
      throw new McpError(
        `Could not resolve \`${this.config.mcpCommand}\`: ${errorMessage(error)}. Xcode 26+ installs the MCP bridge (mcpbridge); install or select that Xcode, or set mcpCommand.`,
        { stage: 'spawn', cause: error },
      )
    }
    const env = this.config.developerDir.length > 0 ? { DEVELOPER_DIR: this.config.developerDir } : undefined
    let handle
    try {
      handle = subprocess.spawn({
        argv: [executable, ...this.config.mcpArgs],
        cwd: cwd || process.cwd(),
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: 64 * 1024, spill: { maxBytes: 1024 * 1024 } },
        },
        graceMs: 5000,
        env,
      })
    } catch (error) {
      throw new McpError(`Could not start the Xcode MCP bridge: ${errorMessage(error)}`, { stage: 'spawn', cause: error })
    }
    if (!handle || !handle.stdin || !handle.stdout) {
      try {
        handle?.terminate?.()
      } catch {
        /* ignore */
      }
      throw new McpError('The Host subprocess service did not provide piped stdio for the Xcode MCP bridge.', { stage: 'spawn' })
    }

    this.handle = handle
    this.state = 'connecting'
    this.stderrTail = ''
    this.decoder = new McpLineDecoder(
      (message) => this.#onMessage(message),
      (error) => this.#fail(error),
    )
    handle.stdout.on('data', (chunk) => this.decoder.push(chunk))
    if (handle.stderr) handle.stderr.on('data', (chunk) => this.#onStderr(chunk))
    Promise.resolve(handle.done).then(
      (outcome) => this.#onExit(undefined, outcome),
      (error) => this.#onExit(error, undefined),
    )

    try {
      const result = await this.#request(
        'initialize',
        { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO },
        { timeoutMs: this.config.mcpStartupTimeoutMs, stage: 'initialize' },
      )
      this.server = result && typeof result.serverInfo === 'object' ? result.serverInfo : null
      this.instructions = result && typeof result.instructions === 'string' ? result.instructions : ''
      this.#notify('notifications/initialized')
      const tools = await this.#listAllTools()
      if (this.state !== 'connecting' || !this.handle) {
        throw new McpError('The Xcode MCP bridge exited during initialization.', { stage: 'initialize' })
      }
      this.tools = tools
      this.state = 'ready'
      this.exit = null
      return tools
    } catch (error) {
      const wrapped =
        error instanceof McpError ? error : new McpError(`Xcode MCP initialization failed: ${errorMessage(error)}`, { stage: 'initialize', cause: error })
      this.#fail(wrapped)
      throw wrapped
    }
  }

  async #listAllTools() {
    const tools = []
    let cursor
    for (let page = 0; page < 16; page += 1) {
      const params = cursor === undefined ? {} : { cursor }
      const result = await this.#request('tools/list', params, {
        timeoutMs: this.config.mcpStartupTimeoutMs,
        stage: 'list',
      })
      const pageTools = Array.isArray(result?.tools) ? result.tools : []
      tools.push(...pageTools.filter((tool) => tool && typeof tool.name === 'string'))
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined
      if (cursor === undefined) return tools
    }
    return tools
  }

  async #callOnce(name, args, { signal, timeoutMs }) {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    let result
    try {
      result = await this.#request(
        'tools/call',
        { name, arguments: input },
        { signal, tool: name, timeoutMs: timeoutMs ?? this.config.mcpToolCallTimeoutMs, stage: 'call' },
      )
    } catch (error) {
      throw error instanceof McpError ? error : new McpError(`Xcode MCP call \`${name}\` failed: ${errorMessage(error)}`, { stage: 'call', tool: name, cause: error })
    }
    const normalized = normalizeCallResult(result)
    if (normalized.isError && isApprovalRequired(normalized.text)) this.approval = 'pending'
    else if (!normalized.isError) this.approval = 'granted'
    return normalized
  }

  #notify(method, params = {}) {
    this.#write({ jsonrpc: '2.0', method, ...(Object.keys(params).length > 0 ? { params } : {}) })
  }

  #write(message) {
    const stdin = this.handle && this.handle.stdin
    if (!stdin) throw new McpError('The Xcode MCP bridge is not running.', { stage: 'write' })
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  #request(method, params, { timeoutMs = this.config.mcpStartupTimeoutMs, signal, tool, stage = 'request' } = {}) {
    if (this.closed) return Promise.reject(new McpError('The Xcode MCP client was disposed.', { stage: 'closed', tool }))
    if (!this.handle) return Promise.reject(new McpError('The Xcode MCP bridge is not running.', { stage: 'write', tool }))
    if (signal?.aborted) return Promise.reject(new McpError('The Xcode MCP call was cancelled before it started.', { stage: 'cancelled', tool }))

    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.#cancel(id, `timed out after ${timeoutMs}ms`)
        reject(new McpError(`Xcode MCP ${method} timed out after ${timeoutMs}ms.`, { stage: 'timeout', tool }))
      }, Math.max(1, timeoutMs))
      timer.unref?.()

      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        this.#cancel(id, 'cancelled')
        reject(new McpError('The Xcode MCP call was cancelled.', { stage: 'cancelled', tool }))
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })

      try {
        this.#write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof McpError ? error : new McpError(`Could not write to the Xcode MCP bridge: ${errorMessage(error)}`, { stage: 'write', tool }))
      }
    })
  }

  #cancel(id, reason) {
    try {
      this.#notify('notifications/cancelled', { requestId: id, reason })
    } catch {
      /* the bridge is already gone; nothing to cancel */
    }
  }

  #onMessage(message) {
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pending.get(message.id)
      if (pending) {
        this.pending.delete(message.id)
        if (message.error) {
          const detail = message.error.message || message.error.code || 'unknown error'
          pending.reject(new McpError(`Xcode MCP error: ${detail}`, { stage: 'call' }))
        } else {
          pending.resolve(message.result)
        }
        return
      }
      // A server-initiated request we do not implement: answer, never hang.
      if (typeof message.method === 'string') {
        this.#write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not supported by dsh-biucing-apple-dev: ${message.method}` },
        })
      }
      return
    }
    // Notifications (progress, logs, tool list changes) need no action here.
  }

  #onStderr(chunk) {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
    if (text.length === 0) return
    this.stderrTail = `${this.stderrTail}${text}`.slice(-MAX_STDERR_CHARS)
  }

  #onExit(error, outcome) {
    const detail = error ? errorMessage(error) : `exit ${outcome?.exitCode ?? 'unknown'}${outcome?.signal ? ` (${outcome.signal})` : ''}`
    this.exit = { detail, stderr: this.stderrTail.trim() || undefined, at: new Date().toISOString() }
    const wasReady = this.state === 'ready'
    this.state = 'closed'
    this.handle = null
    this.rejectInFlight(new McpError(`The Xcode MCP bridge stopped (${detail}).${this.stderrTail.trim() ? ` stderr: ${this.stderrTail.trim()}` : ''}`, { stage: 'exited' }), wasReady)
  }

  #fail(error) {
    const handle = this.handle
    this.state = 'closed'
    this.handle = null
    try {
      handle?.terminate?.()
    } catch {
      /* ignore */
    }
    this.rejectInFlight(error, false)
  }

  #rejectPending(error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(error)
    }
  }

  /** Reject pending requests; when a ready bridge dies, keep the error for the next call. */
  rejectInFlight(error, _wasReady) {
    this.#rejectPending(error)
    this.tools = null
  }
}

/** Convert one MCP `tools/call` result into model-facing text and images. */
export function normalizeCallResult(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const texts = []
  const images = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
      continue
    }
    if (block.type === 'image' && typeof block.data === 'string' && block.data.length > 0) {
      images.push({ mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png', data: block.data })
      continue
    }
    if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
      if (typeof block.resource.text === 'string') texts.push(block.resource.text)
      continue
    }
  }
  return {
    isError: result?.isError === true,
    text: texts.join('\n\n').trim(),
    images,
    structured: result?.structuredContent,
  }
}

/** One-line summary from an MCP tool description (first sentence, bounded). */
export function summarizeTool(tool) {
  const description = typeof tool?.description === 'string' ? tool.description : ''
  const firstLine = description.split(/\r?\n/).find((line) => line.trim().length > 0) || ''
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] || firstLine
  const text = sentence.replace(/\s+/g, ' ').trim()
  return text.length > 110 ? `${text.slice(0, 107)}…` : text
}

/** Required parameter names for one MCP tool definition. */
export function requiredParameters(tool) {
  const required = tool?.inputSchema?.required
  return Array.isArray(required) ? required.filter((name) => typeof name === 'string') : []
}
