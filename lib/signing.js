/**
 * Code-signing, provisioning-profile and Gatekeeper inspection.
 *
 * Everything here is read-only: the only commands are `security`,
 * `codesign`, `plutil` and `spctl` queries. Results are reduced to metadata
 * before they leave the module — provisioning profiles are decoded and then
 * summarized to display fields, so raw CMS/plist blobs and certificate
 * material never reach the model context. An empty keychain (0 identities)
 * and a machine without provisioning profiles are ordinary successful
 * results, not errors.
 *
 * Parsing rules of thumb:
 *   - `codesign -dv` writes its report to stderr; `codesign -d -r-` prints the
 *     executable path followed by `designated => ...` requirements.
 *   - `security cms -D -i <profile>` prints XML. `plutil -convert json` rejects
 *     plists that contain `<data>` values (DeveloperCertificates), so a local
 *     XML plist parser is the fallback; it drops the binary payloads.
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parseIdentities } from './env.js'
import { clip, errorMessage } from './format.js'

/** Actions accepted by the `apple_dev_signing` tool. */
export const SIGNING_ACTIONS = ['identities', 'profiles', 'inspect', 'entitlements', 'verify']

/** How many decoded profiles are returned by default / at most. */
export const DEFAULT_PROFILE_LIMIT = 25
export const MAX_PROFILE_LIMIT = 50
/** Upper bound on profile files inspected in one call. */
const PROFILE_SCAN_LIMIT = 60
/** Relative locations of the two provisioning-profile stores on macOS. */
const PROFILE_DIRECTORY_SUFFIXES = [
  join('Library', 'MobileDevice', 'Provisioning Profiles'),
  join('Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'),
]
const PROFILE_PATTERN = /\.mobileprovision$/i

/** Absolute provisioning-profile directories; missing ones are reported, not fatal. */
export function profileDirectories(home = homedir()) {
  const root = typeof home === 'string' && home.trim().length > 0 ? home.trim() : homedir()
  return PROFILE_DIRECTORY_SUFFIXES.map((suffix) => join(root, suffix))
}

/* ------------------------------------------------------------------------- *
 * Pure parsers (unit-tested in test/diag.test.mjs)
 * ------------------------------------------------------------------------- */

/** `security find-identity -v -p codesigning` output → `{ count, identities }`. */
export function parseSigningIdentities(text) {
  return parseIdentities(text)
}

/** Parse the `CodeDirectory v=... size=... flags=...` value of `codesign -dv`. */
export function parseCodeDirectory(value) {
  const text = String(value ?? '')
  const version = /(?:^|\s)v=([0-9a-fA-F]+)/.exec(text)
  const size = /(?:^|\s)size=(\d+)/.exec(text)
  const flags = /(?:^|\s)flags=(0x[0-9a-fA-F]+)(?:\(([^)]*)\))?/.exec(text)
  const hashes = /(?:^|\s)hashes=(\S+)/.exec(text)
  const location = /(?:^|\s)location=(\S+)/.exec(text)
  return {
    version: version ? version[1] : undefined,
    size: size ? Number(size[1]) : undefined,
    flags: flags
      ? { raw: flags[1], names: flags[2] ? flags[2].split(',').map((name) => name.trim()).filter(Boolean) : [] }
      : undefined,
    hashes: hashes ? hashes[1] : undefined,
    location: location ? location[1] : undefined,
  }
}

/** Split one `codesign -dv` line into key/value, including compound values. */
function splitCodesignField(line) {
  // These lines begin with a key and carry their own `subkey=value` payload.
  for (const prefix of ['CodeDirectory', 'CandidateCDHashFull', 'CandidateCDHash']) {
    if (line.startsWith(`${prefix} `)) return [prefix, line.slice(prefix.length + 1).trim()]
  }
  const equals = line.indexOf('=')
  if (equals < 0) return undefined
  return [line.slice(0, equals).trim(), line.slice(equals + 1).trim()]
}

/**
 * Parse `codesign -dv --verbose=4` (it writes to stderr) into display fields.
 * Unknown keys are ignored; nothing is thrown for partially signed objects.
 */
export function parseCodesignDescription(text) {
  const details = {
    executable: undefined,
    identifier: undefined,
    format: undefined,
    teamIdentifier: undefined,
    authorities: [],
    cdhash: undefined,
    candidateCdhashes: [],
    codeDirectory: undefined,
    flags: undefined,
    hashType: undefined,
    signature: undefined,
    signatureSize: undefined,
    signedTime: undefined,
    timestamp: undefined,
    platformIdentifier: undefined,
    infoPlistEntries: undefined,
    sealedResources: undefined,
  }
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    const field = splitCodesignField(line)
    if (!field) continue
    const key = field[0]
    const value = field[1]
    switch (key) {
      case 'Executable':
        details.executable = value
        break
      case 'Identifier':
        details.identifier = value
        break
      case 'Format':
        details.format = value
        break
      case 'TeamIdentifier':
        details.teamIdentifier = value === 'not set' ? undefined : value
        break
      case 'Authority':
        details.authorities.push(value)
        break
      case 'CDHash':
        details.cdhash = value
        break
      case 'CandidateCDHash': {
        const match = /^([A-Za-z0-9]+)=([0-9A-Fa-f]+)$/.exec(value)
        if (match) details.candidateCdhashes.push({ type: match[1], value: match[2] })
        break
      }
      case 'CodeDirectory':
        details.codeDirectory = parseCodeDirectory(value)
        details.flags = details.codeDirectory.flags
        break
      case 'Hash type':
        details.hashType = value
        break
      case 'Signature':
        details.signature = value
        break
      case 'Signature size':
        details.signatureSize = Number(value) || value
        break
      case 'Signed Time':
      case 'Timestamp':
        details.signedTime = value
        break
      case 'Platform identifier':
        details.platformIdentifier = value
        break
      case 'Info.plist entries':
        details.infoPlistEntries = Number(value) || value
        break
      case 'Sealed Resources':
        details.sealedResources = value
        break
      default:
        break
    }
  }
  return details
}

/** Parse `codesign -d -r-` output into `{ designated, entries }`. */
export function parseRequirements(text) {
  const entries = []
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const match = /^([^=]+?)\s*=>\s*(.*)$/.exec(rawLine.trim())
    if (!match) continue
    entries.push({ type: match[1].trim(), expression: match[2].trim() })
  }
  const designated = entries.find((entry) => entry.type === 'designated')
  return { designated: designated ? designated.expression : undefined, entries }
}

/** Parse `spctl --assess --type execute -vv` output (it writes to stderr). */
export function parseSpctlOutput(text) {
  const assessment = { path: undefined, decision: undefined, reason: undefined, source: undefined, origin: undefined, override: undefined }
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const decision = /^(.+?):\s*(accepted|rejected)(?:\s*\((.*)\))?\s*$/i.exec(line)
    if (decision) {
      assessment.path = decision[1].trim()
      assessment.decision = decision[2].toLowerCase()
      if (decision[3]) assessment.reason = decision[3].trim()
      continue
    }
    const pair = /^([\w-]+)\s*=\s*(.+)$/.exec(line)
    if (!pair) continue
    const key = pair[1].toLowerCase()
    const value = pair[2].trim()
    if (key === 'source') assessment.source = value
    else if (key === 'origin') assessment.origin = value
    else if (key === 'override') assessment.override = value
  }
  return assessment
}

/** Parse JSON produced by `plutil -convert json`; undefined when unusable. */
export function parsePlistJson(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start < 0) return undefined
  try {
    const parsed = JSON.parse(source.slice(start))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Decode the five XML entities plists use, plus numeric character references. */
export function decodeXmlEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    return named[body] ?? match
  })
}

function findTagEnd(xml, start) {
  let quote = ''
  for (let index = start + 1; index < xml.length; index += 1) {
    const character = xml[index]
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '>') return index
  }
  return -1
}

function tokenizePlistXml(xml) {
  const tokens = []
  let index = 0
  while (index < xml.length) {
    const next = xml.indexOf('<', index)
    if (next < 0) {
      const text = xml.slice(index)
      if (text.trim().length > 0) tokens.push({ type: 'text', value: text })
      break
    }
    if (next > index) tokens.push({ type: 'text', value: xml.slice(index, next) })
    if (xml.startsWith('<?', next)) {
      const end = xml.indexOf('?>', next)
      if (end < 0) break
      index = end + 2
      continue
    }
    if (xml.startsWith('<!--', next)) {
      const end = xml.indexOf('-->', next)
      if (end < 0) break
      index = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', next)) {
      const end = xml.indexOf(']]>', next)
      if (end < 0) break
      tokens.push({ type: 'text', value: xml.slice(next + 9, end) })
      index = end + 3
      continue
    }
    if (xml.startsWith('<!', next)) {
      const end = xml.indexOf('>', next)
      if (end < 0) break
      index = end + 1
      continue
    }
    const end = findTagEnd(xml, next)
    if (end < 0) break
    const raw = xml.slice(next + 1, end)
    index = end + 1
    if (raw.length === 0) continue
    if (raw.startsWith('/')) {
      tokens.push({ type: 'close', name: raw.slice(1).trim() })
      continue
    }
    const selfClosing = raw.endsWith('/')
    const body = (selfClosing ? raw.slice(0, -1) : raw).trim()
    const space = body.search(/\s/)
    const name = (space < 0 ? body : body.slice(0, space)).trim()
    tokens.push({ type: selfClosing ? 'empty' : 'open', name })
  }
  return tokens
}

function base64Bytes(value) {
  const text = String(value ?? '')
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding)
}

function normalizePlistDate(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString()
}

/**
 * Minimal XML plist parser used when `plutil -convert json` refuses a plist
 * (it does for anything containing `<data>`). Supports the plist value types;
 * `<data>` becomes `{ kind: 'data', bytes }`, deliberately dropping the blob.
 */
export function parsePlistXml(text) {
  const source = typeof text === 'string' ? text : ''
  if (source.trim().length === 0) throw new Error('Empty plist XML.')
  const tokens = tokenizePlistXml(source)
  let position = 0

  function malformed(message) {
    throw new Error(`Malformed plist XML: ${message}.`)
  }

  function emptyElement(name) {
    switch (name) {
      case 'true':
        return true
      case 'false':
        return false
      case 'string':
        return ''
      case 'integer':
        return 0
      case 'real':
        return 0
      case 'data':
        return { kind: 'data', bytes: 0 }
      case 'array':
        return []
      case 'dict':
        return {}
      default:
        return malformed(`unsupported empty element <${name}/>`)
    }
  }

  function readText(name) {
    let value = ''
    for (;;) {
      const token = tokens[position]
      position += 1
      if (!token) malformed(`unterminated <${name}>`)
      if (token.type === 'text') {
        value += token.value
        continue
      }
      if (token.type === 'close' && token.name === name) return decodeXmlEntities(value)
      malformed(`unexpected <${token.name ?? '?'}> inside <${name}>`)
    }
  }

  function skipText() {
    while (tokens[position] && tokens[position].type === 'text') position += 1
  }

  function takeValueToken() {
    skipText()
    const token = tokens[position]
    position += 1
    return token
  }

  function consumeClose(name) {
    skipText()
    const token = tokens[position]
    position += 1
    if (!token || token.type !== 'close' || token.name !== name) malformed(`expected </${name}>`)
  }

  function parseDict() {
    const result = {}
    for (;;) {
      skipText()
      const token = tokens[position]
      if (!token) malformed('unterminated <dict>')
      if (token.type === 'close') {
        if (token.name !== 'dict') malformed(`unexpected </${token.name}> in <dict>`)
        position += 1
        return result
      }
      if (token.type !== 'open' || token.name !== 'key') malformed('expected <key> in <dict>')
      position += 1
      const key = readText('key')
      const valueToken = takeValueToken()
      if (!valueToken) malformed('missing value in <dict>')
      result[key] = parseValue(valueToken)
    }
  }

  function parseArray() {
    const result = []
    for (;;) {
      skipText()
      const token = tokens[position]
      if (!token) malformed('unterminated <array>')
      if (token.type === 'close') {
        if (token.name !== 'array') malformed(`unexpected </${token.name}> in <array>`)
        position += 1
        return result
      }
      position += 1
      result.push(parseValue(token))
    }
  }

  function parseValue(token) {
    const current = token ?? takeValueToken()
    if (!current) malformed('expected a value')
    if (current.type === 'empty') return emptyElement(current.name)
    if (current.type !== 'open') malformed(`expected an element, got <${current.name ?? '?'}>`)
    switch (current.name) {
      case 'plist': {
        const value = parseValue()
        consumeClose('plist')
        return value
      }
      case 'dict':
        return parseDict()
      case 'array':
        return parseArray()
      case 'string':
        return readText('string')
      case 'integer': {
        const raw = readText('integer').trim()
        const value = Number.parseInt(raw, 10)
        if (!Number.isFinite(value)) malformed(`integer value "${raw}"`)
        return value
      }
      case 'real': {
        const raw = readText('real').trim()
        const value = Number.parseFloat(raw)
        if (!Number.isFinite(value)) malformed(`real value "${raw}"`)
        return value
      }
      case 'date':
        return normalizePlistDate(readText('date'))
      case 'data': {
        const raw = readText('data')
        return { kind: 'data', bytes: base64Bytes(raw.replace(/\s+/g, '')) }
      }
      case 'true':
        consumeClose('true')
        return true
      case 'false':
        consumeClose('false')
        return false
      default:
        return malformed(`unsupported element <${current.name}>`)
    }
  }

  const root = takeValueToken()
  if (!root) malformed('no root element')
  return parseValue(root)
}

function stringValue(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function normalizeDateString(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
  const text = stringValue(value)
  if (text === undefined) return undefined
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? text : new Date(parsed).toISOString()
}

function stringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
}

/**
 * Reduce a decoded provisioning-profile plist to display metadata.
 *
 * Only allow-listed fields leave this function: certificate data, DER-encoded
 * profile bytes and device UDIDs are reduced to counts/flags.
 *
 * @param {object} payload decoded profile plist.
 * @param {{ now?: number }} [options] clock for `expiresInDays` (tests).
 */
export function summarizeProvisioningProfile(payload, options = {}) {
  const value = payload && typeof payload === 'object' ? payload : {}
  const entitlements = value.Entitlements && typeof value.Entitlements === 'object' ? value.Entitlements : {}
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const expirationDate = normalizeDateString(value.ExpirationDate)
  const createdDate = normalizeDateString(value.CreationDate)
  const expirationMs = expirationDate ? Date.parse(expirationDate) : Number.NaN
  const teamIdentifiers = stringArray(value.TeamIdentifier)
  const platforms = [...new Set([...stringArray(value.Platform), ...stringArray(value.Platforms)])]
  const devices = stringArray(value.ProvisionedDevices)
  const getTaskAllow = typeof entitlements['get-task-allow'] === 'boolean' ? entitlements['get-task-allow'] : undefined
  return {
    name: stringValue(value.Name),
    uuid: stringValue(value.UUID),
    teamName: stringValue(value.TeamName),
    teamIdentifier: teamIdentifiers[0],
    applicationIdentifier: stringValue(entitlements['application-identifier']),
    getTaskAllow,
    expirationDate,
    createdDate,
    expired: Number.isNaN(expirationMs) ? undefined : expirationMs < now,
    expiresInDays: Number.isNaN(expirationMs) ? undefined : Math.floor((expirationMs - now) / 86400000),
    platform: platforms,
    provisionedDevices: devices.length,
    isXcodeManaged: value.IsXcodeManaged === true,
    version: typeof value.Version === 'number' ? value.Version : undefined,
  }
}

/** Sort profiles by expiration (soonest first); undated/undecodable last. */
export function sortProvisioningProfiles(rows) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : []
  return [...list].sort((left, right) => {
    const leftTime = Date.parse(left.expirationDate ?? '')
    const rightTime = Date.parse(right.expirationDate ?? '')
    const leftValid = Number.isFinite(leftTime)
    const rightValid = Number.isFinite(rightTime)
    if (leftValid !== rightValid) return leftValid ? -1 : 1
    if (leftValid && leftTime !== rightTime) return leftTime - rightTime
    return String(left.name ?? left.file ?? '').localeCompare(String(right.name ?? right.file ?? ''))
  })
}

/* ------------------------------------------------------------------------- *
 * Command-backed operations
 * ------------------------------------------------------------------------- */

function failureReason(result) {
  if (result.spawnError) return `could not start \`${result.command}\`: ${result.spawnError}`
  if (result.timedOut) return `\`${result.command}\` timed out`
  if (result.cancelled) return `\`${result.command}\` was cancelled`
  const detail = [result.stderr, result.stdout]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0)
    .join('\n')
  return detail || `\`${result.command}\` exited ${result.exitCode}`
}

async function pathProblem(path) {
  const value = typeof path === 'string' ? path.trim() : ''
  if (value.length === 0) return 'A path is required.'
  try {
    await stat(value)
    return undefined
  } catch (error) {
    return `No file or directory at ${value} (${errorMessage(error)}).`
  }
}

/** `security find-identity -v -p codesigning`. An empty keychain is `ok: true`. */
export async function readIdentities(runner, options = {}) {
  const result = await runner(['security', 'find-identity', '-v', '-p', 'codesigning'], {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: 30000,
    label: 'security find-identity',
  })
  if (!result.ok) {
    return { ok: false, count: 0, identities: [], error: failureReason(result) }
  }
  const parsed = parseSigningIdentities(result.stdout)
  const warnings = []
  const firstStderr = result.stderr.trim().split(/\r?\n/)[0]
  if (firstStderr) warnings.push(firstStderr)
  return { ok: true, count: parsed.count, identities: parsed.identities, warnings }
}

async function listProfileFiles(directories) {
  const files = []
  const seenPaths = new Set()
  const directoryReports = []
  for (const directory of directories) {
    let names = []
    try {
      names = await readdir(directory)
    } catch {
      directoryReports.push({ directory, exists: false, files: 0 })
      continue
    }
    let count = 0
    for (const name of names) {
      if (!PROFILE_PATTERN.test(name)) continue
      const file = join(directory, name)
      if (seenPaths.has(file)) continue
      seenPaths.add(file)
      let info
      try {
        info = await stat(file)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      count += 1
      files.push({ file, path: file, modifiedAt: info.mtimeMs })
    }
    directoryReports.push({ directory, exists: true, files: count })
  }
  files.sort((left, right) => right.modifiedAt - left.modifiedAt)
  return { files, directories: directoryReports }
}

async function decodeProfileXml(runner, file, options) {
  const cms = await runner(['security', 'cms', '-D', '-i', file], {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: 30000,
    label: 'security cms -D',
  })
  if (cms.ok && cms.stdout.trim().length > 0) {
    return { xml: cms.stdout, method: 'security-cms' }
  }
  const cmsReason = cms.ok ? 'empty output' : failureReason(cms)
  const openssl = await runner(['openssl', 'smime', '-verify', '-noverify', '-inform', 'der', '-in', file], {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: 30000,
    label: 'openssl smime verify',
  })
  if (openssl.ok && openssl.stdout.trim().length > 0) {
    return { xml: openssl.stdout, method: 'openssl', warning: `security cms failed (${clip(cmsReason, 200)}); decoded with openssl.` }
  }
  const opensslReason = openssl.ok ? 'empty output' : failureReason(openssl)
  return { error: `security cms: ${clip(cmsReason, 300)}; openssl: ${clip(opensslReason, 300)}` }
}

async function profilePayloadFromXml(runner, xml, options, usePlutil) {
  if (usePlutil) {
    const json = await runner(['plutil', '-convert', 'json', '-o', '-', '-'], {
      cwd: options.cwd,
      signal: options.signal,
      timeoutMs: 20000,
      label: 'plutil convert json',
      stdin: { data: xml },
    })
    if (json.ok) {
      const parsed = parsePlistJson(json.stdout)
      if (parsed) return { payload: parsed, method: 'plutil' }
    }
  }
  return { payload: parsePlistXml(xml), method: 'plist-xml' }
}

/**
 * List and decode provisioning profiles from the standard Xcode stores.
 *
 * Missing directories, a store without profiles, a profile that cannot be
 * decoded and one with no expiration are all reported in the result; the call
 * itself still succeeds. Results are newest-unexpired-first by expiration.
 *
 * @param {Function} runner command executor from `lib/runner.js`.
 * @param {object} [options] `{ cwd, signal, limit, directories, home }`.
 */
export async function readProvisioningProfiles(runner, options = {}) {
  const limit = clampLimit(options.limit, DEFAULT_PROFILE_LIMIT, 1, MAX_PROFILE_LIMIT)
  const directories =
    Array.isArray(options.directories) && options.directories.length > 0
      ? options.directories.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
      : profileDirectories(options.home)

  const listed = await listProfileFiles(directories)
  const warnings = []
  const scanned = listed.files.slice(0, PROFILE_SCAN_LIMIT)
  const profiles = []
  let usePlutil = true
  let cmsFailureCount = 0

  for (const entry of scanned) {
    const decoded = await decodeProfileXml(runner, entry.file, options)
    if (decoded.error) {
      profiles.push({ file: basename(entry.file), path: entry.file, modifiedAt: new Date(entry.modifiedAt).toISOString(), decodeError: decoded.error })
      continue
    }
    if (decoded.method === 'openssl') cmsFailureCount += 1
    let payload
    let method
    try {
      const parsed = await profilePayloadFromXml(runner, decoded.xml, options, usePlutil)
      payload = parsed.payload
      method = parsed.method
      if (method === 'plist-xml' && usePlutil) usePlutil = false
    } catch (error) {
      profiles.push({
        file: basename(entry.file),
        path: entry.file,
        modifiedAt: new Date(entry.modifiedAt).toISOString(),
        decodeError: `could not parse the decoded profile: ${clip(errorMessage(error), 300)}`,
      })
      continue
    }
    const summary = summarizeProvisioningProfile(payload, { now: Date.now() })
    profiles.push({
      ...summary,
      file: basename(entry.file),
      path: entry.file,
      modifiedAt: new Date(entry.modifiedAt).toISOString(),
      decodedWith: method,
    })
  }

  const deduped = []
  const seenKeys = new Set()
  for (const profile of profiles) {
    const key = profile.uuid ? `uuid:${String(profile.uuid).toLowerCase()}` : `file:${profile.path}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    deduped.push(profile)
  }
  const sorted = sortProvisioningProfiles(deduped)

  if (cmsFailureCount > 0) {
    warnings.push(`\`security cms -D\` failed for ${cmsFailureCount} profile(s); they were decoded with \`openssl smime\` instead.`)
  }
  if (listed.files.length > scanned.length) {
    warnings.push(`Only the ${scanned.length} most recently modified of ${listed.files.length} profile files were inspected.`)
  }

  return {
    ok: true,
    directories: listed.directories,
    total: listed.files.length,
    scanned: scanned.length,
    count: Math.min(sorted.length, limit),
    profiles: sorted.slice(0, limit),
    truncated: sorted.length > limit,
    warnings,
  }
}

/** Inspect one code-signed object with `codesign -dv --verbose=4` + `codesign -d -r-`. */
export async function inspectApp(runner, appPath, options = {}) {
  const path = typeof appPath === 'string' ? appPath.trim() : ''
  const problem = await pathProblem(path)
  if (problem) return { ok: false, path, signed: false, error: problem }

  const result = await runner(['codesign', '-dv', '--verbose=4', path], {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: 60000,
    label: 'codesign -dv',
  })
  const output = result.stderr.trim().length > 0 ? result.stderr : result.stdout
  const details = parseCodesignDescription(output)
  const unsigned = /not signed at all/i.test(output)
  const identified = Boolean(details.identifier || details.executable || details.cdhash || details.authorities.length > 0)
  if (!result.ok && !unsigned && !identified) {
    return { ok: false, path, signed: false, error: failureReason(result) }
  }

  const warnings = []
  let requirements
  let requirementEntries = []
  const requirementResult = await runner(['codesign', '-d', '-r-', path], {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: 30000,
    label: 'codesign -d -r-',
  })
  if (requirementResult.ok || /designated\s*=>/i.test(requirementResult.stderr)) {
    const parsed = parseRequirements(requirementResult.stderr.trim().length > 0 ? requirementResult.stderr : requirementResult.stdout)
    requirements = parsed.designated
    requirementEntries = parsed.entries
  } else if (!unsigned) {
    warnings.push(`Could not read the designated requirement: ${clip(failureReason(requirementResult), 300)}`)
  }

  return {
    ok: true,
    path,
    signed: !unsigned && identified,
    details,
    requirements,
    requirementEntries,
    note: unsigned ? 'The code object is not signed at all.' : undefined,
    warnings,
  }
}

/** Read an object's entitlements as JSON (`codesign -d --entitlements :-` → `plutil`). */
export async function readEntitlements(runner, appPath, options = {}) {
  const path = typeof appPath === 'string' ? appPath.trim() : ''
  const problem = await pathProblem(path)
  if (problem) return { ok: false, path, available: false, entitlements: {}, error: problem }

  const result = await runner(['codesign', '-d', '--entitlements', ':-', path], {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: 60000,
    label: 'codesign entitlements',
  })
  const xml = result.stdout
  if (!result.ok && xml.trim().length === 0) {
    if (/not signed at all/i.test(result.stderr)) {
      return {
        ok: true,
        path,
        available: false,
        signed: false,
        entitlements: {},
        note: 'The code object is not signed, so it carries no entitlements.',
      }
    }
    return { ok: false, path, available: false, entitlements: {}, error: failureReason(result) }
  }
  if (xml.trim().length === 0) {
    return { ok: true, path, available: false, entitlements: {}, note: 'The signature carries no entitlements.' }
  }

  let entitlements
  let decodedWith
  const jsonResult = await runner(['plutil', '-convert', 'json', '-o', '-', '-'], {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: 20000,
    label: 'plutil convert json',
    stdin: { data: xml },
  })
  if (jsonResult.ok) {
    entitlements = parsePlistJson(jsonResult.stdout)
    decodedWith = 'plutil'
  }
  if (!entitlements) {
    try {
      entitlements = parsePlistXml(xml)
      decodedWith = 'plist-xml'
    } catch (error) {
      return {
        ok: true,
        path,
        available: false,
        entitlements: {},
        error: `Could not parse the entitlements plist: ${clip(errorMessage(error), 300)}`,
      }
    }
  }
  const keys = Object.keys(entitlements)
  return {
    ok: true,
    path,
    available: keys.length > 0,
    count: keys.length,
    entitlements,
    decodedWith,
    note: keys.length === 0 ? 'The signature carries an empty entitlements dictionary.' : undefined,
  }
}

/** Verify signature validity and Gatekeeper assessment. */
export async function verifyApp(runner, appPath, options = {}) {
  const path = typeof appPath === 'string' ? appPath.trim() : ''
  const problem = await pathProblem(path)
  if (problem) return { ok: false, path, error: problem }

  const signature = await runner(['codesign', '--verify', '--deep', '--strict', path], {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 180000,
    label: 'codesign --verify',
  })
  const assessment = await runner(['spctl', '--assess', '--type', 'execute', '-vv', path], {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: 120000,
    label: 'spctl --assess',
  })

  const signatureOutput = [signature.stderr, signature.stdout]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0)
    .join('\n')
  const assessmentOutput = [assessment.stderr, assessment.stdout]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0)
    .join('\n')
  const parsed = parseSpctlOutput(assessmentOutput)
  const spctlAvailable = !assessment.spawnError

  return {
    ok: signature.ok,
    path,
    verified: signature.ok,
    signature: {
      ok: signature.ok,
      exitCode: signature.exitCode,
      timedOut: signature.timedOut,
      cancelled: signature.cancelled,
      spawnError: signature.spawnError,
      durationMs: signature.durationMs,
      output: clip(signatureOutput, 4000),
    },
    spctl: {
      ok: assessment.ok,
      available: spctlAvailable,
      accepted: parsed.decision === 'accepted',
      decision: parsed.decision,
      reason: parsed.reason,
      source: parsed.source,
      origin: parsed.origin,
      timedOut: assessment.timedOut,
      spawnError: assessment.spawnError,
      output: clip(assessmentOutput, 4000),
    },
    error: signature.ok ? undefined : failureReason(signature),
  }
}

function clampLimit(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}
