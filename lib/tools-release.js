/**
 * `apple_dev_release`: archive, export and fastlane lane runs.
 *
 * Signing stays with the project (or the user's Fastfile): the plugin builds
 * the commands, runs them through the shared runner, and reports archive/IPA
 * paths, diagnostics and a bounded output tail. Upload is a fastlane lane so
 * App Store Connect credentials never pass through the plugin.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { clip, errorMessage, formatDuration, indent, plural, renderText, stripAnsi, tailLines } from './format.js'
import { platformProblem, resolveUserPath, saveLog, sessionDirectory } from './runner.js'
import { chooseProject, discoverProjects } from './project.js'
import {
  EXPORT_METHODS,
  RELEASE_ACTIONS,
  buildArchiveArgv,
  buildExportArgv,
  buildExportOptionsPlist,
  buildLaneArgv,
  directoryExists,
  findFastlaneRoot,
  findIpa,
  isValidLaneName,
  latestArchive,
  parseLanes,
  parseReleaseOutput,
} from './release.js'

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function number(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function boolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function slug(value) {
  return String(value || 'app').replace(/[^\w.-]+/g, '-')
}

/** Text report for `apple_dev_release`. */
export function formatReleaseReport(value) {
  if (!value || typeof value !== 'object') return 'No release result was returned.'
  const action = text(value.action, 'release')
  if (value.error && value.ok === false && !value.archivePath && !value.ipaPath && !value.lanes) {
    return `Release ${action} failed: ${value.error}`
  }
  const lines = [`Release ${action}${value.scheme ? ` · ${value.scheme}` : ''}${value.lane ? ` · ${value.lane}` : ''}`]
  if (value.container) lines.push(`Container: ${value.container.kind} ${value.container.path}`)
  if (value.action === 'archive') {
    lines.push(`Result: ${value.ok ? 'ARCHIVE SUCCEEDED' : 'failed'}${value.durationMs ? ` in ${formatDuration(value.durationMs)}` : ''}`)
    if (value.archivePath) lines.push(`Archive: ${value.archivePath}${value.archiveExists ? '' : ' (missing)'}`)
    if (value.dsymPath) lines.push(`dSYMs: ${value.dsymPath}`)
    if (value.errorCount) lines.push(`Errors: ${plural(value.errorCount, 'error')}`)
    if (value.warningCount) lines.push(`Warnings: ${plural(value.warningCount, 'warning')}`)
    if (value.logPath) lines.push(`Log: ${value.logPath}`)
  } else if (value.action === 'export') {
    lines.push(`Result: ${value.ok ? 'EXPORT SUCCEEDED' : 'failed'}${value.durationMs ? ` in ${formatDuration(value.durationMs)}` : ''}`)
    if (value.ipaPath) lines.push(`IPA: ${value.ipaPath}`)
    if (value.archivePath) lines.push(`Archive: ${value.archivePath}`)
    if (value.plistPath) lines.push(`Export options: ${value.plistPath}`)
    if (value.errorCount) lines.push(`Errors: ${plural(value.errorCount, 'error')}`)
    if (value.logPath) lines.push(`Log: ${value.logPath}`)
  } else if (value.action === 'lanes') {
    const lanes = Array.isArray(value.lanes) ? value.lanes : []
    lines.push(`${plural(lanes.length, 'lane')} in ${value.root || 'the project'}`)
    for (const lane of lanes) {
      lines.push(`- ${lane.platform}/${lane.name}${lane.description ? ` — ${lane.description}` : ''}`)
    }
  } else if (value.action === 'lane') {
    lines.push(`Result: ${value.ok ? 'succeeded' : 'failed'}${value.exitCode !== undefined ? ` (exit ${value.exitCode})` : ''}${value.durationMs ? ` in ${formatDuration(value.durationMs)}` : ''}`)
    if (value.root) lines.push(`Fastfile: ${value.root}/fastlane/Fastfile`)
    if (value.logPath) lines.push(`Log: ${value.logPath}`)
  }
  if (value.error) lines.push(`Error: ${value.error}`)
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    lines.push('Compiler errors:', indent(value.errors.slice(0, 8).map((error) => {
      const location = error.file ? `${error.file}${error.line ? `:${error.line}` : ''}` : ''
      return [location, error.message].filter(Boolean).join(' ')
    }).join('\n')))
  }
  if (value.output) lines.push('', value.output)
  return clip(lines.join('\n'))
}

async function resolveContainer(cwd, requestedPath, signal) {
  const root = resolveUserPath(cwd, requestedPath)
  const discovered = await discoverProjects(root, { signal })
  const chosen = chooseProject(discovered.entries)
  if (chosen.error) throw new Error(chosen.error)
  if (chosen.entry.kind === 'package') throw new Error('archives need an Xcode project or workspace; Swift packages are not archive containers.')
  return chosen.entry
}

function failureText(parsed, result) {
  const first = Array.isArray(parsed.errors) && parsed.errors[0]
  if (first && (first.message || first.file)) {
    return `${first.file ? `${first.file}${first.line ? `:${first.line}` : ''}: ` : ''}${first.message || ''}`.trim()
  }
  const detail = stripAnsi(`${result.stderr}\n${result.stdout}`).trim()
  return detail.length > 0 ? clip(detail.slice(-1200), 800) : `exit ${result.exitCode}`
}

function summarizeCommand(result, parsed) {
  const all = stripAnsi(`${result.stdout}\n${result.stderr}`)
  return {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    result: parsed.archiveSucceeded || parsed.exportSucceeded ? 'succeeded' : parsed.result,
    errors: parsed.errors.slice(0, 12),
    errorCount: parsed.errorCount,
    warnings: parsed.warnings.slice(0, 5),
    warningCount: parsed.warningCount,
    tail: clip(tailLines(all.trim(), 40), 4000),
  }
}

function createReleaseTool(ctx, config, runner) {
  return {
    name: 'apple_dev_release',
    description:
      'Archive and ship an Xcode app. Actions: archive (`xcodebuild archive` with a Release configuration and generic/platform destination, returns the .xcarchive and dSYM folder), export (`xcodebuild -exportArchive` with your ExportOptions.plist or a generated one, returns the .ipa), lanes (find fastlane/Fastfile upward and list lanes), lane (run one fastlane lane in the project; upload lanes such as beta/deliver belong here so credentials stay in your Fastfile, keychain or App Store Connect API key). Signing is never bypassed: the project settings or fastlane lane decide it.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: RELEASE_ACTIONS, description: 'archive, export, lanes or lane.' },
        path: { type: 'string', description: 'Project/workspace path or a directory to search (and for lanes, the fastlane root search start). Defaults to the session directory.' },
        scheme: { type: 'string', description: 'For archive: the scheme to archive.' },
        configuration: { type: 'string', description: 'For archive: build configuration (default Release).' },
        destination: { type: 'string', description: 'For archive: xcodebuild destination (default "generic/platform=iOS").' },
        archive_path: { type: 'string', description: 'For archive: output .xcarchive path. For export: the input archive (defaults to the newest archive under archiveDirectory when omitted).' },
        derived_data_path: { type: 'string', description: 'For archive: derived data directory (default from plugin config).' },
        export_path: { type: 'string', description: 'For export: directory for the IPA (default .apple-dev/exports/<time>).' },
        export_options: { type: 'string', description: 'For export: path to an existing ExportOptions.plist (overrides method/team_id/signing_style).' },
        method: { type: 'string', enum: EXPORT_METHODS, description: 'For export: generated plist method (default app-store-connect).' },
        team_id: { type: 'string', description: 'For export: team ID written into the generated plist.' },
        signing_style: { type: 'string', enum: ['automatic', 'manual'], description: 'For export: signing style in the generated plist (default automatic).' },
        upload_symbols: { type: 'boolean', description: 'For export: include dSYMs in the IPA (default true).' },
        lane: { type: 'string', description: 'For action=lane: the fastlane lane name (letters, digits, underscore).' },
        env: { type: 'string', description: 'For action=lane: fastlane --env name (e.g. staging).' },
        extra_args: { type: 'array', items: { type: 'string' }, description: 'Extra arguments appended to xcodebuild or fastlane.' },
        timeout_ms: { type: 'number', description: 'Command timeout; archives default to 45 minutes, lanes to 60 minutes.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(formatReleaseReport(value)),
    },
    timeoutMs: 3600000,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const problem = platformProblem()
      if (problem) return { tool: 'apple_dev_release', ok: false, error: problem }
      const action = text(input.action)
      if (!RELEASE_ACTIONS.includes(action)) throw new Error(`action must be one of: ${RELEASE_ACTIONS.join(', ')}`)
      const cwd = sessionDirectory(ctx, exec)
      const signal = exec.signal
      const startedAt = Date.now()
      const report = { tool: 'apple_dev_release', action, ok: false }

      try {
        if (action === 'archive') {
          const scheme = text(input.scheme).trim()
          if (scheme.length === 0) throw new Error('scheme is required for archive.')
          const container = await resolveContainer(cwd, text(input.path), signal)
          const archivePath = resolveUserPath(cwd, text(input.archive_path).trim() || join(config.archiveDirectory || '.apple-dev/archives', `${slug(scheme)}-${timestamp()}.xcarchive`))
          const derivedDataPath = resolveUserPath(cwd, text(input.derived_data_path).trim() || config.derivedDataPath)
          await mkdir(dirname(archivePath), { recursive: true })
          const argv = buildArchiveArgv({
            containerKind: container.kind,
            containerPath: container.path,
            scheme,
            configuration: text(input.configuration, 'Release'),
            destination: text(input.destination, 'generic/platform=iOS'),
            archivePath,
            derivedDataPath,
            extraArgs: stringList(input.extra_args),
          })
          const timeoutMs = number(input.timeout_ms, 45 * 60 * 1000)
          const result = await runner(argv, { signal, timeoutMs })
          const parsed = parseReleaseOutput(`${result.stdout}\n${result.stderr}`)
          const logPath = await saveLog(cwd, config.logDirectory, `archive-${slug(scheme)}`, result)
          const archiveExists = await directoryExists(archivePath)
          return {
            ...report,
            ...summarizeCommand(result, parsed),
            ok: result.ok && (parsed.archiveSucceeded || archiveExists),
            scheme,
            container: { kind: container.kind, path: container.path },
            archivePath,
            archiveExists,
            dsymPath: archiveExists ? join(archivePath, 'dSYMs') : undefined,
            ...(logPath ? { logPath } : {}),
            ...(!result.ok ? { error: failureText(parsed, result) } : {}),
          }
        }

        if (action === 'export') {
          let archivePath
          if (text(input.archive_path).trim().length > 0) {
            archivePath = resolveUserPath(cwd, text(input.archive_path).trim())
          } else {
            archivePath = await latestArchive(resolveUserPath(cwd, config.archiveDirectory || '.apple-dev/archives'))
            if (!archivePath) throw new Error('archive_path is required for export (no .xcarchive under archiveDirectory).')
          }
          if (!(await directoryExists(archivePath))) throw new Error(`Archive not found: ${archivePath}`)
          const exportPath = resolveUserPath(cwd, text(input.export_path).trim() || join(config.exportDirectory || '.apple-dev/exports', timestamp()))
          await mkdir(exportPath, { recursive: true })
          let plistPath
          const provided = text(input.export_options).trim()
          if (provided.length > 0) {
            plistPath = resolveUserPath(cwd, provided)
            if (!(await stat(plistPath).catch(() => undefined))) throw new Error(`Export options plist not found: ${plistPath}`)
          } else {
            plistPath = join(exportPath, 'ExportOptions.plist')
            await writeFile(plistPath, buildExportOptionsPlist({
              method: text(input.method, 'app-store-connect'),
              teamId: text(input.team_id).trim() || undefined,
              signingStyle: text(input.signing_style, 'automatic'),
              uploadSymbols: boolean(input.upload_symbols, true),
            }), 'utf8')
          }
          const argv = buildExportArgv({ archivePath, exportPath, plistPath, extraArgs: stringList(input.extra_args) })
          const timeoutMs = number(input.timeout_ms, 30 * 60 * 1000)
          const result = await runner(argv, { signal, timeoutMs })
          const parsed = parseReleaseOutput(`${result.stdout}\n${result.stderr}`)
          const ipaPath = await findIpa(exportPath)
          const logPath = await saveLog(cwd, config.logDirectory, 'export', result)
          return {
            ...report,
            ...summarizeCommand(result, parsed),
            ok: result.ok && Boolean(ipaPath),
            ...(result.ok && !ipaPath ? { error: 'xcodebuild reported success but no .ipa appeared in the export directory.' } : {}),
            archivePath,
            exportPath,
            plistPath,
            ...(ipaPath ? { ipaPath } : {}),
            ...(logPath ? { logPath } : {}),
            ...(!result.ok ? { error: failureText(parsed, result) } : {}),
          }
        }

        if (action === 'lanes') {
          const root = await findFastlaneRoot(resolveUserPath(cwd, text(input.path)))
          if (!root) throw new Error('No fastlane/Fastfile found at or above that path.')
          const result = await runner(['fastlane', 'lanes'], { signal, timeoutMs: 120000, cwd: root })
          const lanes = parseLanes(result.stdout)
          const logPath = await saveLog(cwd, config.logDirectory, 'fastlane-lanes', result)
          return {
            ...report,
            ok: result.ok,
            root,
            lanes,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            ...(logPath ? { logPath } : {}),
            ...(result.ok ? {} : { error: clip(result.stderr.trim() || result.stdout.trim(), 1200) }),
          }
        }

        // lane
        const lane = text(input.lane).trim()
        if (!isValidLaneName(lane)) throw new Error('lane must be letters, digits or underscore (max 64).')
        const root = await findFastlaneRoot(resolveUserPath(cwd, text(input.path)))
        if (!root) throw new Error('No fastlane/Fastfile found at or above that path.')
        const argv = buildLaneArgv({ lane, env: text(input.env).trim() || undefined, extraArgs: stringList(input.extra_args) })
        const timeoutMs = number(input.timeout_ms, 60 * 60 * 1000)
        const result = await runner(argv, { signal, timeoutMs, cwd: root })
        const logPath = await saveLog(cwd, config.logDirectory, `fastlane-${slug(lane)}`, result)
        return {
          ...report,
          ok: result.ok,
          lane,
          root,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          output: clip(tailLines(stripAnsi(`${result.stdout}\n${result.stderr}`).trim(), 60), 5000),
          ...(logPath ? { logPath } : {}),
          ...(result.ok ? {} : { error: clip(stripAnsi(result.stderr || result.stdout).trim(), 1200) }),
        }
      } catch (error) {
        return { ...report, ok: false, error: errorMessage(error), durationMs: Date.now() - startedAt }
      }
    },
    presentCall: (args) => ({ card: 'terminal', title: `Release: ${args && typeof args === 'object' ? text(args.action, 'archive') : 'archive'}` }),
    presentResult: (_args, result) => ({
      card: 'terminal',
      title: result && result.ok ? 'Release' : 'Release failed',
      output: clip(formatReleaseReport(result), 5000),
      exitCode: result && result.ok ? 0 : 1,
    }),
  }
}

export function createReleaseTools(ctx, config, runner) {
  return [createReleaseTool(ctx, config, runner)]
}
