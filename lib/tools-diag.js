/**
 * `apple_dev_signing` and `apple_dev_logs` — the diagnostics half of the
 * Apple Dev tool surface.
 *
 * Both tools are read-only and delegate to `lib/signing.js` /
 * `lib/logs.js`; this module owns the model-facing parameter schemas and the
 * concise text renderers. Child processes only run through the injected
 * `runner`, paths resolve against the session working directory, and a
 * non-macOS Host returns a readable `{ ok: false, error }` result.
 *
 * Empty is normal here: a machine with no code-signing identities and no
 * provisioning profiles is a successful answer, not an error.
 */
import { clip, errorMessage, formatBytes, plural, renderText, sections, tailLines } from './format.js'
import { platformProblem, resolveUserPath, sessionDirectory } from './runner.js'
import { listSimulators, resolveDevice } from './simulator.js'
import {
  DEFAULT_PROFILE_LIMIT,
  MAX_PROFILE_LIMIT,
  SIGNING_ACTIONS,
  inspectApp,
  readEntitlements,
  readIdentities,
  readProvisioningProfiles,
  verifyApp,
} from './signing.js'
import {
  DEFAULT_CRASH_LIMIT,
  DEFAULT_LOG_LINES,
  LOG_ACTIONS,
  MAX_CRASH_LIMIT,
  MAX_LOG_LINES,
  buildLogPredicate,
  crashReportDirectories,
  listCrashReports,
  parseLogWindow,
  readCrashReport,
  showLogs,
} from './logs.js'
import { crashFacts, formatSymbolicatedReport, parseIps, readCrashText, symbolicateReport } from './crash.js'

/** Characters of command output handed to the model per result. */
const MAX_TEXT_CHARS = 12000

function clampLimit(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function stringField(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function deviceSummary(device) {
  if (!device || typeof device !== 'object') return undefined
  return {
    udid: device.udid,
    name: device.name,
    platform: device.platform,
    osVersion: device.osVersion,
    state: device.state,
  }
}

function summarizeCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter((device) => device && typeof device.udid === 'string')
    .slice(0, 12)
    .map((device) => deviceSummary(device))
}

function formatCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates : []
  if (list.length === 0) return ''
  const lines = list.map((device) => `- ${device.name} (${device.platform ?? '?'} ${device.osVersion ?? '?'}, ${device.state ?? '?'}): ${device.udid}`)
  return `Simulators available:\n${lines.join('\n')}`
}

function formatTimestamp(value) {
  const text = typeof value === 'string' ? value : ''
  if (text.length === 0) return 'unknown time'
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) return text
  return `${new Date(parsed).toISOString().replace('T', ' ').slice(0, 19)} UTC`
}

function entityValue(value, maxChars = 160) {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') return clip(JSON.stringify(value), maxChars)
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (typeof item === 'string') return item
      if (typeof item === 'number' || typeof item === 'boolean' || item === null) return String(item)
      return clip(JSON.stringify(item), 80)
    })
    return clip(`[${items.join(', ')}]`, maxChars)
  }
  if (typeof value === 'object') return clip(JSON.stringify(value), maxChars)
  return String(value)
}

function warningLines(warnings) {
  const list = Array.isArray(warnings) ? warnings.filter((warning) => typeof warning === 'string' && warning.trim().length > 0) : []
  if (list.length === 0) return ''
  return `Warnings:\n${list.map((warning) => `- ${warning}`).join('\n')}`
}

function formatProfile(profile) {
  const heading = profile.name ?? profile.file ?? '(unnamed profile)'
  const facts = []
  if (profile.expirationDate) facts.push(profile.expired ? `EXPIRED ${String(profile.expirationDate).slice(0, 10)}` : `expires ${String(profile.expirationDate).slice(0, 10)}`)
  if (profile.expiresInDays !== undefined && profile.expired !== true) facts.push(`in ${profile.expiresInDays} day(s)`)
  if (profile.teamName || profile.teamIdentifier) {
    facts.push([profile.teamName, profile.teamIdentifier ? `(${profile.teamIdentifier})` : ''].filter(Boolean).join(' '))
  }
  if (profile.applicationIdentifier) facts.push(`app ${profile.applicationIdentifier}`)
  if (profile.uuid) facts.push(`UUID ${profile.uuid}`)
  if (profile.provisionedDevices !== undefined) facts.push(plural(profile.provisionedDevices, 'device'))
  if (Array.isArray(profile.platform) && profile.platform.length > 0) facts.push(profile.platform.join('/'))
  if (profile.getTaskAllow === true) facts.push('get-task-allow')
  if (profile.isXcodeManaged) facts.push('Xcode-managed')
  const detail = facts.length > 0 ? `\n  ${facts.join('; ')}` : ''
  const error = profile.decodeError ? `\n  decode error: ${profile.decodeError}` : ''
  return `- ${heading}${detail}${error}`
}

function formatSigningResult(value) {
  const report = value && typeof value === 'object' ? value : {}
  const action = typeof report.action === 'string' ? report.action : 'unknown'
  const parts = [`apple_dev_signing · ${action}`]
  const operationFailed = typeof report.error === 'string' && report.error.length > 0
  if (operationFailed) parts.push(`error: ${clip(report.error, 2000)}`)

  if (action === 'identities') {
    const count = Number(report.count) || 0
    parts.push(`Code-signing identities: ${plural(count, 'valid identity', 'valid identities')}`)
    const identities = Array.isArray(report.identities) ? report.identities : []
    if (count === 0 && typeof report.error !== 'string') {
      parts.push('No code-signing identities are installed. Add the Apple ID in Xcode → Settings → Accounts (Manage Certificates → Apple Development), or import a .p12 / provisioning profile.')
    } else if (count > 0) {
      parts.push(identities.map((identity) => `- ${identity.hash}  ${identity.name}`).join('\n'))
      if (report.truncated) parts.push(`(showing the first ${identities.length} identities; raise \`limit\` for more)`)
    }
    const warnings = warningLines(report.warnings)
    if (warnings) parts.push(warnings)
  } else if (action === 'profiles') {
    const profiles = Array.isArray(report.profiles) ? report.profiles : []
    const total = Number(report.total)
    const count = Number(report.count)
    const shown = Number.isFinite(count) ? count : profiles.length
    const found = Number.isFinite(total) ? ` of ${total} found` : ''
    parts.push(`Provisioning profiles: ${shown} shown${found}`)
    if (profiles.length === 0) {
      parts.push('No .mobileprovision profiles were found. This is normal until Xcode downloads one for a team (Xcode → Settings → Accounts → Download Manual Profiles).')
    } else {
      parts.push(profiles.map(formatProfile).join('\n'))
    }
    if (report.truncated) parts.push('(more profiles exist; raise `limit` or inspect a specific directory with `path`)')
    const directories = Array.isArray(report.directories) ? report.directories : []
    if (directories.length > 0) {
      parts.push(`Scanned:\n${directories.map((entry) => `- ${entry.directory}: ${entry.exists ? plural(entry.files, 'profile file') : 'directory not found'}`).join('\n')}`)
    }
    const warnings = warningLines(report.warnings)
    if (warnings) parts.push(warnings)
  } else if (action === 'inspect') {
    if (operationFailed) return sections(...parts)
    parts.push(`Code signature: ${report.path ?? 'unknown path'}`)
    const details = report.details && typeof report.details === 'object' ? report.details : {}
    const lines = [`- status: ${report.signed ? 'signed' : 'NOT SIGNED'}`]
    const add = (label, field) => {
      if (field === undefined || field === null || String(field).length === 0) return
      lines.push(`- ${label}: ${field}`)
    }
    add('identifier', details.identifier)
    if (report.signed) add('team', details.teamIdentifier ?? 'not set')
    add('format', details.format)
    if (details.codeDirectory && (details.codeDirectory.version || details.codeDirectory.size)) {
      const directory = details.codeDirectory
      add('code directory', `v${directory.version ?? '?'}, ${directory.size ?? '?'} bytes${directory.location ? `, ${directory.location}` : ''}`)
    }
    if (details.flags && details.flags.raw) {
      add('flags', `${details.flags.raw} (${Array.isArray(details.flags.names) && details.flags.names.length > 0 ? details.flags.names.join(', ') : 'none'})`)
    }
    add('hash type', details.hashType)
    add('cdhash', details.cdhash)
    add('signature', details.signature)
    add('signature size', details.signatureSize)
    add('signed time', details.signedTime)
    if (Array.isArray(details.authorities) && details.authorities.length > 0) add('authorities', details.authorities.join(' → '))
    if (report.requirements) add('designated requirement', clip(report.requirements, 400))
    if (report.note) add('note', report.note)
    parts.push(lines.join('\n'))
    const warnings = warningLines(report.warnings)
    if (warnings) parts.push(warnings)
  } else if (action === 'entitlements') {
    if (operationFailed) return sections(...parts)
    parts.push(`Entitlements: ${report.path ?? 'unknown path'}`)
    const entitlements = report.entitlements && typeof report.entitlements === 'object' ? report.entitlements : {}
    const keys = Object.keys(entitlements).sort((left, right) => left.localeCompare(right))
    if (keys.length === 0) {
      parts.push(report.note ?? 'No entitlements are present in the signature.')
    } else {
      parts.push(`${plural(keys.length, 'entitlement')}:\n${keys.map((key) => `- ${key} = ${entityValue(entitlements[key])}`).join('\n')}`)
    }
    const warnings = warningLines(report.warnings)
    if (warnings) parts.push(warnings)
  } else if (action === 'verify') {
    if (operationFailed && !report.signature && !report.spctl) return sections(...parts)
    parts.push(`Signature verification: ${report.path ?? 'unknown path'}`)
    const signature = report.signature && typeof report.signature === 'object' ? report.signature : {}
    const spctl = report.spctl && typeof report.spctl === 'object' ? report.spctl : {}
    const lines = []
    lines.push(`- codesign --verify --deep --strict: ${signature.ok ? 'PASS' : 'FAIL'}${signature.exitCode !== null && signature.exitCode !== undefined ? ` (exit ${signature.exitCode})` : ''}`)
    if (signature.spawnError) lines.push(`  ${signature.spawnError}`)
    if (!signature.ok && signature.output) lines.push(`  ${clip(signature.output, 600)}`)
    if (spctl.available === false) {
      lines.push('- spctl --assess: unavailable (spctl could not run)')
    } else {
      const verdict = spctl.accepted ? 'ACCEPTED' : 'REJECTED'
      lines.push(`- spctl --assess: ${verdict}${spctl.reason ? ` (${spctl.reason})` : ''}`)
      if (spctl.source || spctl.origin) {
        lines.push(`  ${[spctl.source ? `source=${spctl.source}` : '', spctl.origin ? `origin=${spctl.origin}` : ''].filter(Boolean).join(', ')}`)
      }
      if (!spctl.accepted && spctl.output) lines.push(`  ${clip(spctl.output, 600)}`)
    }
    lines.push(`- verdict: ${report.verified ? 'signature valid' : 'signature INVALID'}; Gatekeeper ${spctl.available === false ? 'not assessed' : spctl.accepted ? 'accepted' : 'rejected'}`)
    parts.push(lines.join('\n'))
  }

  if (action !== 'identities' && action !== 'profiles') {
    const warnings = warningLines(report.warnings)
    if (warnings && !parts.includes(warnings)) parts.push(warnings)
  }
  return sections(...parts)
}

function formatLogsResult(value) {
  const report = value && typeof value === 'object' ? value : {}
  const action = typeof report.action === 'string' ? report.action : 'unknown'
  const parts = [`apple_dev_logs · ${action}`]
  if (report.device) {
    const device = report.device
    parts.push(`Simulator: ${device.name} (${device.platform ?? '?'} ${device.osVersion ?? '?'}, ${device.state ?? '?'}) — ${device.udid}`)
  }
  if (typeof report.error === 'string' && report.error.length > 0) {
    parts.push(`error: ${clip(report.error, 2000)}`)
    const candidates = formatCandidates(report.candidates)
    if (candidates) parts.push(candidates)
  }

  if (action === 'show') {
    if (typeof report.error !== 'string') {
      const filterBits = [`last ${report.window ?? '?'}`]
      if (report.predicate) filterBits.push(`predicate: ${report.predicate}`)
      parts.push(`- ${filterBits.join('; ')}`)
      const totalLines = Number(report.totalLines) || 0
      const lineLimit = Number(report.lineLimit) || 0
      const shownLines = typeof report.output === 'string' && report.output.length > 0 ? report.output.split(/\r?\n/).length : 0
      parts.push(`- captured ${plural(totalLines, 'log line')}; showing ${shownLines}${lineLimit > 0 ? ` (limit ${lineLimit})` : ''}${report.outputTruncated ? '; the runner truncated the stream, narrow `last` or add filters' : ''}`)
      if (report.durationMs !== undefined) parts.push(`- query took ${report.durationMs}ms`)
      const output = typeof report.output === 'string' ? report.output.trim() : ''
      parts.push(output.length > 0 ? output : '(no log lines matched the window/filters)')
    }
  } else if (action === 'crashes') {
    const reports = Array.isArray(report.reports) ? report.reports : []
    const directories = Array.isArray(report.directories) ? report.directories : []
    if (typeof report.error !== 'string') {
      const count = Number(report.count) || 0
      const total = Number(report.total)
      const found = Number.isFinite(total) && total > count ? ` of ${total} found` : ''
      parts.push(`- crash reports: ${plural(count, 'report')}${found} (newest first)`)
      if (reports.length > 0) {
        parts.push(reports.map((entry) => `- ${entry.name}\n  ${formatTimestamp(entry.modified)} · ${formatBytes(entry.size)} · ${entry.path}`).join('\n'))
      } else {
        parts.push('No .ips/.crash reports were found in the searched directories.')
      }
      if (directories.length > 0) {
        parts.push(`Searched:\n${directories.map((entry) => `- ${entry.directory}: ${entry.exists ? plural(entry.count, 'report') : 'directory not found'}`).join('\n')}`)
      }
    }
    if (report.newest) {
      const newest = report.newest
      const metadata = newest.metadata && typeof newest.metadata === 'object' ? newest.metadata : {}
      const facts = []
      if (metadata.appName) facts.push(metadata.appName)
      if (metadata.version) facts.push(`version ${metadata.version}`)
      if (metadata.osVersion) facts.push(metadata.osVersion)
      if (metadata.bugType) facts.push(`bug_type ${metadata.bugType}`)
      if (metadata.exceptionType) facts.push(metadata.exceptionType)
      if (metadata.timestamp) facts.push(formatTimestamp(metadata.timestamp))
      parts.push(`Newest report: ${newest.name}\n- ${facts.join(' · ') || 'metadata unavailable'}\n- path: ${newest.path}`)
      const summary = newest.summary && typeof newest.summary === 'object' ? newest.summary : null
      if (summary) {
        const detail = []
        if (summary.exception?.type) detail.push(`${summary.exception.type}${summary.exception.signal ? ` / ${summary.exception.signal}` : ''}`)
        if (summary.termination?.indicator) detail.push(summary.termination.indicator)
        if (typeof summary.threadCount === 'number' && summary.threadCount > 0) detail.push(`${summary.threadCount} threads`)
        if (typeof summary.faultingThread === 'number' && summary.faultingThread >= 0) detail.push(`thread ${summary.faultingThread} crashed`)
        if (detail.length > 0) parts.push(`- ${detail.join(' · ')}`)
      }
      if (typeof newest.content === 'string' && newest.content.length > 0) {
        parts.push(newest.content)
        if (newest.contentTruncated) parts.push(`(report content clipped; the complete file is at ${newest.path})`)
      } else {
        parts.push('(report content omitted; pass include_content: true, or read the path)')
      }
    }
    const warnings = warningLines(report.warnings)
    if (warnings) parts.push(warnings)
  } else if (action === 'symbolicate') {
    if (typeof report.error !== 'string') parts.push(formatSymbolicatedReport(report))
  }

  return sections(...parts)
}

/* ------------------------------------------------------------------------- *
 * apple_dev_signing
 * ------------------------------------------------------------------------- */

function createSigningTool(ctx, config, runner) {
  return {
    name: 'apple_dev_signing',
    description:
      'Inspect Apple code signing and provisioning on this Mac (read-only). Actions: identities (code-signing identities from the login keychain via `security find-identity`), profiles (decode .mobileprovision profiles from the Xcode stores: name, UUID, team, app id, expiration, platform, device count), inspect (codesign details for an .app/.framework/binary: identifier, team, authority chain, CDHash, flags, designated requirement), entitlements (the signature entitlements plist as JSON), verify (`codesign --verify --deep --strict` plus a Gatekeeper `spctl --assess`). Empty keychain/profiles are normal successful answers, not errors. Read-only: no signing, no keychain writes.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: SIGNING_ACTIONS,
          description: 'Which signing query to run.',
        },
        path: {
          type: 'string',
          description: 'Path to the .app bundle, framework, binary or file (inspect/entitlements/verify), or a directory of .mobileprovision files (profiles, overrides the default Xcode stores). Defaults to the session working directory; relative paths resolve against it and `~/` is expanded.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_PROFILE_LIMIT,
          description: `Maximum identities/profiles returned (default ${DEFAULT_PROFILE_LIMIT}, max ${MAX_PROFILE_LIMIT}).`,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => renderText(formatSigningResult(value)),
    },
    timeoutMs: 300000,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const action = stringField(input.action)
      if (!SIGNING_ACTIONS.includes(action)) {
        throw new Error(`\`action\` must be one of: ${SIGNING_ACTIONS.join(', ')}.`)
      }
      const platformError = platformProblem()
      if (platformError) return { ok: false, tool: 'apple_dev_signing', action, error: platformError }

      const cwd = sessionDirectory(ctx, exec)
      const signal = exec ? exec.signal : undefined
      const limit = clampLimit(input.limit, DEFAULT_PROFILE_LIMIT, 1, MAX_PROFILE_LIMIT)
      const requestedPath = stringField(input.path)
      const path = resolveUserPath(cwd, requestedPath)

      if (action === 'identities') {
        const result = await readIdentities(runner, { cwd, signal })
        const identities = Array.isArray(result.identities) ? result.identities : []
        return {
          ...result,
          tool: 'apple_dev_signing',
          action,
          identities: identities.slice(0, limit),
          truncated: identities.length > limit,
        }
      }

      if (action === 'profiles') {
        const result = await readProvisioningProfiles(runner, {
          cwd,
          signal,
          limit,
          directories: requestedPath.length > 0 ? [path] : undefined,
        })
        return { ...result, tool: 'apple_dev_signing', action }
      }

      if (action === 'inspect') {
        const result = await inspectApp(runner, path, { cwd, signal })
        return { ...result, tool: 'apple_dev_signing', action }
      }

      if (action === 'entitlements') {
        const result = await readEntitlements(runner, path, { cwd, signal })
        return { ...result, tool: 'apple_dev_signing', action }
      }

      const result = await verifyApp(runner, path, { cwd, signal })
      return { ...result, tool: 'apple_dev_signing', action }
    },
  }
}

/* ------------------------------------------------------------------------- *
 * apple_dev_logs
 * ------------------------------------------------------------------------- */

function createLogsTool(ctx, config, runner) {
  return {
    name: 'apple_dev_logs',
    description:
      'Read simulator diagnostics (read-only). Actions: show (unified log output from a booted simulator via `xcrun simctl spawn <udid> log show`, filtered by process/subsystem/category/message text and a time window), crashes (recent .ips/.crash crash reports for a simulator and the host, newest first, with a parsed summary and path for the newest; pass include_content=true to also return its text), symbolicate (parse an .ips report, resolve the crashed thread with `atos` against a .dSYM/.app, and return symbolized frames; frames the report already symbolized are kept). The device is a UDID, an exact simulator name, or "booted"; omitted means the only booted simulator. Output is line- and character-capped — narrow `last` or add filters instead of raising `limit` for very noisy logs.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: LOG_ACTIONS,
          description: '`show` for unified logs, `crashes` for crash reports, `symbolicate` for symbolized crash frames.',
        },
        device: {
          type: 'string',
          description: 'Simulator UDID, exact device name, or "booted". Empty means the only booted simulator; for `crashes` an empty value falls back to host crash reports when no simulator is booted.',
        },
        process: {
          type: 'string',
          description: 'Only log lines from this process name (predicate `process == "..."`).',
        },
        subsystem: {
          type: 'string',
          description: 'Only lines from this logging subsystem (predicate `subsystem == "..."`), e.g. com.example.app or com.apple.network.',
        },
        category: {
          type: 'string',
          description: 'Only lines from this logging category (predicate `category == "..."`).',
        },
        message_contains: {
          type: 'string',
          description: 'Only lines whose event message contains this case-insensitive text (predicate `eventMessage CONTAINS[c] "..."`).',
        },
        last: {
          type: 'string',
          description: 'Time window for `show`: e.g. 30s, 5m, 2h, 1d. Default 5m; at most 24h.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LOG_LINES,
          description: `For show: maximum output lines (default ${DEFAULT_LOG_LINES}, max ${MAX_LOG_LINES}). For crashes: maximum reports (default ${DEFAULT_CRASH_LIMIT}, max ${MAX_CRASH_LIMIT}); larger values are clamped.`,
        },
        path: {
          type: 'string',
          description: 'For crashes only: crash-report directory to search instead of the simulator/host defaults.',
        },
        include_content: {
          type: 'boolean',
          description: 'For crashes: include the newest report text (default false; the path and a parsed summary are returned instead).',
        },
        report: {
          type: 'string',
          description: 'For symbolicate: path to the .ips report (use action=crashes to find one). Relative paths resolve against the session directory.',
        },
        dsym: {
          type: 'string',
          description: 'For symbolicate: a .dSYM bundle, a directory containing dSYMs, or the .app whose sibling .dSYM should be used.',
        },
        max_frames: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'For symbolicate: frames per thread (default 40, max 200).',
        },
        all_threads: {
          type: 'boolean',
          description: 'For symbolicate: include every thread instead of only the crashed one.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => renderText(formatLogsResult(value)),
    },
    timeoutMs: 240000,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const action = stringField(input.action)
      if (!LOG_ACTIONS.includes(action)) {
        throw new Error(`\`action\` must be one of: ${LOG_ACTIONS.join(', ')}.`)
      }
      const platformError = platformProblem()
      if (platformError) return { ok: false, tool: 'apple_dev_logs', action, error: platformError }

      const cwd = sessionDirectory(ctx, exec)
      const signal = exec ? exec.signal : undefined
      const selector = stringField(input.device)

      if (action === 'show') {
        const limit = clampLimit(input.limit, DEFAULT_LOG_LINES, 1, MAX_LOG_LINES)
        const window = parseLogWindow(input.last)
        const predicate = buildLogPredicate({
          process: input.process,
          subsystem: input.subsystem,
          category: input.category,
          message_contains: input.message_contains,
        })

        const listed = await listSimulators(runner, { signal })
        if (!listed.ok) {
          return { ok: false, tool: 'apple_dev_logs', action, error: `Could not list simulator devices: ${clip(listed.error ?? 'simctl failed', 1000)}` }
        }
        const resolved = resolveDevice(listed.devices, selector)
        if (!resolved.device) {
          return {
            ok: false,
            tool: 'apple_dev_logs',
            action,
            error: resolved.error,
            candidates: summarizeCandidates(resolved.candidates),
          }
        }
        const shown = await showLogs(runner, resolved.device, { cwd, signal, window: window.text, predicate })
        const report = {
          ok: shown.ok,
          tool: 'apple_dev_logs',
          action,
          device: deviceSummary(resolved.device),
          window: window.text,
          predicate,
          command: shown.command,
          exitCode: shown.exitCode,
          durationMs: shown.durationMs,
        }
        if (resolved.note) report.warnings = [resolved.note]
        if (!shown.ok) {
          report.error = shown.error
          return report
        }
        const outputText = typeof shown.output === 'string' ? shown.output : ''
        const totalLines = outputText.length > 0 ? outputText.split(/\r?\n/).length : 0
        report.totalLines = totalLines
        report.lineLimit = limit
        report.outputTruncated = shown.outputTruncated
        report.output = clip(tailLines(outputText, limit), MAX_TEXT_CHARS)
        return report
      }

      if (action === 'symbolicate') {
        const requested = stringField(input.report)
        if (requested.length === 0) {
          return {
            ok: false,
            tool: 'apple_dev_logs',
            action,
            error: '`report` is required for symbolicate: pass the .ips path (use action=crashes to list recent reports).',
          }
        }
        const reportPath = resolveUserPath(cwd, requested)
        try {
          const text = await readCrashText(reportPath)
          const result = await symbolicateReport({
            text,
            dsym: stringField(input.dsym) ? resolveUserPath(cwd, input.dsym) : '',
            allThreads: input.all_threads === true,
            maxFrames: clampLimit(input.max_frames, 40, 1, 200),
            runner,
            signal,
          })
          return { ...result, tool: 'apple_dev_logs', action, report: reportPath }
        } catch (error) {
          return { ok: false, tool: 'apple_dev_logs', action, report: reportPath, error: errorMessage(error) }
        }
      }

      // crashes
      const limit = clampLimit(input.limit, DEFAULT_CRASH_LIMIT, 1, MAX_CRASH_LIMIT)
      const override = stringField(input.path)
      const warnings = []
      let device
      const directories = []
      if (override.length > 0) {
        directories.push(resolveUserPath(cwd, override))
      } else {
        const listed = await listSimulators(runner, { signal })
        if (listed.ok) {
          const resolved = resolveDevice(listed.devices, selector)
          if (resolved.device) {
            device = resolved.device
            if (resolved.note) warnings.push(resolved.note)
          } else if (selector.length > 0) {
            return {
              ok: false,
              tool: 'apple_dev_logs',
              action,
              error: resolved.error,
              candidates: summarizeCandidates(resolved.candidates),
            }
          } else {
            warnings.push(`No simulator selected (${resolved.error}); showing host crash reports only.`)
          }
        } else if (selector.length > 0) {
          return { ok: false, tool: 'apple_dev_logs', action, error: `Could not list simulator devices: ${clip(listed.error ?? 'simctl failed', 1000)}` }
        } else {
          warnings.push(`Could not list simulator devices (${clip(listed.error ?? 'simctl failed', 300)}); showing host crash reports only.`)
        }
        directories.push(...crashReportDirectories(device ? device.udid : undefined))
      }

      const listedReports = await listCrashReports(directories, { limit })
      let newest
      const first = listedReports.reports[0]
      if (first) {
        const read = await readCrashReport(first.path)
        if (read.ok) {
          let summary
          try {
            summary = crashFacts(parseIps(read.text))
          } catch {
            /* legacy .crash text: metadata is all we can offer */
          }
          const includeContent = input.include_content === true
          const content = includeContent ? clip(read.text, MAX_TEXT_CHARS) : undefined
          newest = {
            name: first.name,
            path: first.path,
            size: read.size,
            modified: read.modified,
            metadata: read.metadata,
            ...(summary ? { summary } : {}),
            ...(includeContent
              ? { content, contentTruncated: read.truncated || read.text.length > MAX_TEXT_CHARS }
              : {}),
          }
        } else {
          warnings.push(read.error)
        }
      }
      const report = {
        ok: true,
        tool: 'apple_dev_logs',
        action,
        device: deviceSummary(device),
        directories: listedReports.scanned,
        count: listedReports.reports.length,
        total: listedReports.total,
        truncated: listedReports.truncated,
        reports: listedReports.reports,
        newest,
      }
      if (warnings.length > 0) report.warnings = warnings
      return report
    },
  }
}

/**
 * Create the two diagnostics tool definitions.
 *
 * @param {object} ctx Cordis plugin context.
 * @param {object} config normalized config from `resolveConfig`.
 * @param {Function} runner command executor from `createRunner`.
 */
export function createDiagTools(ctx, config, runner) {
  return [createSigningTool(ctx, config, runner), createLogsTool(ctx, config, runner)]
}
