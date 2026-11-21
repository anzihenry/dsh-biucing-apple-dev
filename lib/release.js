/**
 * Release plumbing: `xcodebuild archive` / `-exportArchive` and fastlane lanes.
 *
 * The plugin does not own signing credentials or an App Store Connect session.
 * Archives are plain xcodebuild runs (the project's signing settings apply),
 * exports use a generated ExportOptions.plist or the user's own, and fastlane
 * lanes run in the project that defines them so credentials stay in the user's
 * Fastfile / keychain / API-key files.
 */
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseBuildOutput } from './build.js'

/** Actions accepted by the `apple_dev_release` tool. */
export const RELEASE_ACTIONS = ['archive', 'export', 'lanes', 'lane']

/** Export methods Xcode understands for `-exportArchive`. */
export const EXPORT_METHODS = ['app-store-connect', 'release-testing', 'debugging', 'enterprise', 'developer-id', 'mac-application']

/** Escape one XML text node / attribute value. */
export function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Build an ExportOptions.plist for `xcodebuild -exportArchive`.
 *
 * @param {object} options method, teamId, signingStyle, uploadSymbols, destination.
 * @returns {string} plist XML.
 */
export function buildExportOptionsPlist({ method = 'app-store-connect', teamId, signingStyle = 'automatic', uploadSymbols = true, destination = 'export' } = {}) {
  const chosen = EXPORT_METHODS.includes(method) ? method : 'app-store-connect'
  const entries = [
    ['method', `<string>${escapeXml(chosen)}</string>`],
    ['signingStyle', `<string>${escapeXml(signingStyle || 'automatic')}</string>`],
    ['destination', `<string>${escapeXml(destination || 'export')}</string>`],
    ['uploadSymbols', uploadSymbols ? '<true/>' : '<false/>'],
  ]
  if (typeof teamId === 'string' && teamId.trim().length > 0) {
    entries.push(['teamID', `<string>${escapeXml(teamId.trim())}</string>`])
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...entries.map(([key, value]) => `  <key>${key}</key>\n  ${value}`),
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/** argv for `xcodebuild archive`. */
export function buildArchiveArgv({ containerKind, containerPath, scheme, configuration = 'Release', destination = 'generic/platform=iOS', archivePath, derivedDataPath, extraArgs = [] }) {
  const flag = containerKind === 'workspace' ? '-workspace' : '-project'
  const argv = [
    'xcodebuild', 'archive',
    flag, String(containerPath),
    '-scheme', String(scheme),
    '-configuration', String(configuration),
    '-destination', String(destination),
    '-archivePath', String(archivePath),
  ]
  if (derivedDataPath) argv.push('-derivedDataPath', String(derivedDataPath))
  argv.push(...(Array.isArray(extraArgs) ? extraArgs.map(String) : []))
  return argv
}

/** argv for `xcodebuild -exportArchive`. */
export function buildExportArgv({ archivePath, exportPath, plistPath, extraArgs = [] }) {
  return [
    'xcodebuild', '-exportArchive',
    '-archivePath', String(archivePath),
    '-exportPath', String(exportPath),
    '-exportOptionsPlist', String(plistPath),
    ...(Array.isArray(extraArgs) ? extraArgs.map(String) : []),
  ]
}

/** argv for a fastlane lane run. */
export function buildLaneArgv({ lane, env, extraArgs = [] }) {
  const argv = ['fastlane', String(lane)]
  if (typeof env === 'string' && env.trim().length > 0) argv.push('--env', env.trim())
  argv.push(...(Array.isArray(extraArgs) ? extraArgs.map(String) : []))
  return argv
}

/** Lanes may be alphanumeric plus underscore, at most 64 characters. */
export function isValidLaneName(name) {
  return typeof name === 'string' && /^[a-z0-9_]{1,64}$/i.test(name.trim())
}

/** Archive/export/build result flags from xcodebuild output. */
export function parseReleaseOutput(text) {
  const value = typeof text === 'string' ? text : ''
  const parsed = parseBuildOutput(value)
  return {
    ...parsed,
    archiveSucceeded: /\*\* ARCHIVE SUCCEEDED \*\*/.test(value),
    archiveFailed: /\*\* ARCHIVE FAILED \*\*/.test(value),
    exportSucceeded: /\*\* EXPORT SUCCEEDED \*\*/.test(value),
    exportFailed: /\*\* EXPORT FAILED \*\*/.test(value),
  }
}

/**
 * Parse `fastlane lanes` output.
 *
 * Shape: `----- fastlane ios hello` followed by the description line.
 *
 * @param {string} text stdout (ANSI codes tolerated).
 * @returns {Array<{platform: string, name: string, description: string}>} lanes.
 */
export function parseLanes(text) {
  const cleaned = typeof text === 'string' ? text.replace(/\u001b\[[0-9;]*m/g, '') : ''
  const lanes = []
  let current
  for (const raw of cleaned.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) continue
    const header = /^-{3,}\s*fastlane\s+(\S+)\s+(\S+)\s*$/.exec(line)
    if (header) {
      current = { platform: header[1], name: header[2], description: '' }
      lanes.push(current)
      continue
    }
    if (/^-{3,}/.test(line) || line.startsWith('Execute using')) {
      current = undefined
      continue
    }
    if (current && current.description.length === 0) current.description = line
  }
  return lanes
}

/**
 * Find the directory that owns `fastlane/Fastfile`, walking up from a path.
 *
 * @param {string} startPath file, project directory or fastlane directory.
 * @returns {Promise<string|undefined>} fastlane root, or undefined.
 */
export async function findFastlaneRoot(startPath) {
  let current = resolve(String(startPath || '.'))
  const info = await stat(current).catch(() => undefined)
  if (info && info.isFile()) current = dirname(current)
  if (info && info.isDirectory() && basename(current) === 'fastlane') {
    if (await stat(join(current, 'Fastfile')).catch(() => undefined)) return dirname(current)
  }
  for (let depth = 0; depth < 5; depth += 1) {
    if (await stat(join(current, 'fastlane', 'Fastfile')).catch(() => undefined)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/** Newest `.xcarchive` directory under `root`, or undefined. */
export async function latestArchive(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const archives = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.xcarchive'))
  const rated = []
  for (const archive of archives) {
    const info = await stat(join(root, archive.name)).catch(() => undefined)
    if (info) rated.push({ path: join(root, archive.name), mtime: info.mtimeMs })
  }
  rated.sort((left, right) => right.mtime - left.mtime)
  return rated[0]?.path
}

/** First `.ipa` in an export directory, or undefined. */
export async function findIpa(exportPath) {
  const entries = await readdir(exportPath, { withFileTypes: true }).catch(() => [])
  const ipa = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ipa'))
  return ipa ? join(exportPath, ipa.name) : undefined
}

/** True when a directory exists. */
export async function directoryExists(path) {
  const info = await stat(path).catch(() => undefined)
  return Boolean(info && info.isDirectory())
}
