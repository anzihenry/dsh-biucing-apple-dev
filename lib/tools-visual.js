/**
 * `apple_dev_visual`: screenshot baselines and pixel regression checks.
 *
 * Capture comes from a simulator (simctl), an existing PNG, or an Xcode MCP
 * Preview render. Comparison is PNG → BMP via sips, an in-process RGB diff
 * with a per-channel tolerance, and a red-marked diff PNG on mismatch.
 */
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { clip, errorMessage, formatBytes, formatDuration, renderText } from './format.js'
import { platformProblem, resolveUserPath, sessionDirectory } from './runner.js'
import { listSimulators, resolveDevice, screenshotSimulator } from './simulator.js'
import { collectImagePaths } from './tools-mcp.js'
import {
  DEFAULT_CHANNEL_TOLERANCE,
  DEFAULT_MAX_DIFF_RATIO,
  VISUAL_SOURCES,
  approveBaseline,
  bmpToPng,
  compareRgb,
  encodeBmp,
  listVisualEntries,
  loadPngPixels,
  storeCapture,
  visualPaths,
  writeJsonFile,
} from './visual.js'

export const VISUAL_ACTIONS = ['capture', 'compare', 'approve', 'list']

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function number(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Parse JSON text, falling back to the raw string. */
function safeJson(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function defaultName(input, source) {
  const explicit = text(input.name).trim()
  if (explicit.length > 0) return explicit
  if (source === 'preview') {
    const file = text(input.source_file).trim()
    return file.length > 0 ? basename(file).replace(/\.[^.]+$/, '') : 'preview'
  }
  if (source === 'file') {
    const image = text(input.image).trim()
    return image.length > 0 ? basename(image).replace(/\.[^.]+$/, '') : 'image'
  }
  return 'simulator'
}

/** Text report for `apple_dev_visual`. */
export function formatVisualReport(value) {
  if (!value || typeof value !== 'object') return 'No visual result was returned.'
  if (value.error) return `Visual ${value.action || 'action'} failed: ${value.error}`
  if (value.action === 'list') {
    const entries = Array.isArray(value.entries) ? value.entries : []
    if (entries.length === 0) return 'No visual baselines yet. Run action=capture, then action=approve.'
    return clip([
      `Visual baselines (${entries.length})`,
      ...entries.map((entry) => {
        const bits = [`- ${entry.name}`]
        if (entry.baseline) bits.push('baseline')
        if (entry.latest) bits.push('latest')
        if (entry.lastResult && typeof entry.lastResult.ratio === 'number') {
          bits.push(`${(entry.lastResult.ratio * 100).toFixed(2)}% diff`)
        }
        return bits.join(' · ')
      }),
    ].join('\n'))
  }
  const lines = [`Visual ${value.action}: ${value.name || 'default'}`]
  if (value.latest) lines.push(`- latest: ${value.latest}${value.meta?.capturedAt ? ` (${value.meta.capturedAt})` : ''}`)
  if (value.baseline) lines.push(`- baseline: ${value.baseline}`)
  if (value.action === 'capture') {
    lines.push(`- source: ${value.source || 'unknown'}${value.meta?.device ? ` · ${value.meta.device}` : ''}`)
    if (value.bytes) lines.push(`- size: ${formatBytes(value.bytes)}`)
    lines.push(value.baselineExists ? '- baseline exists; run action=compare' : '- no baseline yet; run action=approve after checking the capture')
  }
  if (value.action === 'approve') {
    lines.push(value.message || '- latest.png is now the baseline')
  }
  if (value.action === 'compare') {
    const percent = typeof value.ratio === 'number' ? (value.ratio * 100).toFixed(3) : '?'
    lines.push(`- result: ${value.match ? 'MATCH' : 'DIFF'} — ${percent}% of pixels differ (tolerance ${value.tolerance}/255, limit ${(value.maxDiffRatio * 100).toFixed(3)}%)`)
    lines.push(`- pixels: ${value.diffPixels} / ${value.totalPixels}${value.bbox ? `, bbox ${value.bbox.x},${value.bbox.y} ${value.bbox.width}×${value.bbox.height}` : ''}`)
    if (value.sizeMismatch) lines.push(`- size changed: ${value.width}×${value.height} → ${value.currentWidth}×${value.currentHeight}`)
    if (value.diffPath) lines.push(`- diff image: ${value.diffPath}`)
  }
  if (value.durationMs) lines.push(`- took ${formatDuration(value.durationMs)}`)
  return clip(lines.join('\n'))
}

/** Grab a Preview snapshot through Xcode MCP and return a local PNG path. */
async function capturePreview(mcp, input, destination, { cwd, signal, timeoutMs } = {}) {
  if (!mcp) throw new Error('Preview capture needs the Xcode MCP client; enable mcpEnabled and run Xcode 26+.')
  const sourceFile = text(input.source_file).trim()
  if (sourceFile.length === 0) throw new Error('source_file is required for source=preview (project-relative Swift file with a #Preview).')
  const arguments_ = { sourceFilePath: sourceFile }
  const workspace = text(input.workspace).trim()
  if (workspace.length > 0) arguments_.workspaceIdentifier = workspace
  const displayMode = text(input.display_mode).trim()
  if (displayMode.length > 0) arguments_.displayMode = displayMode
  const result = await mcp.callTool('RenderPreview', arguments_, { cwd, signal, timeoutMs })
  if (result.isError) throw new Error(clip(result.text || 'RenderPreview failed', 1200))
  const json = safeJson(result.text)
  const artifact = collectImagePaths(json)[0]
  if (artifact) {
    await copyFile(artifact, destination)
    return { destination, previewName: text(json?.displayName) }
  }
  const inline = Array.isArray(result.images) ? result.images[0] : undefined
  if (inline && typeof inline.data === 'string') {
    await writeFile(destination, Buffer.from(inline.data, 'base64'))
    return { destination, previewName: text(json?.displayName) }
  }
  throw new Error('RenderPreview returned no image; check the preview renders in Xcode.')
}

function createVisualTool(ctx, config, runner, mcp) {
  return {
    name: 'apple_dev_visual',
    description:
      'Screenshot baselines and pixel regression checks. Actions: capture (take a simulator screenshot, copy an existing PNG, or render an Xcode MCP Preview), approve (promote the latest capture to the baseline), compare (pixel-diff latest against baseline with a per-channel tolerance and write a red-marked diff PNG), list (all baseline entries). Captures and diffs live under .apple-dev/visual/<name>/. Use it after UI changes to prove a screen did not move, or to review a Preview render against an approved reference.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: VISUAL_ACTIONS, description: 'capture, approve, compare or list.' },
        name: { type: 'string', description: 'Baseline key (defaults from the source: preview file name, image name, or "simulator").' },
        source: { type: 'string', enum: VISUAL_SOURCES, description: 'capture source: simulator (default), preview (Xcode MCP), or file.' },
        device: { type: 'string', description: 'For source=simulator: simulator UDID or exact name; empty means the only booted device.' },
        image: { type: 'string', description: 'For source=file: path to the PNG to capture.' },
        workspace: { type: 'string', description: 'For source=preview: Xcode workspace identifier (see apple_dev_xcode_status workspaces).' },
        source_file: { type: 'string', description: 'For source=preview: project-relative Swift file containing #Preview.' },
        display_mode: { type: 'string', description: 'For source=preview: "static" (default) or "interactive".' },
        tolerance: { type: 'number', description: `Per-channel tolerance 0-255 for compare (default ${DEFAULT_CHANNEL_TOLERANCE}).` },
        max_diff_ratio: { type: 'number', description: `Fraction of differing pixels still treated as a match (default ${DEFAULT_MAX_DIFF_RATIO}).` },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(formatVisualReport(value)),
    },
    timeoutMs: 600000,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const problem = platformProblem()
      if (problem) return { tool: 'apple_dev_visual', ok: false, error: problem }
      const action = text(input.action)
      if (!VISUAL_ACTIONS.includes(action)) throw new Error(`action must be one of: ${VISUAL_ACTIONS.join(', ')}`)
      const cwd = sessionDirectory(ctx, exec)
      const signal = exec.signal
      const startedAt = Date.now()
      const report = { tool: 'apple_dev_visual', action, ok: false }

      try {
        if (action === 'list') {
          const root = visualPaths(cwd, config, 'default').root
          const entries = await listVisualEntries(root)
          return { ...report, ok: true, entries, durationMs: Date.now() - startedAt }
        }

        if (action === 'capture') {
          const source = text(input.source, 'simulator')
          if (!VISUAL_SOURCES.includes(source)) throw new Error(`source must be one of: ${VISUAL_SOURCES.join(', ')}`)
          if (source === 'preview' && !config.mcpEnabled) throw new Error('source=preview needs mcpEnabled: true (Xcode 26+).')
          let name = defaultName(input, source)
          const root = visualPaths(cwd, config, name).root
          await mkdir(root, { recursive: true })
          // Capture into a staging file outside the entry so a Preview can still
          // change the entry name (its display name) before it is stored.
          const staging = join(root, `.capture-${Date.now().toString(36)}.png`)
          const metadata = { source }

          if (source === 'file') {
            const requested = text(input.image).trim()
            if (requested.length === 0) throw new Error('image is required for source=file.')
            const sourcePath = resolveUserPath(cwd, requested)
            await copyFile(sourcePath, staging)
            metadata.image = sourcePath
          } else if (source === 'simulator') {
            const listed = await listSimulators(runner, { signal })
            if (!listed.ok) throw new Error(`Could not list simulators: ${clip(listed.error, 600)}`)
            const resolved = resolveDevice(listed.devices, text(input.device))
            if (!resolved.device) return { ...report, ok: false, error: resolved.error, candidates: resolved.candidates }
            const shot = await screenshotSimulator(runner, resolved.device, staging, { signal })
            if (!shot.ok) throw new Error(shot.error || 'simctl screenshot failed')
            metadata.device = `${resolved.device.name} (${resolved.device.platform} ${resolved.device.osVersion})`
            metadata.udid = resolved.device.udid
          } else {
            const captured = await capturePreview(mcp, input, staging, { cwd, signal, timeoutMs: config.mcpToolCallTimeoutMs })
            if (captured.previewName && text(input.name).trim().length === 0) name = captured.previewName
            metadata.workspace = text(input.workspace).trim()
            metadata.sourceFile = text(input.source_file).trim()
          }

          const paths = visualPaths(cwd, config, name)
          await mkdir(paths.directory, { recursive: true })
          metadata.name = name
          const meta = await storeCapture(paths, staging, metadata)
          await unlink(staging).catch(() => {})
          const baselineExists = Boolean(await stat(paths.baseline).catch(() => undefined))
          return {
            ...report,
            ok: true,
            name,
            latest: paths.latest,
            baselineExists,
            meta,
            bytes: meta.bytes,
            source,
            durationMs: Date.now() - startedAt,
          }
        }

        const name = defaultName(input, text(input.source, 'simulator'))
        const paths = visualPaths(cwd, config, name)

        if (action === 'approve') {
          const meta = await approveBaseline(paths)
          return { ...report, ok: true, name, latest: paths.latest, baseline: paths.baseline, meta, message: 'latest.png is now the baseline', durationMs: Date.now() - startedAt }
        }

        // compare
        const [baselineInfo, latestInfo] = await Promise.all([
          stat(paths.baseline).catch(() => undefined),
          stat(paths.latest).catch(() => undefined),
        ])
        if (!baselineInfo) return { ...report, ok: false, name, error: 'No baseline yet: run action=approve after a capture.' }
        if (!latestInfo) return { ...report, ok: false, name, error: 'No latest capture yet: run action=capture first.' }
        await mkdir(paths.converted, { recursive: true })
        const baselineBmp = join(paths.converted, 'baseline.bmp')
        const latestBmp = join(paths.converted, 'latest.bmp')
        const base = await loadPngPixels(runner, paths.baseline, baselineBmp, { signal })
        const current = await loadPngPixels(runner, paths.latest, latestBmp, { signal })
        const tolerance = Math.max(0, Math.min(255, Math.trunc(number(input.tolerance, config.visualTolerance ?? DEFAULT_CHANNEL_TOLERANCE))))
        const maxDiffRatio = Math.max(0, Math.min(1, number(input.max_diff_ratio, config.visualMaxDiffRatio ?? DEFAULT_MAX_DIFF_RATIO)))
        const comparison = compareRgb(base, current, { tolerance })
        let diffPath
        if (!comparison.sizeMismatch && comparison.diffPixels > 0) {
          const diffBmp = join(paths.converted, 'diff.bmp')
          await writeFile(diffBmp, encodeBmp(comparison.width, comparison.height, comparison.diffRgb))
          await bmpToPng(runner, diffBmp, paths.diff, { signal })
          diffPath = paths.diff
          await unlink(diffBmp).catch(() => {})
        }
        await Promise.all([unlink(baselineBmp).catch(() => {}), unlink(latestBmp).catch(() => {})])
        const match = !comparison.sizeMismatch && comparison.ratio <= maxDiffRatio
        const result = {
          ...report,
          ok: true,
          name,
          match,
          ratio: comparison.ratio,
          diffPixels: comparison.diffPixels,
          totalPixels: comparison.totalPixels,
          bbox: comparison.bbox,
          tolerance,
          maxDiffRatio,
          width: comparison.width,
          height: comparison.height,
          ...(comparison.sizeMismatch
            ? { sizeMismatch: true, currentWidth: comparison.currentWidth, currentHeight: comparison.currentHeight }
            : {}),
          baseline: paths.baseline,
          latest: paths.latest,
          ...(diffPath ? { diffPath } : {}),
          durationMs: Date.now() - startedAt,
        }
        await writeJsonFile(paths.result, {
          name,
          match,
          ratio: result.ratio,
          diffPixels: result.diffPixels,
          totalPixels: result.totalPixels,
          tolerance,
          maxDiffRatio,
          at: new Date().toISOString(),
        })
        return result
      } catch (error) {
        return { ...report, ok: false, error: errorMessage(error), durationMs: Date.now() - startedAt }
      }
    },
    presentCall: (args) => ({ card: 'terminal', title: `Visual: ${args && typeof args === 'object' ? text(args.action, 'capture') : 'capture'}` }),
    presentResult: (_args, result) => ({
      card: 'terminal',
      title: result && result.ok ? 'Visual check' : 'Visual check failed',
      output: clip(formatVisualReport(result), 4000),
      exitCode: result && result.ok ? 0 : 1,
    }),
  }
}

export function createVisualTools(ctx, config, runner, mcp) {
  return [createVisualTool(ctx, config, runner, mcp)]
}
