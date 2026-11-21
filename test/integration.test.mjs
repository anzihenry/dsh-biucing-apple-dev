/**
 * Integration test for the Host entry point: `apply()` must register the whole
 * capability surface through `ctx.tools.register`, with unique names and a
 * model-facing schema that the framework can project.
 *
 * The fake context implements only the members `index.js` uses; a real Host
 * provides the rest of the Cordis context.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, losslessTool } from '../index.js'

const EXPECTED = [
  'apple_dev_build',
  'apple_dev_device',
  'apple_dev_env',
  'apple_dev_logs',
  'apple_dev_project',
  'apple_dev_release',
  'apple_dev_signing',
  'apple_dev_simulator',
  'apple_dev_test',
  'apple_dev_visual',
  'apple_dev_xcode_call',
  'apple_dev_xcode_status',
  'apple_dev_xcode_tools',
]

function fakeContext() {
  const tools = []
  const effects = []
  return {
    tools: { register: (definition) => {
      tools.push(definition)
      return () => {}
    } },
    effect(fn) {
      effects.push(fn)
      return fn()
    },
    inject(_services, callback) {
      // Pretend the profile has no webServer: the tool surface must still exist.
      void callback
      return () => {}
    },
    get() {
      return undefined
    },
    logger: { warn() {}, info() {}, debug() {} },
    toolsRegistered: tools,
    effects,
  }
}

const config = {
  xcodebuild: 'xcodebuild',
  developerDir: '',
  derivedDataPath: '.apple-dev/DerivedData',
  logDirectory: '.apple-dev/logs',
  timeoutMs: 600000,
  maxOutputBytes: 1024 * 1024,
}

test('index exports the Host plugin contract', () => {
  assert.equal(typeof apply, 'function')
  assert.deepEqual(inject, ['tools', 'subprocess'])
})

test('apply registers all thirteen Apple Dev tools exactly once', () => {
  const ctx = fakeContext()
  apply(ctx, config)
  const names = ctx.toolsRegistered.map((tool) => tool.name).sort()
  assert.deepEqual(names, EXPECTED)
})

test('every registered tool has a projectable schema and a text renderer', () => {
  const ctx = fakeContext()
  apply(ctx, config)
  for (const tool of ctx.toolsRegistered) {
    assert.equal(typeof tool.description, 'string', `${tool.name} description`)
    assert.ok(tool.description.length >= 30, `${tool.name} description is informative`)
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameter root`)
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} rejects unknown parameters`)
    assert.ok(tool.parameters.properties && Object.keys(tool.parameters.properties).length > 0, `${tool.name} documents parameters`)
    assert.equal(tool.output.schema.type, 'object', `${tool.name} output schema`)
    const blocks = tool.output.render({}, { ok: false, error: 'probe' })
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${tool.name} renders text`)
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
    assert.equal(typeof tool.execute, 'function')
  }
})

test('the four action-style tools declare an action enum', () => {
  const ctx = fakeContext()
  apply(ctx, config)
  const byName = new Map(ctx.toolsRegistered.map((tool) => [tool.name, tool]))
  for (const name of ['apple_dev_project', 'apple_dev_simulator', 'apple_dev_signing', 'apple_dev_logs']) {
    const tool = byName.get(name)
    const action = tool.parameters.properties.action
    assert.ok(action, `${name} declares action`)
    assert.ok(Array.isArray(action.enum) && action.enum.length >= 2, `${name} action is an enum`)
    assert.ok(tool.parameters.required.includes('action'), `${name} requires action`)
  }
  assert.ok(byName.get('apple_dev_build').parameters.properties.scheme, 'build takes a scheme')
  assert.ok(byName.get('apple_dev_build').parameters.properties.destination, 'build takes a destination')
  assert.ok(byName.get('apple_dev_test').parameters.properties.only_testing, 'test takes only_testing')
  assert.ok(byName.get('apple_dev_simulator').parameters.properties.bundle_id, 'simulator can launch by bundle id')
})

test('apply is idempotent-safe: a second call registers a second complete set', () => {
  const ctx = fakeContext()
  apply(ctx, config)
  apply(ctx, config)
  assert.equal(ctx.toolsRegistered.length, EXPECTED.length * 2)
  const names = ctx.toolsRegistered.map((tool) => tool.name)
  for (const name of EXPECTED) assert.equal(names.filter((entry) => entry === name).length, 2)
})

test('losslessTool normalizes a tool result without changing its schema', async () => {
  const raw = {
    name: 'apple_dev_probe',
    description: 'Probe tool used by the integration test only; never registered.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    async execute() {
      return { ok: true, error: undefined, when: new Date('2026-11-11T00:00:00.000Z'), list: [1, undefined, Number.NaN] }
    },
  }
  const wrapped = losslessTool(raw)
  assert.equal(wrapped.output, raw.output)
  assert.equal(wrapped.parameters, raw.parameters)
  const value = await wrapped.execute({}, { signal: new AbortController().signal })
  assert.deepEqual(value, { ok: true, when: '2026-11-11T00:00:00.000Z', list: [1, null, null] })
})

test('every registered tool result survives the lossless-JSON boundary', () => {
  const ctx = fakeContext()
  apply(ctx, config)
  for (const tool of ctx.toolsRegistered) {
    assert.equal(Object.hasOwn(tool, 'execute'), true)
    const value = tool.output.render({}, { ok: false, message: 'x', extra: undefined })
    assert.equal(value[0].type, 'text')
  }
})
