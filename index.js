/**
 * Host half of the Apple Dev bundle.
 *
 * Registers the agent tools that discover the Xcode toolchain, inspect
 * projects, build, test, drive simulators, read logs/crashes, inspect code
 * signing and call Xcode's own MCP tools — plus the two loopback JSON routes
 * the "Apple Dev" settings page calls. The settings page is a Client module
 * (`client.js`); every capability it uses exists as a tool too, so the same
 * operation has one implementation.
 *
 * All child processes go through the Host `subprocess` service
 * (`lib/runner.js`); this package imports no other runtime package.
 */
import { toLosslessJson } from './lib/format.js'
import { resolveConfig, createRunner } from './lib/runner.js'
import { createEnvTools } from './lib/tools-env.js'
import { createProjectTools } from './lib/tools-project.js'
import { createDiagTools } from './lib/tools-diag.js'
import { createMcpTools } from './lib/tools-mcp.js'
import { createXcodeMcp } from './lib/mcp.js'
import { registerAppleDevRoutes } from './lib/ui.js'

/** The registry every tool registers into, and the process seam they run on. */
export const inject = ['tools', 'subprocess']

/**
 * Wrap one tool so its result is lossless JSON.
 *
 * Tool results are parsed command output; a property that is present but
 * `undefined` (an `error` on success, a missing device timestamp) makes the
 * whole result unrepresentable and the registry answers
 * "returned invalid output: value is not lossless JSON". Normalizing here is
 * the single boundary for every tool, including future ones.
 *
 * @param {object} tool plain tool definition.
 * @returns {object} the same definition with a normalizing `execute`.
 */
export function losslessTool(tool) {
  if (!tool || typeof tool.execute !== 'function') return tool
  return {
    ...tool,
    async execute(args, exec) {
      const value = await tool.execute.call(tool, args, exec)
      const normalized = toLosslessJson(value)
      return normalized === undefined ? null : normalized
    },
  }
}

/**
 * Register the Apple Dev capability surface.
 *
 * @param {object} ctx Cordis plugin context.
 * @param {object} config Raw row config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const runner = createRunner(ctx, resolved)
  // One lazily-connected MCP bridge per plugin instance. Disposal terminates
  // the managed child process range, so a plugin reload never leaves an
  // orphan bridge attached to Xcode.
  const mcp = createXcodeMcp(ctx, resolved)
  ctx.effect(() => () => mcp.dispose())
  const factories = [
    createEnvTools,
    createProjectTools,
    createDiagTools,
    (scope, cfg, run) => (cfg.mcpEnabled ? createMcpTools(scope, cfg, run, mcp) : []),
  ]

  for (const factory of factories) {
    let tools = []
    try {
      tools = factory(ctx, resolved, runner) || []
    } catch (error) {
      // A broken tool group must not take the whole plugin (and the other
      // groups) down with it; the error is attributed to that group.
      ctx.logger?.warn?.('biucing-apple-dev: a tool group failed to register: %s', String(error))
      continue
    }
    for (const tool of tools) ctx.effect(() => ctx.tools.register(losslessTool(tool)))
  }

  // Optional UI surface: a profile without a web server still gets every tool.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => registerAppleDevRoutes(scope, resolved, runner, mcp))
  })
}
