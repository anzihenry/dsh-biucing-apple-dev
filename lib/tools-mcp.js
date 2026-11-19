/**
 * Agent tools for Xcode's own MCP server.
 *
 * Xcode 27 exposes around fifty tools (workspaces, build/test, previews,
 * device interaction, project editing, String Catalogs, crash issues,
 * documentation search). Registering all of them as individual Harness tools
 * would cost roughly forty thousand tokens of schemas in every request — the
 * measured catalog is 54 tools / ~150 KB. So this surface is a gateway:
 *
 * - `apple_dev_xcode_status`  — is the bridge reachable, what is it, is approval pending
 * - `apple_dev_xcode_tools`   — compact, filterable catalog (name + args + one line)
 * - `apple_dev_xcode_call`    — call any Xcode MCP tool by name with JSON arguments
 *
 * Progressive disclosure keeps the standing context cost at three small
 * schemas while still reaching every Xcode capability. Mutating tools are
 * blocked unless the profile opts in, because these calls edit the user's
 * project files without any other confirmation step.
 */
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  clip,
  errorMessage,
  formatBytes,
  formatDuration,
  indent,
  plural,
  renderText,
  sections,
  tailLines,
} from './format.js'
import { platformProblem, resolveUserPath, sessionDirectory } from './runner.js'
import { approvalHint, isApprovalRequired, requiredParameters, summarizeTool } from './mcp.js'

/** Tools that change project files or settings; blocked unless `mcpAllowMutations` is true. */
export const MUTATING_TOOLS = new Set([
  'AddEntitlement',
  'AddInfoPlist',
  'LocalizationPlanner',
  'StringCatalogEdit',
  'UpdateFileCompilerFlags',
  'UpdateTargetBuildSetting',
  'XcodeMakeDir',
  'XcodeMV',
  'XcodeNewProject',
  'XcodeNewTarget',
  'XcodeRM',
  'XcodeUpdate',
  'XcodeWrite',
])

const IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic' }

/** Default limit for the catalog listing. */
const DEFAULT_TOOL_LIMIT = 80
const MAX_TOOL_LIMIT = 200

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

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function slug(value) {
  return String(value).replace(/[^\w.-]+/g, '-')
}

/** Compact catalog entry for one MCP tool. */
export function catalogEntry(tool) {
  return {
    name: tool.name,
    summary: summarizeTool(tool),
    required: requiredParameters(tool),
    mutating: MUTATING_TOOLS.has(tool.name),
  }
}

/** Filter and shape the catalog for `apple_dev_xcode_tools`. */
export function shapeCatalog(tools, { query = '', limit = DEFAULT_TOOL_LIMIT } = {}) {
  const list = Array.isArray(tools) ? tools : []
  const needle = query.trim().toLowerCase()
  const matched = needle.length === 0
    ? list
    : list.filter((tool) => {
        const haystack = `${tool.name} ${tool.description || ''}`.toLowerCase()
        return haystack.includes(needle)
      })
  const bounded = Math.min(MAX_TOOL_LIMIT, Math.max(1, Math.trunc(limit)))
  return {
    total: list.length,
    count: Math.min(matched.length, bounded),
    tools: matched.slice(0, bounded).map(catalogEntry),
  }
}

/** Text report for `apple_dev_xcode_status`. */
export function formatMcpStatus(value) {
  if (!value || typeof value !== 'object') return 'No Xcode MCP status was returned.'
  if (value.ok === false && value.error && !value.server) {
    return sections(
      'Xcode MCP: unavailable',
      value.error,
      value.hint ? `Hint: ${value.hint}` : '',
    )
  }
  const server = value.server || {}
  const lines = [
    `Xcode MCP: ${value.state === 'ready' ? 'connected' : value.state || 'unknown'}`,
    `Server: ${server.name || 'xcode-tools'}${server.version ? ` ${server.version}` : ''}${value.protocolVersion ? ` (protocol ${value.protocolVersion})` : ''}`,
    `Tools: ${plural(value.toolCount || 0, 'tool')}`,
    `Bridge: ${value.bridge ? `${value.bridge.command} ${(value.bridge.args || []).join(' ')}`.trim() : 'unknown'}`,
  ]
  if (value.instructions) lines.push(`Instructions: ${clip(value.instructions.replace(/\s+/g, ' '), 300)}`)
  const approval = value.approvalRequired ? 'pending' : value.approval
  if (approval === 'pending') {
    lines.push('', `Approval: pending — ${value.approvalHint || approvalHint()}`)
  } else if (approval === 'granted') {
    lines.push('', 'Approval: granted (a previous Xcode MCP call succeeded).')
  } else if (value.state === 'ready') {
    lines.push('', `Approval: not checked yet — ${approvalHint()}`)
  }
  if (Array.isArray(value.workspaces)) {
    lines.push('', 'Open workspaces:', indent(value.workspaces.length === 0 ? '(none)' : value.workspaces.map((workspace) => `${workspace.identifier || '?'} ${workspace.path || ''}`.trim()).join('\n')))
  }
  if (value.workspacesError) lines.push('', `Workspaces: ${value.workspacesError}`)
  if (value.exit && value.exit.detail) lines.push('', `Last exit: ${value.exit.detail}`)
  return clip(lines.join('\n'))
}

/** Text report for `apple_dev_xcode_tools`. */
export function formatToolCatalog(value) {
  if (!value || typeof value !== 'object') return 'No Xcode MCP tool catalog was returned.'
  if (value.ok === false) return sections('Xcode MCP tools unavailable', value.error || 'unknown error')
  const lines = [`Xcode MCP tools (${value.count} of ${value.total}${value.query ? ` matching "${value.query}"` : ''})`]
  for (const tool of value.tools || []) {
    const required = Array.isArray(tool.required) && tool.required.length > 0 ? ` (${tool.required.join(', ')})` : ''
    const mutation = tool.mutating ? ' [mutating]' : ''
    lines.push(`- ${tool.name}${required}${mutation}: ${tool.summary || 'no description'}`)
  }
  if (value.count < value.total) lines.push('', 'Refine with `query` or raise `limit` (max 200).')
  return clip(lines.join('\n'), 16000)
}

/** Text report for `apple_dev_xcode_call`. */
export function formatCallResult(value) {
  if (!value || typeof value !== 'object') return 'No Xcode MCP result was returned.'
  const header = `Xcode MCP ${value.tool || 'call'}${typeof value.durationMs === 'number' ? ` — ${value.ok ? 'ok' : 'failed'} in ${formatDuration(value.durationMs)}` : ''}`
  if (value.approvalRequired) {
    return sections(header, value.error || 'Xcode has not approved this agent yet.', `Next: ${value.approvalHint || approvalHint()}`)
  }
  if (value.code === 'mutation_blocked') return sections(header, value.error)
  const parts = [header]
  if (value.error) parts.push(`Error: ${value.error}`)
  if (value.text) parts.push(tailLines(value.text, 160))
  if (Array.isArray(value.images) && value.images.length > 0) {
    parts.push('Images:', indent(value.images.map((image) => `${image.path} (${image.mimeType || 'image'}, ${formatBytes(image.bytes || 0)})`).join('\n')))
  }
  if (value.logPath) parts.push(`Full output: ${value.logPath}`)
  return clip(sections(...parts))
}

/** Persist one base64 image next to the build logs and return its metadata. */
async function saveImage(cwd, logDirectory, toolName, image, index) {
  const extension = IMAGE_EXTENSIONS[image.mimeType] || 'bin'
  const directory = join(resolveUserPath(cwd, logDirectory), 'mcp')
  await mkdir(directory, { recursive: true })
  const file = join(directory, `${slug(toolName)}-${timestamp()}-${index}.${extension}`)
  const bytes = Buffer.from(image.data, 'base64')
  await writeFile(file, bytes)
  return { path: file, mimeType: image.mimeType, bytes: bytes.length }
}

/**
 * Collect image paths mentioned inside an MCP tool result.
 *
 * Xcode tools return artifacts as JSON paths rather than image blocks: a
 * preview snapshot is `{"snapshot":{"path":"/var/folders/.../RenderPreview/....png"}}`.
 * Those paths live in Xcode's temporary artifact directory and disappear, so
 * the gateway copies them into the plugin log directory and reports both.
 *
 * @param {unknown} value parsed JSON value or a plain path string.
 * @param {string[]} [out] accumulator.
 * @param {number} [depth] recursion bound.
 * @returns {string[]} absolute-ish path strings ending in an image extension.
 */
export function collectImagePaths(value, out = [], depth = 0) {
  if (depth > 4 || out.length >= 8) return out
  if (typeof value === 'string') {
    const candidate = value.trim()
    if (/^[^\n]+\.(png|jpe?g|gif|webp|heic)$/i.test(candidate)) out.push(candidate)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImagePaths(item, out, depth + 1)
    return out
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) collectImagePaths(value[key], out, depth + 1)
  }
  return out
}

/** Copy one artifact image into the plugin log directory; undefined when unreadable. */
async function copyArtifact(cwd, logDirectory, toolName, source) {
  try {
    const info = await stat(source)
    if (!info.isFile() || info.size === 0 || info.size > 32 * 1024 * 1024) return undefined
    const directory = join(resolveUserPath(cwd, logDirectory), 'mcp')
    await mkdir(directory, { recursive: true })
    const file = join(directory, `${slug(toolName)}-${basename(source).replace(/[^\w.-]+/g, '-')}`)
    if (file !== source) await copyFile(source, file)
    return { path: file, source, mimeType: source.toLowerCase().endsWith('.png') ? 'image/png' : 'image', bytes: info.size }
  } catch {
    return undefined
  }
}

/** Persist oversized tool text so the model can read it on demand. */
async function saveText(cwd, logDirectory, toolName, body) {
  const directory = resolveUserPath(cwd, logDirectory)
  await mkdir(directory, { recursive: true })
  const file = join(directory, `mcp-${slug(toolName)}-${timestamp()}.log`)
  await writeFile(file, body, 'utf8')
  return file
}

/** Parse JSON text when it is JSON; otherwise hand back the raw string. */
function safeJson(text) {
  if (typeof text !== 'string') return text
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    return JSON.parse(trimmed)
  } catch {
    return text
  }
}

function createStatusTool(ctx, config, mcp) {
  return {
    name: 'apple_dev_xcode_status',
    description:
      'Check the connection to Xcode\'s built-in MCP server (Xcode 26+): bridge command, server version, number of tools, open workspaces, and whether Xcode still needs to approve this agent. Call this before the first apple_dev_xcode_call, or when an Xcode MCP call fails.',
    parameters: {
      type: 'object',
      properties: {
        workspaces: {
          type: 'boolean',
          description: 'Also ask Xcode for its open workspaces (requires the one-time agent approval).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(formatMcpStatus(value)),
    },
    timeoutMs: 120000,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const problem = platformProblem()
      if (problem) return { tool: 'apple_dev_xcode_status', ok: false, error: problem }
      if (!config.mcpEnabled) {
        return { tool: 'apple_dev_xcode_status', ok: false, error: 'Xcode MCP is disabled: set mcpEnabled: true in the plugin config.' }
      }
      const cwd = sessionDirectory(ctx, exec)
      try {
        await mcp.ensure({ signal: exec.signal, cwd })
        const snapshot = mcp.describe()
        const report = {
          tool: 'apple_dev_xcode_status',
          ok: snapshot.state === 'ready',
          ...snapshot,
          bridge: { command: config.mcpCommand, args: config.mcpArgs },
          approvalHint: approvalHint(),
        }
        if (boolean(input.workspaces)) {
          try {
            const result = await mcp.callTool('XcodeListWorkspaces', {}, { signal: exec.signal, cwd })
            if (result.isError && isApprovalRequired(result.text)) {
              report.approvalRequired = true
              report.workspacesError = 'Xcode has not approved this agent yet.'
            } else if (result.isError) {
              report.workspacesError = clip(result.text || 'Xcode reported an error without text.', 400)
            } else {
              const parsed = parseWorkspaces(result.text)
              if (parsed) report.workspaces = parsed
              else report.workspacesError = clip(result.text || 'Xcode returned no workspace list.', 400)
            }
          } catch (error) {
            const message = errorMessage(error)
            if (isApprovalRequired(message)) {
              report.approvalRequired = true
              report.workspacesError = 'Xcode has not approved this agent yet.'
            } else {
              report.workspacesError = message
            }
          }
        }
        // The workspaces probe above is the first place approval state becomes visible.
        report.approval = mcp.describe().approval
        if (report.approval === 'pending') report.approvalRequired = true
        return report
      } catch (error) {
        const message = errorMessage(error)
        return {
          tool: 'apple_dev_xcode_status',
          ok: false,
          state: mcp.describe().state,
          error: message,
          hint: /mcpbridge|ENOENT|not found/i.test(message)
            ? 'Xcode 26 or later must be installed, and Xcode must be running (open -a Xcode) so the stdio bridge can reach it.'
            : 'Start Xcode, then retry. Set mcpEnabled: false to turn this surface off.',
        }
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Xcode MCP status', kind: 'other' }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result && result.ok ? 'Xcode MCP connected' : 'Xcode MCP unavailable',
      content: [{ type: 'text', text: formatMcpStatus(result) }],
    }),
  }
}

/**
 * Best-effort parse of Xcode's workspace listing, which arrives either as JSON
 * or as one bullet line per workspace ("* workspaceIdentifier: w1, workspacePath: /a").
 *
 * @param {string} body raw MCP text.
 * @returns {Array<{identifier: string, path: string}>|undefined} parsed entries.
 */
export function parseWorkspaces(body) {
  if (typeof body !== 'string' || body.trim().length === 0) return undefined
  try {
    const parsed = JSON.parse(body)
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.workspaces) ? parsed.workspaces : undefined
    if (list) {
      return list
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({ identifier: text(item.identifier || item.id), path: text(item.path || item.filePath) }))
    }
  } catch {
    /* fall through to the bullet format */
  }
  const entries = []
  for (const line of body.split(/\r?\n/)) {
    const bullet = /workspaceIdentifier:\s*([^,\s]+)[,\s]+workspacePath:\s*(.+?)\s*$/i.exec(line)
    if (bullet) {
      entries.push({ identifier: bullet[1].trim(), path: bullet[2].trim() })
      continue
    }
    const plain = /(?:^|[\s,])identifier:\s*([^,\s]+)[,\s]+path:\s*(.+?)\s*$/i.exec(line)
    if (plain) entries.push({ identifier: plain[1].trim(), path: plain[2].trim() })
  }
  return entries.length > 0 ? entries : undefined
}

function createToolsTool(ctx, config, mcp) {
  return {
    name: 'apple_dev_xcode_tools',
    description:
      'List the tools Xcode\'s MCP server exposes, as a compact catalog: name, required arguments, whether the tool mutates project files, and a one-line summary. Use `query` to search by name or description before calling apple_dev_xcode_call.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring to match against tool names and descriptions.' },
        limit: { type: 'number', description: `Maximum entries to return (default ${DEFAULT_TOOL_LIMIT}, max ${MAX_TOOL_LIMIT}).` },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(formatToolCatalog(value)),
    },
    timeoutMs: 120000,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const problem = platformProblem()
      if (problem) return { tool: 'apple_dev_xcode_tools', ok: false, error: problem }
      if (!config.mcpEnabled) return { tool: 'apple_dev_xcode_tools', ok: false, error: 'Xcode MCP is disabled: set mcpEnabled: true in the plugin config.' }
      try {
        const tools = await mcp.listTools({ signal: exec.signal, cwd: sessionDirectory(ctx, exec) })
        const shaped = shapeCatalog(tools, {
          query: text(input.query),
          limit: number(input.limit, DEFAULT_TOOL_LIMIT),
        })
        return { tool: 'apple_dev_xcode_tools', ok: true, query: text(input.query), ...shaped, mutatingAllowed: config.mcpAllowMutations }
      } catch (error) {
        return { tool: 'apple_dev_xcode_tools', ok: false, error: errorMessage(error) }
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'List Xcode MCP tools', description: args && typeof args === 'object' ? text(args.query) : undefined }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result && result.ok ? 'Xcode MCP tools' : 'Xcode MCP tools unavailable',
      content: [{ type: 'text', text: formatToolCatalog(result) }],
    }),
  }
}

function createCallTool(ctx, config, mcp) {
  return {
    name: 'apple_dev_xcode_call',
    description:
      'Call one tool on Xcode\'s MCP server by name. Use apple_dev_xcode_tools to discover names. Typical flow: XcodeOpenWorkspace (the first call shows Xcode\'s approval prompt), then BuildProject, RunAllTests, RenderPreview, DeviceInteractionStartWorkspaceSession + DeviceInteractionSynthesize (tap/type on a simulator), GetConsoleOutput, InvokeDebuggerCommand, or DocumentationSearch. Arguments are passed through as JSON exactly as the Xcode tool defines them. Project/file mutations are refused unless the profile sets mcpAllowMutations: true.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Exact Xcode MCP tool name, e.g. "BuildProject" or "RenderPreview".' },
        arguments: {
          type: 'object',
          description: 'JSON arguments for that tool, exactly as its schema defines them.',
          additionalProperties: true,
        },
        timeout_ms: { type: 'number', description: 'Per-call timeout (default from plugin config, usually 600000).' },
        save_images: { type: 'boolean', description: 'Save image content to .apple-dev/logs/mcp and return the paths (default true).' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(formatCallResult(value)),
    },
    timeoutMs: 1800000,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const problem = platformProblem()
      if (problem) return { tool: 'apple_dev_xcode_call', ok: false, error: problem }
      const name = text(input.tool).trim()
      if (name.length === 0) throw new Error('tool must be the name of an Xcode MCP tool; call apple_dev_xcode_tools to list them.')
      if (!config.mcpEnabled) return { tool: name, ok: false, error: 'Xcode MCP is disabled: set mcpEnabled: true in the plugin config.' }
      if (MUTATING_TOOLS.has(name) && !config.mcpAllowMutations) {
        return {
          tool: name,
          ok: false,
          code: 'mutation_blocked',
          error: `${name} changes project files or build settings, so it is refused while mcpAllowMutations is false. Set mcpAllowMutations: true in the biucing-apple-dev row of the profile's cordis.patch.yml and reload the plugin to allow project edits through Xcode MCP. Prefer editing files with the Harness file tools when you only need a text change.`,
        }
      }
      const cwd = sessionDirectory(ctx, exec)
      const startedAt = Date.now()
      try {
        const result = await mcp.callTool(name, input.arguments && typeof input.arguments === 'object' ? input.arguments : {}, {
          signal: exec.signal,
          cwd,
          timeoutMs: number(input.timeout_ms, config.mcpToolCallTimeoutMs),
        })
        const report = {
          tool: name,
          ok: !result.isError,
          isError: result.isError,
          text: result.text,
          structured: result.structured,
          durationMs: Date.now() - startedAt,
        }
        if (boolean(input.save_images, true)) {
          const saved = []
          for (const [index, image] of result.images.entries()) {
            try {
              saved.push(await saveImage(cwd, config.logDirectory, name, image, index))
            } catch (error) {
              report.imagesError = errorMessage(error)
            }
          }
          // Xcode returns most artifacts as JSON paths (preview snapshots,
          // device screenshots); copy those out of the temp directory too.
          for (const path of collectImagePaths(safeJson(result.text))) {
            const copied = await copyArtifact(cwd, config.logDirectory, name, path)
            if (copied) saved.push(copied)
          }
          if (saved.length > 0) report.images = saved
        }
        if (!report.ok) {
          const detail = result.text || 'Xcode reported an error without text.'
          if (isApprovalRequired(detail)) {
            report.approvalRequired = true
            report.approvalHint = approvalHint()
            report.error = 'Xcode has not approved this agent yet.'
          } else {
            report.error = clip(detail, 2000)
          }
        }
        if (typeof report.text === 'string' && report.text.length > 12000) {
          try {
            report.logPath = await saveText(cwd, config.logDirectory, name, report.text)
          } catch {
            /* the clipped text is still returned */
          }
        }
        return report
      } catch (error) {
        const message = errorMessage(error)
        if (isApprovalRequired(message)) {
          return {
            tool: name,
            ok: false,
            approvalRequired: true,
            approvalHint: approvalHint(),
            error: 'Xcode has not approved this agent yet.',
            durationMs: Date.now() - startedAt,
          }
        }
        return { tool: name, ok: false, error: message, durationMs: Date.now() - startedAt }
      }
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: `Xcode MCP: ${args && typeof args === 'object' ? text(args.tool, 'call') : 'call'}`,
    }),
    presentResult: (args, result) => ({
      card: 'terminal',
      title: result && result.ok ? `Xcode MCP ${text(args && args.tool)}` : `Xcode MCP ${text(args && args.tool)} failed`,
      output: clip(formatCallResult(result), 6000),
      exitCode: result && result.ok ? 0 : 1,
    }),
  }
}

/**
 * Register the Xcode MCP gateway tools.
 *
 * @param {object} ctx Host plugin context.
 * @param {object} config normalized config.
 * @param {Function} _runner unused; kept for factory signature parity.
 * @param {object} mcp client from `createXcodeMcp`.
 * @returns {object[]} tool definitions.
 */
export function createMcpTools(ctx, config, _runner, mcp) {
  return [createStatusTool(ctx, config, mcp), createToolsTool(ctx, config, mcp), createCallTool(ctx, config, mcp)]
}
