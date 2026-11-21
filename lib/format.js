/**
 * Small text helpers shared by every Apple Dev tool.
 *
 * Tool results are model-facing text, so they are capped: a failing
 * `xcodebuild` run can print hundreds of thousands of lines, and none of it
 * should displace the agent's working context. The complete output is kept on
 * disk by the caller and its path is reported instead.
 */

/** Default number of characters returned to the model for one text section. */
export const DEFAULT_TEXT_CHARS = 12000

/** Convert any thrown value into a stable one-line message. */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Remove ANSI SGR/CSI escape sequences from command output. */
export function stripAnsi(text) {
  return String(text ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

/** Keep the head of `text`, marking how much was removed. */
export function clip(text, maxChars = DEFAULT_TEXT_CHARS) {
  const value = typeof text === 'string' ? text : ''
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) return value
  const removed = value.length - maxChars
  return `${value.slice(0, maxChars)}\n… [${removed} characters omitted]`
}

/** Last `count` lines of a text block. */
export function tailLines(text, count = 120) {
  if (typeof text !== 'string' || count <= 0) return ''
  const lines = text.split(/\r?\n/)
  if (lines.length <= count) return text
  return `… [${lines.length - count} earlier lines omitted]\n${lines.slice(-count).join('\n')}`
}

/** Prefix every non-empty line. */
export function indent(text, prefix = '  ') {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text
    .split(/\r?\n/)
    .map((line) => (line.length === 0 ? line : prefix + line))
    .join('\n')
}

/** `1 test` / `2 tests`. */
export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/** Human duration such as `1.4s` or `2m 05s`. */
export function formatDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return 'unknown'
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`
}

/** Human byte size. */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return 'unknown'
  if (value < 1024) return `${value}B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KiB`
  return `${(value / (1024 * 1024)).toFixed(1)}MiB`
}

/** The one content-block shape our tools render. */
export function textBlock(text) {
  return { type: 'text', text: String(text ?? '') }
}

/** Rendered tool content: exactly one text block. */
export function renderText(text) {
  return [textBlock(text)]
}

/** Bulleted list, or a placeholder for an empty selection. */
export function bulletList(items, empty = 'none') {
  if (!Array.isArray(items) || items.length === 0) return `- ${empty}`
  return items.map((item) => `- ${item}`).join('\n')
}

/** Join sections, skipping empty ones, with `\n\n` between them. */
export function sections(...parts) {
  return parts.filter((part) => typeof part === 'string' && part.trim().length > 0).join('\n\n')
}

/**
 * Normalize a tool result to lossless JSON.
 *
 * The Harness rejects a tool value that JSON cannot represent losslessly
 * (`undefined` properties, `NaN`/`Infinity`, `-0`, sparse arrays, dates, class
 * instances, cycles). Our tools build results from parsed command output where
 * such values appear naturally — an `error` field that is present but
 * undefined, an unavailable device's missing lastBootedAt — so the registry
 * boundary normalizes once, centrally, instead of every tool remembering.
 *
 * @param {unknown} value candidate tool value.
 * @returns {unknown} a plain JSON value; `undefined` means the whole value was
 *   not representable and the caller should substitute `null`.
 */
export function toLosslessJson(value) {
  return normalizeJson(value, new Set())
}

function normalizeJson(value, ancestors) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : value
  }
  if (type === 'bigint') {
    const asNumber = Number(value)
    return Number.isSafeInteger(asNumber) ? asNumber : String(value)
  }
  if (type !== 'object') return undefined
  if (ancestors.has(value)) return null

  let candidate = value
  const toJSON = candidate.toJSON
  if (typeof toJSON === 'function') {
    try {
      candidate = toJSON.call(candidate)
    } catch {
      return null
    }
    if (candidate === null) return null
    if (typeof candidate !== 'object') return normalizeJson(candidate, ancestors)
    if (ancestors.has(candidate)) return null
  }

  ancestors.add(candidate)
  try {
    if (Array.isArray(candidate)) {
      const out = []
      for (let index = 0; index < candidate.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(candidate, index)) {
          out.push(null)
          continue
        }
        const item = normalizeJson(candidate[index], ancestors)
        out.push(item === undefined ? null : item)
      }
      return out
    }
    const out = {}
    for (const key of Object.keys(candidate)) {
      if (key === 'toJSON' && typeof candidate[key] === 'function') continue
      const item = normalizeJson(candidate[key], ancestors)
      if (item !== undefined) out[key] = item
    }
    return out
  } finally {
    ancestors.delete(candidate)
  }
}
