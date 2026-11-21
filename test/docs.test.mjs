/**
 * Documentation drift guard: the capability table in README.md must list
 * exactly the tools `apply()` registers, and the configuration table must
 * keep documenting every MCP key.
 *
 * Comments and prose are not checked — only the two machine-readable tables
 * that a contributor or an agent relies on before touching the plugin.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { apply } from '../index.js'

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')

/** Tool names from the `| \`apple_dev_x\` | ... |` capability table. */
function documentedTools() {
  const names = []
  for (const line of readme.split('\n')) {
    const match = /^\|\s*`(apple_dev_[a-z0-9_]+)`\s*\|/.exec(line)
    if (match) names.push(match[1])
  }
  return names
}

/** Tool names the plugin actually registers for a default config. */
function registeredTools() {
  const names = []
  const ctx = {
    tools: {
      register(definition) {
        names.push(definition.name)
        return () => {}
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
    inject() {
      return () => {}
    },
    get() {
      return undefined
    },
    logger: { warn() {}, info() {}, debug() {} },
  }
  apply(ctx, {})
  return names
}

test('README capability table lists exactly the registered tools', () => {
  const documented = documentedTools()
  const registered = registeredTools().sort()
  assert.deepEqual(documented.slice().sort(), registered)
  assert.equal(new Set(documented).size, documented.length, 'no duplicate table rows')
})

test('README documents every MCP configuration key', () => {
  for (const key of [
    'mcpEnabled',
    'mcpCommand',
    'mcpArgs',
    'mcpStartupTimeoutMs',
    'mcpToolCallTimeoutMs',
    'mcpAllowMutations',
  ]) {
    assert.ok(readme.includes('`' + key + '`'), `README must document ${key}`)
  }
})
