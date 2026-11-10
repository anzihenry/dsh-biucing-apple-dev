/**
 * Xcode project / Swift package discovery and the parsers behind the
 * `apple_dev_project` tool.
 *
 * Everything here is pure except {@link discoverProjects}, which walks a
 * directory. Keeping the parsers pure means the tool layer can be tested
 * against captured `xcodebuild` / `swift package` output without a toolchain.
 */
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'

/** Preference order when a directory contains several project containers. */
export const PROJECT_KIND_PRIORITY = Object.freeze({ workspace: 0, project: 1, package: 2 })

/** Directories a project search never descends into. */
export const IGNORED_DIRECTORIES = Object.freeze([
  'build',
  '.build',
  'DerivedData',
  'Pods',
  'Carthage',
  'node_modules',
  '.git',
  '.swiftpm',
  '.apple-dev',
  'vendor',
])

/** Build settings worth showing the model; the full dictionary is huge. */
export const BUILD_SETTING_KEYS = Object.freeze([
  'CONFIGURATION',
  'PRODUCT_NAME',
  'PRODUCT_BUNDLE_IDENTIFIER',
  'PRODUCT_MODULE_NAME',
  'PRODUCT_TYPE',
  'FULL_PRODUCT_NAME',
  'WRAPPER_NAME',
  'EXECUTABLE_NAME',
  'BUILT_PRODUCTS_DIR',
  'TARGET_BUILD_DIR',
  'CONFIGURATION_BUILD_DIR',
  'CODE_SIGN_IDENTITY',
  'CODE_SIGN_STYLE',
  'CODE_SIGNING_REQUIRED',
  'DEVELOPMENT_TEAM',
  'PROVISIONING_PROFILE_SPECIFIER',
  'SDKROOT',
  'SUPPORTED_PLATFORMS',
  'IPHONEOS_DEPLOYMENT_TARGET',
  'MACOSX_DEPLOYMENT_TARGET',
  'TVOS_DEPLOYMENT_TARGET',
  'WATCHOS_DEPLOYMENT_TARGET',
  'XROS_DEPLOYMENT_TARGET',
  'SWIFT_VERSION',
  'MARKETING_VERSION',
  'CURRENT_PROJECT_VERSION',
  'INFOPLIST_FILE',
  'TARGET_NAME',
])

/**
 * Classify one path from its name alone.
 *
 * A `.xcodeproj`/`.xcworkspace` is returned as-is; `Package.swift` is folded
 * into its package directory, because `swift build --package-path` wants the
 * directory. Returns `undefined` for any other path.
 *
 * @param {string} path
 * @returns {{ kind: 'workspace'|'project'|'package', name: string, path: string, manifestPath?: string }|undefined}
 */
export function projectKindForPath(path) {
  const value = typeof path === 'string' ? path.trim() : ''
  if (value.length === 0) return undefined
  const trimmed = value.replace(/[/\\]+$/, '')
  if (trimmed.length === 0) return undefined
  const name = basename(trimmed)
  if (name.endsWith('.xcworkspace')) {
    return { kind: 'workspace', name: name.slice(0, -'.xcworkspace'.length), path: trimmed }
  }
  if (name.endsWith('.xcodeproj')) {
    return { kind: 'project', name: name.slice(0, -'.xcodeproj'.length), path: trimmed }
  }
  if (name === 'Package.swift') {
    const directory = dirname(trimmed)
    return { kind: 'package', name: basename(directory) || 'package', path: directory, manifestPath: trimmed }
  }
  return undefined
}

/**
 * Find and parse the first JSON value in arbitrary command output.
 *
 * `xcodebuild -list -json` and `swift package describe` can print warnings
 * before their JSON body, and `xcodebuild` sometimes keeps printing after it.
 * Scanning for the first `{`/`[` and matching its closing bracket isolates the
 * payload without guessing line positions.
 *
 * @param {string} text
 * @returns {any|undefined} parsed JSON value, or undefined when there is none.
 */
export function extractJson(text) {
  const value = typeof text === 'string' ? text : ''
  const start = value.search(/[[{]/)
  if (start < 0) return undefined
  const open = value[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === open) depth += 1
    else if (character === close) {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(value.slice(start, index + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length > 0) : []
}

function uniqueStrings(...groups) {
  const seen = new Set()
  const result = []
  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      if (typeof item !== 'string' || item.length === 0) continue
      if (seen.has(item)) continue
      seen.add(item)
      result.push(item)
    }
  }
  return result
}

/**
 * Parse `xcodebuild -list -json` output.
 *
 * Handles both the project shape (`{"project": {...}}`) and the workspace
 * shape (`{"workspace": {...}}`, sometimes with a sibling `project` block).
 *
 * @param {string} text
 * @returns {{ kind?: string, name?: string, schemes: string[], targets: string[], configurations: string[], projects: object[] }|undefined}
 */
export function parseXcodebuildList(text) {
  const payload = extractJson(text)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const blocks = []
  const addBlock = (kind, block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return
    blocks.push({
      kind,
      name: typeof block.name === 'string' && block.name.length > 0 ? block.name : undefined,
      schemes: stringList(block.schemes),
      targets: stringList(block.targets),
      configurations: stringList(block.configurations),
    })
  }
  addBlock('workspace', payload.workspace)
  addBlock('project', payload.project)
  if (Array.isArray(payload.projects)) {
    for (const project of payload.projects) addBlock('project', project)
  }
  const topSchemes = stringList(payload.schemes)
  if (blocks.length === 0 && topSchemes.length === 0) return undefined
  const kind = blocks.some((block) => block.kind === 'workspace')
    ? 'workspace'
    : blocks[0] && blocks[0].kind
  const name =
    (blocks.find((block) => block.kind === 'workspace' && block.name) || {}).name ||
    (blocks.find((block) => block.name) || {}).name
  return {
    kind,
    name,
    schemes: uniqueStrings(...blocks.map((block) => block.schemes), topSchemes),
    targets: uniqueStrings(...blocks.map((block) => block.targets)),
    configurations: uniqueStrings(...blocks.map((block) => block.configurations)),
    projects: blocks,
  }
}

const LIST_SECTION = /^(Targets|Build Configurations|Schemes):\s*$/

/**
 * Parse the human-readable `xcodebuild -list` output (fallback for hosts where
 * `-json` output was not parseable, e.g. a truncated capture).
 *
 * @param {string} text
 * @returns {{ kind?: string, name?: string, schemes: string[], targets: string[], configurations: string[], projects: object[] }|undefined}
 */
export function parseXcodebuildListText(text) {
  const value = typeof text === 'string' ? text : ''
  const lines = value.split(/\r?\n/)
  const result = { kind: undefined, name: undefined, schemes: [], targets: [], configurations: [], projects: [] }
  const header = /^Information about (project|workspace) "([^"]+)"/.exec(value)
  if (header) {
    result.kind = header[1] === 'workspace' ? 'workspace' : 'project'
    result.name = header[2]
  }
  let section = undefined
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      section = undefined
      continue
    }
    const headerMatch = LIST_SECTION.exec(trimmed)
    if (headerMatch) {
      section = headerMatch[1]
      continue
    }
    if (!section) continue
    if (!/^\s+/.test(line)) {
      section = undefined
      continue
    }
    const item = trimmed.replace(/,$/, '').trim()
    if (item.length === 0) continue
    if (section === 'Targets') result.targets.push(item)
    else if (section === 'Schemes') result.schemes.push(item)
    else if (section === 'Build Configurations') result.configurations.push(item)
  }
  if (result.schemes.length === 0 && result.targets.length === 0 && result.configurations.length === 0) return undefined
  return result
}

function productType(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value)
    if (keys.length > 0) return keys[0]
  }
  return 'unknown'
}

/**
 * Parse `swift package describe --type json` (or the older `--json`) output.
 *
 * @param {string} text
 * @returns {{ name?: string, path?: string, targets: object[], products: object[], platforms: object[], dependencies: string[] }|undefined}
 */
export function parseSwiftDescribe(text) {
  const payload = extractJson(text)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  if (typeof payload.name !== 'string' && !Array.isArray(payload.targets)) return undefined
  const targets = (Array.isArray(payload.targets) ? payload.targets : [])
    .filter((target) => target && typeof target === 'object')
    .map((target) => ({
      name: typeof target.name === 'string' ? target.name : undefined,
      type: typeof target.type === 'string' ? target.type : undefined,
      moduleType: typeof target.module_type === 'string' ? target.module_type : undefined,
      path: typeof target.path === 'string' ? target.path : undefined,
      dependencies: stringList(target.target_dependencies),
    }))
  const products = (Array.isArray(payload.products) ? payload.products : [])
    .filter((product) => product && typeof product === 'object')
    .map((product) => ({
      name: typeof product.name === 'string' ? product.name : undefined,
      type: productType(product.type),
      targets: stringList(product.targets),
    }))
  const platforms = (Array.isArray(payload.platforms) ? payload.platforms : [])
    .filter((platform) => platform && typeof platform === 'object')
    .map((platform) => ({
      name: typeof platform.name === 'string' ? platform.name : undefined,
      version: typeof platform.version === 'string' ? platform.version : undefined,
    }))
  const dependencies = (Array.isArray(payload.dependencies) ? payload.dependencies : [])
    .map((dependency) => {
      if (!dependency || typeof dependency !== 'object') return undefined
      if (typeof dependency.name === 'string') return dependency.name
      if (typeof dependency.url === 'string') return dependency.url
      return undefined
    })
    .filter((name) => typeof name === 'string' && name.length > 0)
  return {
    name: typeof payload.name === 'string' ? payload.name : undefined,
    path: typeof payload.path === 'string' ? payload.path : undefined,
    targets,
    products,
    platforms,
    dependencies,
  }
}

function compareEntries(left, right) {
  const priority = (PROJECT_KIND_PRIORITY[left.kind] ?? 9) - (PROJECT_KIND_PRIORITY[right.kind] ?? 9)
  if (priority !== 0) return priority
  if (left.path.length !== right.path.length) return left.path.length - right.path.length
  return left.path.localeCompare(right.path)
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)))
}

/**
 * Discover Xcode projects, workspaces and Swift packages under a directory.
 *
 * Depth-limited breadth-first walk; never descends into derived/build/dependency
 * directories. Accepts a directory, a `.xcodeproj`/`.xcworkspace` container, or
 * a `Package.swift`, so tools can pass a user path through unchanged.
 *
 * @param {string} root directory or project path.
 * @param {{ maxDepth?: number, limit?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ root: string, entries: object[], count: number, truncated: boolean, maxDepth: number, scanned: number }>}
 */
export async function discoverProjects(root, options = {}) {
  const requested = typeof root === 'string' && root.trim().length > 0 ? root.trim() : '.'
  const resolvedRoot = resolvePath(requested)
  const maxDepth = boundedInteger(options.maxDepth, 3, 1, 10)
  const limit = boundedInteger(options.limit, 200, 1, 500)
  const signal = options.signal
  let info
  try {
    info = await stat(resolvedRoot)
  } catch {
    throw new Error(`Path does not exist: ${resolvedRoot}`)
  }

  let entries = []
  let scanned = 0
  if (info.isFile()) {
    const entry = projectKindForPath(resolvedRoot)
    if (!entry) {
      throw new Error(`Not an Xcode project, workspace or Package.swift: ${resolvedRoot}`)
    }
    entries.push(entry)
  } else {
    const direct = projectKindForPath(resolvedRoot)
    if (direct && (direct.kind === 'project' || direct.kind === 'workspace')) {
      entries.push(direct)
    } else {
      const queue = [{ directory: resolvedRoot, depth: 0 }]
      while (queue.length > 0 && entries.length <= limit) {
        if (signal && signal.aborted) break
        const { directory, depth } = queue.shift()
        let children
        try {
          children = await readdir(directory, { withFileTypes: true })
        } catch {
          continue
        }
        scanned += 1
        for (const child of children) {
          if (entries.length > limit) break
          const full = join(directory, child.name)
          if (child.isDirectory()) {
            if (child.name.endsWith('.xcodeproj')) {
              entries.push({ kind: 'project', name: child.name.slice(0, -'.xcodeproj'.length), path: full })
            } else if (child.name.endsWith('.xcworkspace')) {
              entries.push({ kind: 'workspace', name: child.name.slice(0, -'.xcworkspace'.length), path: full })
            }
          } else if (child.isFile() && child.name === 'Package.swift') {
            entries.push({ kind: 'package', name: basename(directory), path: directory, manifestPath: full })
          }
        }
        if (depth >= maxDepth) continue
        for (const child of children) {
          if (!child.isDirectory()) continue
          if (IGNORED_DIRECTORIES.includes(child.name)) continue
          if (
            child.name.endsWith('.xcodeproj') ||
            child.name.endsWith('.xcworkspace') ||
            child.name.endsWith('.xcassets') ||
            child.name.endsWith('.playground') ||
            child.name.endsWith('.app') ||
            child.name.endsWith('.framework') ||
            child.name.endsWith('.bundle')
          ) {
            continue
          }
          queue.push({ directory: join(directory, child.name), depth: depth + 1 })
        }
      }
    }
  }

  const truncated = entries.length > limit
  if (truncated) entries = entries.slice(0, limit)
  entries.sort(compareEntries)
  return { root: resolvedRoot, entries, count: entries.length, truncated, maxDepth, scanned }
}

/**
 * Pick the project to operate on from a discovery result.
 *
 * Workspaces win over projects, which win over Swift packages; among equals the
 * shallowest path wins.
 *
 * @param {object[]} entries
 * @param {{ kind?: string }} [options]
 * @returns {{ entry?: object, alternatives?: object[], note?: string, error?: string }}
 */
export function chooseProject(entries, options = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry && typeof entry.kind === 'string' && typeof entry.path === 'string',
  )
  const requestedKind = typeof options.kind === 'string' && options.kind.length > 0 ? options.kind : undefined
  if (requestedKind && !Object.prototype.hasOwnProperty.call(PROJECT_KIND_PRIORITY, requestedKind)) {
    return { error: `Unknown kind "${requestedKind}"; use workspace, project or package.` }
  }
  const candidates = requestedKind ? list.filter((entry) => entry.kind === requestedKind) : list
  if (candidates.length === 0) {
    return {
      error: requestedKind
        ? `No ${requestedKind} was found.`
        : 'No Xcode project, workspace or Package.swift was found.',
      alternatives: list.slice(0, 10),
    }
  }
  const sorted = [...candidates].sort(compareEntries)
  const entry = sorted[0]
  const duplicates = list.filter((other) => other.path !== entry.path).slice(0, 10)
  return {
    entry,
    alternatives: duplicates,
    note:
      candidates.length > 1
        ? `Selected ${entry.kind} ${entry.path} among ${candidates.length} candidates.`
        : undefined,
  }
}

/**
 * Reduce the `xcodebuild -showBuildSettings -json` payload to useful keys.
 *
 * @param {any} payload parsed JSON (array of target rows or one object).
 * @param {string[]} [keys]
 * @returns {{ targets: { target: string, settings: Record<string, any> }[], settings: Record<string, any>, count: number }}
 */
export function filterBuildSettings(payload, keys = BUILD_SETTING_KEYS) {
  const wanted = new Set(Array.isArray(keys) && keys.length > 0 ? keys : BUILD_SETTING_KEYS)
  const rows = []
  if (Array.isArray(payload)) {
    for (const row of payload) {
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row)
    }
  } else if (payload && typeof payload === 'object') {
    rows.push(payload)
  }
  const targets = []
  for (const row of rows) {
    const settings = row.buildSettings && typeof row.buildSettings === 'object' ? row.buildSettings : undefined
    if (!settings) continue
    const picked = {}
    for (const [key, value] of Object.entries(settings)) {
      if (!wanted.has(key)) continue
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        picked[key] = value
      } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        picked[key] = value
      }
    }
    const target =
      typeof row.target === 'string' && row.target.length > 0
        ? row.target
        : typeof settings.TARGET_NAME === 'string' && settings.TARGET_NAME.length > 0
          ? settings.TARGET_NAME
          : 'default'
    targets.push({ target, settings: picked })
  }
  return { targets, settings: targets[0] ? targets[0].settings : {}, count: targets.length }
}

/** True when SwiftPM rejected the legacy `--json` option. */
export function needsSwiftDescribeTypeJson(text) {
  return /Unknown option '--json'/.test(String(text ?? ''))
}

/**
 * Rewrite `swift package describe --json` to the newer `--type json` spelling.
 * Returns a copy; the input argv is not mutated.
 */
export function withSwiftDescribeTypeJson(argv) {
  const result = Array.isArray(argv) ? argv.slice() : []
  const index = result.lastIndexOf('--json')
  if (index < 0) return result
  result.splice(index, 1, '--type', 'json')
  return result
}
