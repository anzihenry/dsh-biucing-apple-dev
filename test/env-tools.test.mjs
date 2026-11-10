/**
 * Definition-level tests for the Lead-owned tools: every tool is a valid plain
 * definition, renders text, honours the macOS guard and reports success from
 * the fake runner's toolchain output.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createEnvTools } from '../lib/tools-env.js'

const DEVICES_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [
      { udid: 'AAAAAAAA-0000-0000-0000-000000000001', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
    ],
  },
})

function fakeRunner() {
  return async (argv) => {
    const joined = argv.join(' ')
    const base = { argv, command: joined, exitCode: 0, stderr: '' }
    if (joined === 'xcodebuild -version') return { ...base, ok: true, stdout: 'Xcode 27.2\nBuild version 27B52\n' }
    if (joined === 'xcode-select -p') return { ...base, ok: true, stdout: '/Applications/Xcode-27.2.0.app/Contents/Developer\n' }
    if (joined === 'xcodebuild -showsdks') return { ...base, ok: true, stdout: 'iOS SDKs:\n\tiOS 27.2\t-sdk iphoneos27.2\n' }
    if (joined === 'xcrun simctl list runtimes --json') {
      return { ...base, ok: true, stdout: JSON.stringify({ runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2', name: 'iOS 27.2', version: '27.2', isAvailable: true }] }) }
    }
    if (joined === 'xcrun simctl list devices --json') return { ...base, ok: true, stdout: DEVICES_JSON }
    if (joined === 'swift --version') return { ...base, ok: true, stdout: 'Apple Swift version 6.2.1\n' }
    if (joined === 'security find-identity -v -p codesigning') return { ...base, ok: true, stdout: '     0 valid identities found\n' }
    if (joined === 'xcrun simctl boot AAAAAAAA-0000-0000-0000-000000000001') return { ...base, ok: true, stdout: '' }
    if (joined === 'xcrun simctl bootstatus AAAAAAAA-0000-0000-0000-000000000001 -b') return { ...base, ok: true, stdout: 'booted\n' }
    return { ...base, ok: false, exitCode: 1, stdout: '', stderr: `unexpected command: ${joined}` }
  }
}

function fakeContext() {
  return {
    get(name) {
      if (name === 'subprocess') return { resolveExecutable: async (command) => `/usr/bin/${command}` }
      if (name === 'workingDirectory') return { get: () => '/tmp/session', defaultDirectory: '/tmp/session' }
      return undefined
    },
  }
}

const config = {
  xcodebuild: 'xcodebuild',
  developerDir: '',
  derivedDataPath: '.apple-dev/DerivedData',
  logDirectory: '.apple-dev/logs',
  timeoutMs: 60000,
  maxOutputBytes: 1024 * 1024,
}

test('createEnvTools returns two valid plain tool definitions', () => {
  const tools = createEnvTools(fakeContext(), config, fakeRunner())
  assert.equal(tools.length, 2)
  const names = tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['apple_dev_env', 'apple_dev_simulator'])
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 40)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.ok(tool.parameters.required === undefined || Array.isArray(tool.parameters.required))
    assert.equal(tool.output.schema.type, 'object')
    const rendered = tool.output.render({}, { ok: false, error: 'x' })
    assert.equal(rendered[0].type, 'text')
    assert.equal(typeof rendered[0].text, 'string')
    assert.equal(typeof tool.execute, 'function')
  }
  const env = tools.find((tool) => tool.name === 'apple_dev_env')
  assert.ok(env.parameters.properties.include_devices)
  const simulator = tools.find((tool) => tool.name === 'apple_dev_simulator')
  assert.ok(simulator.parameters.properties.action.enum.includes('install'))
  assert.ok(simulator.parameters.properties.action.enum.includes('screenshot'))
})

test('apple_dev_env returns the toolchain report through the runner', { skip: process.platform !== 'darwin' }, async () => {
  const tools = createEnvTools(fakeContext(), config, fakeRunner())
  const env = tools.find((tool) => tool.name === 'apple_dev_env')
  const report = await env.execute({ include_devices: true }, { signal: new AbortController().signal })
  assert.equal(report.ok, true)
  assert.equal(report.xcodebuild.version, '27.2')
  assert.equal(report.sdks.length, 1)
  assert.equal(report.simulators.length, 1)
  const text = env.output.render({}, report)[0].text
  assert.match(text, /Xcode: 27\.2 \(27B52\)/)
  assert.match(text, /available device/)
})

test('apple_dev_simulator list and boot use the injected runner', { skip: process.platform !== 'darwin' }, async () => {
  const tools = createEnvTools(fakeContext(), config, fakeRunner())
  const simulator = tools.find((tool) => tool.name === 'apple_dev_simulator')
  const signal = new AbortController().signal
  const listed = await simulator.execute({ action: 'list' }, { signal })
  assert.equal(listed.ok, true)
  assert.equal(listed.devices.length, 1)
  const booted = await simulator.execute({ action: 'boot', device: 'iPhone 17' }, { signal })
  assert.equal(booted.ok, true)
  assert.match(booted.message, /booted/)
})

test('apple_dev_simulator reports an invalid action as a thrown input error', async () => {
  const tools = createEnvTools(fakeContext(), config, fakeRunner())
  const simulator = tools.find((tool) => tool.name === 'apple_dev_simulator')
  await assert.rejects(() => simulator.execute({ action: 'self-destruct' }, { signal: new AbortController().signal }), /action must be one of/)
})

test('apple_dev_simulator launch validates the bundle id as a result', { skip: process.platform !== 'darwin' }, async () => {
  const tools = createEnvTools(fakeContext(), config, fakeRunner())
  const simulator = tools.find((tool) => tool.name === 'apple_dev_simulator')
  const launched = await simulator.execute({ action: 'launch', device: 'iPhone 17' }, { signal: new AbortController().signal })
  assert.equal(launched.ok, false)
  assert.match(launched.error, /bundle id/)
})
