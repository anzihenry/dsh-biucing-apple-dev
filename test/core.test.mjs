/**
 * Unit tests for the Lead-owned modules: parsers, device resolution, report
 * rendering and path/config helpers. Fixtures are trimmed real outputs from
 * Xcode 27.2 / CoreSimulator on macOS.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseIdentities, parseRuntimes, parseSdks, parseSimulatorList, parseXcodeVersion, platformForRuntime, platformForSdk, versionForRuntime } from '../lib/env.js'
import { resolveDevice } from '../lib/simulator.js'
import { parseTestOutput } from '../lib/test.js'
import { formatDeviceLine, formatEnvReport, formatSimulatorReport, formatSimulatorSummary } from '../lib/tools-env.js'
import { resolveConfig, resolveUserPath, platformProblem, resolveExecutable } from '../lib/runner.js'
import { clip, formatBytes, formatDuration, plural, tailLines, toLosslessJson } from '../lib/format.js'

const SDKS = `DriverKit SDKs:
\tDriverKit 27.2                \t-sdk driverkit27.2

iOS SDKs:
\tiOS 27.2                      \t-sdk iphoneos27.2

iOS Simulator SDKs:
\tSimulator - iOS 27.2          \t-sdk iphonesimulator27.2

macOS SDKs:
\tmacOS 27.2                    \t-sdk macosx27.2
\tmacOS 27.2                    \t-sdk macosx27.2

tvOS SDKs:
\ttvOS 27.2                     \t-sdk appletvos27.2
`

const DEVICES_JSON = `{
  "devices" : {
    "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4" : [
      {
        "udid" : "DEA4861A-1295-4F1C-8609-3CA884591052",
        "isAvailable" : true,
        "state" : "Shutdown",
        "name" : "iPhone Duo",
        "deviceTypeIdentifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo"
      },
      {
        "udid" : "6AFAB133-AD42-4E24-BC06-AB5BF2CC1F22",
        "isAvailable" : true,
        "state" : "Booted",
        "name" : "iPhone 17",
        "deviceTypeIdentifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17"
      }
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-4" : [
      {
        "udid" : "61985CB1-932F-4570-BBE0-C27180CF7378",
        "isAvailable" : false,
        "availabilityError" : "runtime profile not found using “System” match policy",
        "state" : "Shutdown",
        "name" : "iPhone 17 Pro",
        "deviceTypeIdentifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
      }
    ],
    "com.apple.CoreSimulator.SimRuntime.tvOS-27-2" : [
      { "udid" : "8B6F132D-0187-426A-B369-A26A9DF3AA97", "isAvailable" : true, "state" : "Shutdown", "name" : "Apple TV 4K (4th generation)" }
    ]
  }
}`

const RUNTIMES_JSON = `{
  "runtimes" : [
    {
      "isAvailable" : true,
      "version" : "27.2",
      "buildversion" : "24B91016s",
      "identifier" : "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4",
      "platform" : "iOS",
      "name" : "iOS 27.2",
      "supportedDeviceTypes" : [ { "name" : "iPhone Duo", "identifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo" } ]
    }
  ]
}`

test('parseXcodeVersion reads version and build', () => {
  assert.deepEqual(parseXcodeVersion('Xcode 27.2\nBuild version 27B52\n'), { version: '27.2', build: '27B52' })
  assert.deepEqual(parseXcodeVersion(''), { version: undefined, build: undefined })
})

test('parseSdks parses each SDK line once with its platform', () => {
  const sdks = parseSdks(SDKS)
  assert.deepEqual(sdks.map((sdk) => sdk.sdk), [
    'driverkit27.2',
    'iphoneos27.2',
    'iphonesimulator27.2',
    'macosx27.2',
    'appletvos27.2',
  ])
  assert.equal(sdks.find((sdk) => sdk.sdk === 'iphonesimulator27.2').platform, 'iOS Simulator')
  assert.equal(sdks.find((sdk) => sdk.sdk === 'macosx27.2').name, 'macOS')
  assert.equal(sdks.filter((sdk) => sdk.sdk === 'macosx27.2').length, 1)
})

test('platformForSdk and platformForRuntime cover every supported family', () => {
  assert.equal(platformForSdk('xros27.0'), 'visionOS')
  assert.equal(platformForSdk('xrsimulator27.0'), 'visionOS Simulator')
  assert.equal(platformForSdk('watchos27.0'), 'watchOS')
  assert.equal(platformForRuntime('com.apple.CoreSimulator.SimRuntime.watchOS-27-2'), 'watchOS')
  assert.equal(platformForRuntime('nonsense'), 'unknown')
})

test('versionForRuntime ignores the device-type suffix', () => {
  assert.equal(versionForRuntime('com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4'), '27.2')
  assert.equal(versionForRuntime('com.apple.CoreSimulator.SimRuntime.macOS-26-0'), '26.0')
  assert.equal(versionForRuntime('unknown'), undefined)
})

test('parseSimulatorList flattens runtimes, keeps availability and sorts', () => {
  const devices = parseSimulatorList(DEVICES_JSON)
  assert.equal(devices.length, 4)
  const iphone = devices.find((device) => device.name === 'iPhone 17')
  assert.equal(iphone.state, 'Booted')
  assert.equal(iphone.platform, 'iOS')
  assert.equal(iphone.osVersion, '27.2')
  assert.equal(iphone.isAvailable, true)
  assert.equal(devices.find((device) => device.name === 'iPhone 17 Pro').isAvailable, false)
  assert.equal(devices[0].platform <= devices[devices.length - 1].platform, true)
  assert.deepEqual(parseSimulatorList('not json'), [])
  assert.deepEqual(parseSimulatorList(''), [])
})

test('parseRuntimes reads identifiers, versions and platforms', () => {
  const runtimes = parseRuntimes(RUNTIMES_JSON)
  assert.equal(runtimes.length, 1)
  assert.equal(runtimes[0].identifier, 'com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4')
  assert.equal(runtimes[0].version, '27.2')
  assert.equal(runtimes[0].platform, 'iOS')
  assert.deepEqual(runtimes[0].supportedDeviceTypes, ['iPhone Duo'])
})

test('parseIdentities handles the empty and populated forms', () => {
  assert.deepEqual(parseIdentities('     0 valid identities found\n'), { identities: [], count: 0 })
  const populated = parseIdentities(`  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Jane Doe (ABCDE12345)"\n  2) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Apple Distribution: Acme (ABCDE12345)"\n     2 valid identities found\n`)
  assert.equal(populated.count, 2)
  assert.deepEqual(populated.identities[0], { hash: '0123456789ABCDEF0123456789ABCDEF01234567', name: 'Apple Development: Jane Doe (ABCDE12345)' })
})

const devices = parseSimulatorList(DEVICES_JSON)

test('resolveDevice accepts UDID, exact and case-insensitive names', () => {
  assert.equal(resolveDevice(devices, 'DEA4861A-1295-4F1C-8609-3CA884591052').device.name, 'iPhone Duo')
  assert.equal(resolveDevice(devices, 'iPhone 17').device.name, 'iPhone 17')
  assert.equal(resolveDevice(devices, 'iphone duo').device.name, 'iPhone Duo')
  assert.equal(resolveDevice(devices, 'booted').device.name, 'iPhone 17')
  assert.equal(resolveDevice(devices, '').device.name, 'iPhone 17')
})

test('resolveDevice explains failures and skips unavailable candidates', () => {
  const missing = resolveDevice(devices, 'iPhone 99')
  assert.match(missing.error, /No simulator matches/)
  assert.equal(missing.candidates.some((device) => device.isAvailable === false), false)
  const shutdownOnly = devices.map((device) => ({ ...device, state: 'Shutdown' }))
  assert.match(resolveDevice(shutdownOnly, '').error, /No simulator is booted/)
  assert.match(resolveDevice([], 'x').error, /No simulator devices exist/)
})

test('resolveDevice prefers a booted device when names collide', () => {
  const collided = [
    { udid: 'A', name: 'iPhone 17', state: 'Shutdown', platform: 'iOS', osVersion: '26.4', isAvailable: true },
    { udid: 'B', name: 'iPhone 17', state: 'Booted', platform: 'iOS', osVersion: '27.2', isAvailable: true },
  ]
  assert.equal(resolveDevice(collided, 'iPhone 17').device.udid, 'B')
})

test('device and report rendering stay informative', () => {
  assert.match(formatDeviceLine(devices[0]), /— (Booted|Shutdown)/)
  const summary = formatSimulatorSummary(devices)
  assert.match(summary, /3 available devices of 4 total/)
  assert.match(summary, /unavailable device\(s\) omitted/)
  assert.match(summary, /iOS/)
  assert.match(formatSimulatorSummary([]), /No simulator devices/)
  const report = formatEnvReport({
    ok: true,
    platform: 'darwin',
    xcodebuild: { version: '27.2', build: '27B52', path: '/usr/bin/xcodebuild' },
    developerDir: '/Applications/Xcode-27.2.0.app/Contents/Developer',
    sdks: parseSdks(SDKS),
    runtimes: parseRuntimes(RUNTIMES_JSON),
    swift: 'Apple Swift version 6.2.1',
    signing: { count: 0, identities: [] },
    warnings: [],
    simulators: devices,
  })
  assert.match(report, /Xcode: 27.2 \(27B52\)/)
  assert.match(report, /Code-signing identities: 0 identities/)
  const withoutDevices = formatEnvReport({ ok: true, platform: 'darwin', xcodebuild: { version: '27.2' }, signing: { count: 0, identities: [] }, warnings: [] })
  assert.doesNotMatch(withoutDevices, /No simulator devices/)
  assert.match(formatEnvReport({ error: 'boom' }), /Apple toolchain problem: boom/)
  assert.match(formatSimulatorReport({ action: 'list', devices }), /available devices/)
  assert.match(formatSimulatorReport({ action: 'boot', ok: false, error: 'nope', device: devices[1] }), /Error: nope/)
})

test('resolveConfig applies defaults and bounds', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.xcodebuild, 'xcodebuild')
  assert.equal(defaults.derivedDataPath, '.apple-dev/DerivedData')
  assert.equal(defaults.timeoutMs, 900000)
  assert.equal(resolveConfig({ timeoutMs: 5 }).timeoutMs, 1000)
  assert.equal(resolveConfig({ timeoutMs: 10 ** 12 }).timeoutMs, 60 * 60 * 1000)
  assert.equal(resolveConfig({ maxOutputBytes: 1 }).maxOutputBytes, 64 * 1024)
  assert.equal(resolveConfig({ derivedDataPath: '  ' }).derivedDataPath, '.apple-dev/DerivedData')
})

test('resolveUserPath resolves relative, absolute and home paths', () => {
  assert.equal(resolveUserPath('/tmp/session', ''), '/tmp/session')
  assert.equal(resolveUserPath('/tmp/session', 'App.xcodeproj'), '/tmp/session/App.xcodeproj')
  assert.equal(resolveUserPath('/tmp/session', '/abs/App.xcodeproj'), '/abs/App.xcodeproj')
  assert.equal(resolveUserPath('/tmp/session', '~/App.app'), `${process.env.HOME}/App.app`)
})

test('format helpers bound and describe text', () => {
  assert.equal(clip('short', 100), 'short')
  assert.match(clip('x'.repeat(50), 10), /40 characters omitted/)
  assert.match(tailLines('a\nb\nc', 2), /earlier lines omitted/)
  assert.equal(plural(1, 'test'), '1 test')
  assert.equal(plural(2, 'test'), '2 tests')
  assert.match(formatDuration(420), /ms$/)
  assert.match(formatDuration(1500), /^1\.5s$/)
  assert.equal(formatBytes(2048), '2.0KiB')
})

test('platformProblem is undefined on macOS', () => {
  if (process.platform === 'darwin') assert.equal(platformProblem(), undefined)
  else assert.match(platformProblem(), /require macOS/)
})

test('resolveExecutable finds xcodebuild on this Mac', { skip: process.platform !== 'darwin' }, async () => {
  const ctx = { get: () => ({ resolveExecutable: async (command) => `/usr/bin/${command}` }) }
  assert.equal(await resolveExecutable(ctx, 'xcodebuild'), '/usr/bin/xcodebuild')
})

test('toLosslessJson strips and repairs values JSON cannot hold losslessly', () => {
  const cyclic = { name: 'loop' }
  cyclic.self = cyclic
  const normalized = toLosslessJson({
    ok: true,
    absent: undefined,
    device: { udid: 'A', lastBootedAt: undefined, osVersion: undefined },
    values: [1, undefined, Number.NaN, Number.POSITIVE_INFINITY, -0, 'x'],
    when: new Date('2026-11-11T00:00:00.000Z'),
    nested: { deeper: { missing: undefined, keep: false } },
    cycle: cyclic,
    fn: () => 1,
  })
  assert.deepEqual(normalized, {
    ok: true,
    device: { udid: 'A' },
    values: [1, null, null, null, 0, 'x'],
    when: '2026-11-11T00:00:00.000Z',
    nested: { deeper: { keep: false } },
    cycle: { name: 'loop', self: null },
  })
  assert.equal(toLosslessJson(undefined), undefined)
  assert.equal(toLosslessJson('plain'), 'plain')
  assert.deepEqual(toLosslessJson({ list: [] }), { list: [] })
})

test('no tool result may contain undefined after normalization', () => {
  const probe = toLosslessJson({ action: 'list', ok: true, error: undefined, devices: [{ name: 'x', state: undefined }] })
  assert.equal(JSON.stringify(probe), '{"action":"list","ok":true,"devices":[{"name":"x"}]}')
})

test('parseTestOutput prefers Swift Testing counts over an empty XCTest suite', () => {
  const output = [
    "Test Suite 'All tests' started at 2026-11-11 01:09:35.096.",
    "Test Suite 'All tests' passed at 2026-11-11 01:09:35.098.",
    "\t Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.001) seconds",
    '◇ Test run started.',
    '◇ Test example() started.',
    '✔ Test example() passed after 0.001 seconds.',
    '✔ Test run with 1 test in 0 suites passed after 0.001 seconds.',
  ].join('\n')
  const parsed = parseTestOutput(output)
  assert.equal(parsed.executed, 1)
  assert.equal(parsed.failureCount, 0)
  assert.equal(parsed.result, 'passed')
  assert.equal(parsed.passed, true)
  assert.ok(parsed.caseCounts.passed >= 1)
})

test('parseTestOutput still reports a Swift Testing failure as failed', () => {
  const output = [
    "Test Suite 'All tests' passed at 2026-11-11 01:00:00.000.",
    '\t Executed 0 tests, with 0 failures (0 unexpected) in 0.000 seconds',
    '✘ Test broken() recorded an issue at Example.swift:3:5',
    '✘ Test run with 1 test in 0 suites failed after 0.002 seconds.',
  ].join('\n')
  const parsed = parseTestOutput(output)
  assert.equal(parsed.result, 'failed')
  assert.equal(parsed.passed, false)
  assert.equal(parsed.executed, 1)
  assert.ok(parsed.failingTestCount >= 1)
})
