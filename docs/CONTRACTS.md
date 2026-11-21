# Internal contracts (plugin contributors)

This file is the integration contract for the modules of `dsh-biucing-apple-dev`.
Read it before editing `lib/`.

## Runtime shape

- Plain ESM JavaScript, Node >= 22. No build step, no dependencies: import only
  `node:*` builtins and sibling files. The Host resolves this package from the
  profile; a bare import of `@deepseek-ai/*` fails at load time.
- The plugin is a Cordis **Host** bundle. `index.js` exports `inject` and
  `apply(ctx, config)`.
- Every child process goes through the `subprocess` service. One-shot
  commands go through `lib/runner.js` `createRunner(ctx, config)`; never use
  `node:child_process`.
- The one long-lived child is the Xcode MCP bridge (`lib/mcp.js`). It uses
  `subprocess.spawn` with `stdio: { stdin: 'pipe', stdout: 'pipe', ... }` — the
  service's documented protocol-framing mode — and speaks newline-delimited
  JSON-RPC 2.0. It is spawned lazily on the first MCP tool call and disposed by
  the `ctx.effect` registered in `index.js`.
- Register resources inside `apply` with `ctx.effect(() => disposer)`.
- The macOS-only guard lives in `lib/runner.js` `platformProblem()`; every tool
  returns a readable `{ ok: false, ... }` result instead of throwing when the
  Host is not macOS.

## Tool factories

Each `lib/tools-*.js` exports one factory that receives `(ctx, config,
runner)` and returns tool definitions:

```js
export function createXxxTools(ctx, config, runner) {
  return [toolDefinition, ...]
}

// MCP gateway only: a fourth argument carries the lazily-connected client.
export function createMcpTools(ctx, config, runner, mcp) { ... }
```

`ctx` is the plugin context, `config` is the normalized config object from
`resolveConfig()` (`lib/runner.js`), `runner` is
`(argv, options) => Promise<CommandResult>`.

A tool definition is a plain object (no `defineTool` import):

```js
{
  name: 'apple_dev_example',                 // snake_case, unique
  description: 'One paragraph the model reads.',
  parameters: {                              // JSON Schema, model-facing
    type: 'object',
    properties: { /* ... */ },
    required: ['action'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (args, value) => [{ type: 'text', text: formatResult(value) }],
  },
  timeoutMs: 900000,                         // optional framework cap
  async execute(args, exec) {                // args is `unknown`
    const input = args && typeof args === 'object' ? args : {}
    // ... return a plain JSON-serializable value; never a class instance
  },
  presentCall: (args) => ({ card: 'terminal', title: '...', description: '...', cwd: '...' }), // optional
  presentResult: (args, result) => ({ card: 'terminal', title: '...', output: '...', exitCode: 0 }), // optional
}
```

Rules:

- `execute` receives `unknown`; validate and default every field explicitly.
  Invalid arguments: throw `new Error('readable message')`.
- Results are JSON values. The plugin wraps every registered tool with
  `losslessTool()` (`index.js`), which runs `toLosslessJson()` (`lib/format.js`)
  over the result: the Harness rejects a value that JSON cannot represent
  losslessly, so `undefined` properties, `NaN`/`Infinity`, `-0`, `Date`
  instances and cycles are normalized centrally. Do not re-implement this in a
  tool; a result may still omit an optional field instead of setting it to
  `undefined`, which keeps logs and the UI tidy. Always include `ok: boolean`; on failure include
  `error: string`. A non-zero `xcodebuild` exit is a **result** (`ok: false`),
  not a thrown tool error.
- Model-facing text is capped (`lib/format.js` `clip`, `tailLines`). Persist full
  logs with `saveLog()` (`lib/runner.js`) and report the path.
- Honour `exec.signal` by passing it to `runner(argv, { signal: exec.signal })`.
- Resolve paths against `sessionDirectory(ctx, exec)` with `resolveUserPath`.
- Side-effect-free registration: no process spawning at `apply` time.

## CommandResult (`runner`)
`{ ok, command, argv, cwd, exitCode, signal, timedOut, cancelled, spawnError,
stdout, stderr, stdoutTruncated, stderrTruncated, truncated, durationMs }`.
`run()` never throws for exit codes; it does throw for invalid argv.

## Routes consumed by `client.js`

`registerAppleDevRoutes(scope, config, runner, mcp)` in `lib/ui.js` owns both
routes (`scope` is the `webServer` inject scope; `mcp` is the optional
lazily-connected Xcode MCP client). The Client module must not add routes.

- `GET /dsh-biucing-apple-dev/status` →
  `{ ok: true, generatedAt: string, toolchain: {...}, simulators: [...],
     signing: { count: number, identities: string[] }, error?: string,
     xcodeMcp?: { state, server?, toolCount?, approval?, bridge?, error?, stale? } }`
  Simulators: `{ udid, name, platform, osVersion, state }`.
  `xcodeMcp` is present only when the route was registered with an MCP client.
  `state` is `connecting | ready | unavailable | disabled`; the route never
  waits for the bridge — it starts one bounded background probe (8 s) and
  serves the cached snapshot (15 s when ready, 30 s after a failure).
- `POST /dsh-biucing-apple-dev/action` body
  `{ action: 'boot'|'shutdown'|'open'|'erase', device: string }` (device is a
  UDID or exact device name) →
  `{ ok: boolean, message: string, error?: string, simulators?: [...] }`.
  MCP actions share the same route: `{ action: 'mcp_reconnect' }` resets the
  bridge and starts a probe, and `{ action: 'mcp_open_workspace', path: string }`
  validates an absolute `.xcodeproj`/`.xcworkspace` path (or `~/...`), calls
  `XcodeOpenWorkspace` with a 120 s deadline, and returns the MCP status.
  Both are refused when `mcpEnabled` is false. Same-origin only; never expose a
  generic command endpoint.

## Shared functions

- `lib/runner.js`: `resolveConfig`, `createRunner`, `resolveUserPath`,
  `sessionDirectory`, `isInsideDirectory`, `resolveExecutable`, `hasExecutable`,
  `saveLog`, `assertSucceeded`, `summarizeResult`, `platformProblem`, `nowIso`.
- `lib/format.js`: `clip`, `tailLines`, `indent`, `plural`, `formatDuration`,
  `formatBytes`, `renderText`, `bulletList`, `sections`, `errorMessage`.
- `lib/mcp.js` (owned by the Lead): `createXcodeMcp`, `XcodeMcpClient`,
  `McpLineDecoder`, `McpError`, `isApprovalRequired`, `approvalHint`,
  `normalizeCallResult`, `summarizeTool`, `requiredParameters`.
- `lib/tools-mcp.js` (owned by the Lead): `createMcpTools`, `MUTATING_TOOLS`,
  `shapeCatalog`, `parseWorkspaces`, and the three report formatters.
- `lib/device.js` (owned by the Lead): `DEVICE_ACTIONS`, devicectl argv builders,
  `parseDeviceList`, `parseDeviceDetails`, `parseApps`, `parseProcesses`,
  `selectDevice`, `filterApps`, `parseDevicectlJson`.
- `lib/crash.js` (owned by the Lead): `parseIps`, `crashFacts`,
  `collectThreads`, `collectDsymBinaries`, `symbolicateReport`,
  `formatSymbolicatedReport`, `readCrashText`.
- `lib/visual.js` (owned by the Lead): `parseBmp`, `encodeBmp`, `compareRgb`,
  `visualPaths`, `storeCapture`, `approveBaseline`, `listVisualEntries`,
  `pngToBmp`, `bmpToPng`, `loadPngPixels`.
- `lib/release.js` (owned by the Lead): `buildArchiveArgv`, `buildExportArgv`,
  `buildExportOptionsPlist`, `buildLaneArgv`, `parseReleaseOutput`,
  `parseLanes`, `findFastlaneRoot`, `latestArchive`, `findIpa`.
- `lib/env.js` (owned by the Lead): `readToolchain`, parsing helpers,
  `listXcodes`, `parseSimulatorList`.
- `lib/simulator.js` (owned by the Lead): `listSimulators`, `boot`, `shutdown`,
  `erase`, `openSimulator`, `installApp`, `launchApp`, `terminateApp`,
  `screenshot`, `appContainer`, `resolveDevice`.

## Module ownership

One owner per file, so concurrent changes never collide:

| Area | Files |
| --- | --- |
| Plugin shell, environment and simulators | `index.js`, `lib/runner.js`, `lib/format.js`, `lib/env.js`, `lib/simulator.js`, `lib/tools-env.js`, `lib/ui.js`, `locale/*`, `icon.svg`, `README.md`, `package.json`, `cordis.patch.yml` |
| Xcode MCP gateway | `lib/mcp.js`, `lib/tools-mcp.js`, `test/mcp.test.mjs` |
| Physical devices | `lib/device.js`, `lib/tools-device.js`, `test/device.test.mjs` |
| Crash symbolication | `lib/crash.js`, `test/crash.test.mjs` |
| Visual regression | `lib/visual.js`, `lib/tools-visual.js`, `test/visual.test.mjs` |
| Release (archive/export/fastlane) | `lib/release.js`, `lib/tools-release.js`, `test/release.test.mjs` |
| Project inspection, build and test | `lib/project.js`, `lib/build.js`, `lib/test.js`, `lib/tools-project.js` |
| Diagnostics: signing and logs | `lib/signing.js`, `lib/logs.js`, `lib/tools-diag.js` |
| Settings page (Client half) | `client.js` |

Installation and verification are Lead steps: contributors validate with
`node --check <file>` and `node --test` and do not run Plugin Manager
operations. After editing files of an already-installed bundle, a Plugin
Manager disable/enable of the row triggers an HMR recomposition that loads the
changed modules without restarting the Host.
