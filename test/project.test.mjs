/**
 * Unit tests for the project/build/test modules, plus one real smoke test that
 * creates a throwaway Swift package and drives the actual tools through a local
 * `node:child_process` runner (the plugin code itself never imports it).
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  chooseProject,
  discoverProjects,
  extractJson,
  filterBuildSettings,
  needsSwiftDescribeTypeJson,
  parseSwiftDescribe,
  parseXcodebuildList,
  parseXcodebuildListText,
  projectKindForPath,
  withSwiftDescribeTypeJson,
} from '../lib/project.js'
import {
  buildDestination,
  needsSwiftSandboxFallback,
  normalizePlatform,
  parseBuildOutput,
  pickDefaultSimulator,
  simulatorDestination,
  simulatorPlatformLabel,
  swiftSandboxFallbackArgv,
} from '../lib/build.js'
import { parseTestOutput } from '../lib/test.js'
import { createProjectTools } from '../lib/tools-project.js'

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const BUILD_SUCCEEDED_TEXT = [
  'Command line invocation:',
  '    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -project MyApp.xcodeproj -scheme MyApp build',
  '',
  'note: Using the new build system',
  'CompileSwift normal arm64 /Users/dev/MyApp/Login.swift',
  '/Users/dev/MyApp/Login.swift:12:5: warning: variable "token" was never used',
  'Ld /Users/dev/Library/Developer/Xcode/DerivedData/MyApp/App.app/MyApp normal',
  '** BUILD SUCCEEDED **',
].join('\n')

const BUILD_FAILED_TEXT = [
  'CompileSwift normal arm64 /Users/dev/MyApp/Login.swift',
  '/Users/dev/MyApp/Login.swift:42:18: error: cannot find \'validate\' in scope',
  '/Users/dev/MyApp/Login.swift:43: error: use of unresolved identifier \'token\'',
  '/Users/dev/MyApp/Login.swift:50:9: warning: unused variable \'count\'',
  'error: Linker command failed with exit code 1 (use -v to see invocation)',
  '** BUILD FAILED **',
  '',
  'The following build commands failed:',
  '\tCompileSwift normal arm64 /Users/dev/MyApp/Login.swift',
  '\tLd /Users/dev/Library/Developer/Xcode/DerivedData/MyApp/App.app/MyApp normal',
  '(1 failure)',
].join('\n')

const SWIFT_BUILD_SUCCEEDED_TEXT = ['Building for debugging...', '[3/4] Compiling SmokeKit SmokeKit.swift', 'Build complete! (2.28s)'].join('\n')

const XCODEBUILD_LIST_JSON = [
  'note: Using the new build system',
  '{',
  '  "project" : {',
  '    "configurations" : [ "Debug", "Release" ],',
  '    "name" : "MyApp",',
  '    "schemes" : [ "MyApp" ],',
  '    "targets" : [ "MyApp", "MyAppTests" ]',
  '  }',
  '}',
  'note: trailing output',
].join('\n')

const XCODEBUILD_WORKSPACE_JSON = JSON.stringify({
  workspace: { name: 'MyApp', schemes: ['MyApp'] },
  project: { name: 'MyApp', targets: ['MyApp'], configurations: ['Debug', 'Release'], schemes: ['MyApp'] },
})

const XCODEBUILD_LIST_TEXT = [
  'Information about project "MyApp":',
  '    Targets:',
  '        MyApp',
  '        MyAppTests',
  '',
  '    Build Configurations:',
  '        Debug',
  '        Release',
  '',
  '    Schemes:',
  '        MyApp',
].join('\n')

const SWIFT_DESCRIBE_JSON = JSON.stringify({
  dependencies: [],
  manifest_display_name: 'SmokeKit',
  name: 'SmokeKit',
  path: '/private/tmp/SmokeKit',
  platforms: [{ name: 'macOS', version: '13.0' }],
  products: [{ name: 'SmokeKit', targets: ['SmokeKit'], type: { library: ['automatic'] } }],
  targets: [
    {
      c99name: 'SmokeKitTests',
      module_type: 'SwiftTarget',
      name: 'SmokeKitTests',
      path: 'Tests/SmokeKitTests',
      sources: ['SmokeKitTests.swift'],
      target_dependencies: ['SmokeKit'],
      type: 'test',
    },
    {
      c99name: 'SmokeKit',
      module_type: 'SwiftTarget',
      name: 'SmokeKit',
      path: 'Sources/SmokeKit',
      sources: ['SmokeKit.swift'],
      target_dependencies: [],
      type: 'regular',
    },
  ],
})

const TEST_PASSED_TEXT = [
  "Test Suite 'All tests' started at 2026-11-11 00:42:59.554.",
  "Test Suite 'SmokeKitTests.xctest' started at 2026-11-11 00:42:59.556.",
  "Test Case '-[SmokeKitTests.SmokeKitTests testExample]' started.",
  "Test Case '-[SmokeKitTests.SmokeKitTests testExample]' passed (0.001 seconds).",
  "Test Suite 'SmokeKitTests' passed at 2026-11-11 00:43:00.000.",
  '\t Executed 1 test, with 0 failures (0 unexpected) in 0.001 (0.002) seconds',
  "Test Suite 'All tests' passed at 2026-11-11 00:43:00.001.",
  '\t Executed 1 test, with 0 failures (0 unexpected) in 0.001 (0.002) seconds',
  '** TEST SUCCEEDED **',
].join('\n')

const TEST_FAILED_TEXT = [
  "Test Suite 'All tests' started at 2026-11-11 00:42:59.554.",
  "Test Case '-[MyAppTests.LoginTests testSuccess]' passed (0.021 seconds).",
  "Test Case '-[MyAppTests.LoginTests testFailure]' started.",
  "/private/tmp/MyApp/Tests/LoginTests.swift:42: error: -[MyAppTests.LoginTests testFailure] : XCTAssertEqual failed: (\"1\") is not equal to (\"2\") - one is not two",
  "Test Case '-[MyAppTests.LoginTests testFailure]' failed (0.032 seconds).",
  "Test Suite 'All tests' failed at 2026-11-11 00:43:00.001.",
  '\t Executed 2 tests, with 1 failure (0 unexpected) in 0.053 (0.054) seconds',
  'Failing tests:',
  '\tMyAppTests.LoginTests.testFailure()',
  '** TEST FAILED **',
].join('\n')

const DEVICES = [
  {
    udid: '11111111-1111-1111-1111-111111111111',
    name: 'iPhone 16',
    platform: 'iOS',
    osVersion: '27.2',
    state: 'Shutdown',
    isAvailable: true,
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2',
  },
  {
    udid: '22222222-2222-2222-2222-222222222222',
    name: 'iPhone 16 Pro',
    platform: 'iOS',
    osVersion: '27.2',
    state: 'Booted',
    isAvailable: true,
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2',
  },
  {
    udid: '33333333-3333-3333-3333-333333333333',
    name: 'Apple TV',
    platform: 'tvOS',
    osVersion: '27.2',
    state: 'Shutdown',
    isAvailable: true,
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.tvOS-27-2',
  },
]

/* ------------------------------------------------------------------------- *
 * lib/project.js — JSON extraction and parsers
 * ------------------------------------------------------------------------- */

test('extractJson finds a JSON payload after leading noise and ignores trailing text', () => {
  const parsed = extractJson('warning: something\n{"a":[1,2,{"b":"]"}]}\nmore text')
  assert.deepEqual(parsed, { a: [1, 2, { b: ']' }] })
  assert.equal(extractJson('no json here'), undefined)
  assert.equal(extractJson('{ broken'), undefined)
})

test('parseXcodebuildList reads the project JSON shape', () => {
  const info = parseXcodebuildList(XCODEBUILD_LIST_JSON)
  assert.ok(info)
  assert.equal(info.kind, 'project')
  assert.equal(info.name, 'MyApp')
  assert.deepEqual(info.schemes, ['MyApp'])
  assert.deepEqual(info.targets, ['MyApp', 'MyAppTests'])
  assert.deepEqual(info.configurations, ['Debug', 'Release'])
})

test('parseXcodebuildList merges the workspace JSON shape', () => {
  const info = parseXcodebuildList(XCODEBUILD_WORKSPACE_JSON)
  assert.ok(info)
  assert.equal(info.kind, 'workspace')
  assert.deepEqual(info.schemes, ['MyApp'])
  assert.deepEqual(info.targets, ['MyApp'])
  assert.deepEqual(info.configurations, ['Debug', 'Release'])
  assert.equal(info.projects.length, 2)
})

test('parseXcodebuildList returns undefined for non-JSON output', () => {
  assert.equal(parseXcodebuildList('Information about project "MyApp":'), undefined)
})

test('parseXcodebuildListText parses the human-readable list output', () => {
  const info = parseXcodebuildListText(XCODEBUILD_LIST_TEXT)
  assert.ok(info)
  assert.equal(info.kind, 'project')
  assert.equal(info.name, 'MyApp')
  assert.deepEqual(info.targets, ['MyApp', 'MyAppTests'])
  assert.deepEqual(info.configurations, ['Debug', 'Release'])
  assert.deepEqual(info.schemes, ['MyApp'])
})

test('parseSwiftDescribe normalizes targets, products and platforms', () => {
  const info = parseSwiftDescribe(SWIFT_DESCRIBE_JSON)
  assert.ok(info)
  assert.equal(info.name, 'SmokeKit')
  assert.equal(info.targets.length, 2)
  assert.deepEqual(info.targets[0].dependencies, ['SmokeKit'])
  assert.equal(info.targets[0].type, 'test')
  assert.equal(info.products[0].type, 'library')
  assert.deepEqual(info.products[0].targets, ['SmokeKit'])
  assert.deepEqual(info.platforms, [{ name: 'macOS', version: '13.0' }])
  assert.deepEqual(info.dependencies, [])
})

test('parseSwiftDescribe returns undefined for unparseable text', () => {
  assert.equal(parseSwiftDescribe('error: Invalid manifest'), undefined)
})

test('filterBuildSettings keeps only the useful keys per target', () => {
  const payload = [
    {
      action: 'build',
      target: 'MyApp',
      buildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: 'com.example.MyApp',
        FULL_PRODUCT_NAME: 'MyApp.app',
        BUILT_PRODUCTS_DIR: '/tmp/DerivedData/Build/Products/Debug-iphonesimulator',
        SDKROOT: 'iphonesimulator27.2',
        IPHONEOS_DEPLOYMENT_TARGET: '18.0',
        DEVELOPMENT_TEAM: 'ABCDE12345',
        CODE_SIGN_IDENTITY: '-',
        NOISE_SETTING: 'ignored',
        OBJECT_SETTING: { nested: true },
      },
    },
    {
      action: 'build',
      target: 'MyAppTests',
      buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: 'com.example.MyAppTests', NOISE: 'ignored' },
    },
  ]
  const filtered = filterBuildSettings(payload)
  assert.equal(filtered.count, 2)
  assert.equal(filtered.settings.PRODUCT_BUNDLE_IDENTIFIER, 'com.example.MyApp')
  assert.equal(filtered.settings.SDKROOT, 'iphonesimulator27.2')
  assert.equal(filtered.settings.NOISE_SETTING, undefined)
  assert.equal(filtered.settings.OBJECT_SETTING, undefined)
  assert.equal(filtered.targets[1].target, 'MyAppTests')
  assert.deepEqual(filtered.targets[1].settings, { PRODUCT_BUNDLE_IDENTIFIER: 'com.example.MyAppTests' })
})

test('projectKindForPath classifies projects, workspaces and package manifests', () => {
  assert.deepEqual(projectKindForPath('/tmp/MyApp/MyApp.xcodeproj'), {
    kind: 'project',
    name: 'MyApp',
    path: '/tmp/MyApp/MyApp.xcodeproj',
  })
  assert.equal(projectKindForPath('/tmp/MyApp/MyApp.xcworkspace').kind, 'workspace')
  const manifest = projectKindForPath('/tmp/SmokeKit/Package.swift')
  assert.equal(manifest.kind, 'package')
  assert.equal(manifest.path, '/tmp/SmokeKit')
  assert.equal(manifest.manifestPath, '/tmp/SmokeKit/Package.swift')
  assert.equal(projectKindForPath('/tmp/README.md'), undefined)
})

test('chooseProject prefers workspace over project over package', () => {
  const entries = [
    { kind: 'package', name: 'Lib', path: '/work/Lib' },
    { kind: 'project', name: 'App', path: '/work/App.xcodeproj' },
    { kind: 'workspace', name: 'Work', path: '/work/Work.xcworkspace' },
  ]
  const choice = chooseProject(entries)
  assert.equal(choice.entry.kind, 'workspace')
  assert.equal(choice.alternatives.length, 2)
  assert.equal(chooseProject(entries, { kind: 'package' }).entry.name, 'Lib')
  assert.match(chooseProject([], {}).error, /No Xcode project/)
  assert.match(chooseProject(entries, { kind: 'bogus' }).error, /Unknown kind/)
  const duplicated = [...entries, { kind: 'project', name: 'Other', path: '/work/Other.xcodeproj' }]
  assert.match(chooseProject(duplicated, { kind: 'project' }).note, /among 2 candidates/)
})

test('discoverProjects walks directories, ignores build output, respects depth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-discovery-'))
  try {
    await mkdir(join(root, 'App.xcodeproj'), { recursive: true })
    await writeFile(join(root, 'App.xcodeproj', 'project.pbxproj'), '// stub\n')
    await mkdir(join(root, 'App.xcworkspace'), { recursive: true })
    await mkdir(join(root, 'Packages', 'Lib'), { recursive: true })
    await writeFile(join(root, 'Packages', 'Lib', 'Package.swift'), '// swift-tools-version: 6.0\n')
    await mkdir(join(root, 'build', 'Nested.xcodeproj'), { recursive: true })
    await mkdir(join(root, 'Pods', 'Nested.xcodeproj'), { recursive: true })
    await mkdir(join(root, 'DerivedData', 'Nested.xcodeproj'), { recursive: true })
    await mkdir(join(root, 'deep', 'a', 'b', 'c'), { recursive: true })
    await writeFile(join(root, 'deep', 'a', 'b', 'c', 'Package.swift'), '// deep\n')

    const discovery = await discoverProjects(root)
    assert.equal(discovery.root, root)
    assert.equal(discovery.truncated, false)
    const kinds = discovery.entries.map((entry) => `${entry.kind}:${entry.name}`)
    assert.deepEqual(kinds, ['workspace:App', 'project:App', 'package:Lib'])
    assert.equal(
      discovery.entries.some((entry) => entry.path.includes('/build/') || entry.path.includes('/Pods/')),
      false,
    )

    const shallow = await discoverProjects(root, { maxDepth: 2 })
    assert.equal(
      shallow.entries.some((entry) => entry.name === 'Lib'),
      true,
      'maxDepth 2 should reach Packages/Lib',
    )
    const veryShallow = await discoverProjects(root, { maxDepth: 1 })
    assert.equal(veryShallow.entries.some((entry) => entry.name === 'Lib'), false)

    const single = await discoverProjects(join(root, 'App.xcodeproj'))
    assert.equal(single.entries.length, 1)
    assert.equal(single.entries[0].kind, 'project')

    const manifest = await discoverProjects(join(root, 'Packages', 'Lib', 'Package.swift'))
    assert.equal(manifest.entries.length, 1)
    assert.equal(manifest.entries[0].kind, 'package')
    assert.equal(manifest.entries[0].path, join(root, 'Packages', 'Lib'))

    await assert.rejects(discoverProjects(join(root, 'does-not-exist')), /Path does not exist/)
    await assert.rejects(discoverProjects(join(root, 'App.xcodeproj', 'project.pbxproj')), /Not an Xcode project/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------------- *
 * lib/project.js — SwiftPM describe flag compatibility
 * ------------------------------------------------------------------------- */

test('SwiftPM describe fallbacks detect the old/new JSON spelling', () => {
  const argv = ['xcrun', 'swift', 'package', '--package-path', '/pkg', 'describe', '--json']
  assert.equal(needsSwiftDescribeTypeJson("error: Unknown option '--json'"), true)
  assert.equal(needsSwiftDescribeTypeJson('Build complete!'), false)
  assert.deepEqual(withSwiftDescribeTypeJson(argv), [
    'xcrun',
    'swift',
    'package',
    '--package-path',
    '/pkg',
    'describe',
    '--type',
    'json',
  ])
  assert.deepEqual(argv.slice(-1), ['--json'], 'input argv must not be mutated')
})

/* ------------------------------------------------------------------------- *
 * lib/build.js — output parsing
 * ------------------------------------------------------------------------- */

test('parseBuildOutput reports a successful xcodebuild run', () => {
  const parsed = parseBuildOutput(BUILD_SUCCEEDED_TEXT)
  assert.equal(parsed.result, 'succeeded')
  assert.equal(parsed.succeeded, true)
  assert.equal(parsed.errorCount, 0)
  assert.equal(parsed.warningCount, 1)
})

test('parseBuildOutput reports a successful SwiftPM run', () => {
  const parsed = parseBuildOutput(SWIFT_BUILD_SUCCEEDED_TEXT)
  assert.equal(parsed.result, 'succeeded')
  assert.equal(parsed.succeeded, true)
})

test('parseBuildOutput collects errors with file:line:column and failed steps', () => {
  const parsed = parseBuildOutput(BUILD_FAILED_TEXT)
  assert.equal(parsed.result, 'failed')
  assert.equal(parsed.succeeded, false)
  assert.equal(parsed.errorCount, 3)
  assert.equal(parsed.errors[0].file, '/Users/dev/MyApp/Login.swift')
  assert.equal(parsed.errors[0].line, 42)
  assert.equal(parsed.errors[0].column, 18)
  assert.match(parsed.errors[0].message, /cannot find 'validate' in scope/)
  assert.equal(parsed.errors[1].line, 43)
  assert.equal(parsed.errors[1].column, undefined)
  assert.match(parsed.errors[2].message, /Linker command failed/)
  assert.equal(parsed.warningCount, 1)
  assert.equal(parsed.failedCommands.length, 2)
  assert.match(parsed.failedCommands[0], /CompileSwift/)
  assert.equal(parsed.failedCommandCount, 2)
})

test('parseBuildOutput de-duplicates repeated diagnostics', () => {
  const text = [
    '/tmp/a.swift:1:1: error: boom',
    '/tmp/a.swift:1:1: error: boom',
    'error: boom',
    'error: boom',
  ].join('\n')
  const parsed = parseBuildOutput(text)
  assert.equal(parsed.errorCount, 2)
  assert.equal(parsed.result, 'failed')
})

test('parseBuildOutput handles unknown output and <unknown> file diagnostics', () => {
  assert.equal(parseBuildOutput('just some text').result, 'unknown')
  const parsed = parseBuildOutput('<unknown>:0: error: unknown argument: -target-arch-variant')
  assert.equal(parsed.result, 'failed')
  assert.equal(parsed.errors[0].file, '<unknown>')
  assert.equal(parsed.errors[0].line, 0)
})

/* ------------------------------------------------------------------------- *
 * lib/build.js — destinations
 * ------------------------------------------------------------------------- */

test('normalizePlatform maps simulator, device and macOS names', () => {
  assert.deepEqual(normalizePlatform('iOS'), { kind: 'simulator', family: 'iOS', label: 'iOS Simulator' })
  assert.deepEqual(normalizePlatform('iphonesimulator'), { kind: 'simulator', family: 'iOS', label: 'iOS Simulator' })
  assert.deepEqual(normalizePlatform('tvos'), { kind: 'simulator', family: 'tvOS', label: 'tvOS Simulator' })
  assert.deepEqual(normalizePlatform('macOS'), { kind: 'macos', family: 'macOS', label: 'macOS' })
  assert.deepEqual(normalizePlatform('iphoneos'), { kind: 'device', family: 'iOS', label: 'iOS' })
  assert.equal(normalizePlatform('linux'), undefined)
  assert.equal(normalizePlatform(''), undefined)
  assert.equal(simulatorPlatformLabel('tvOS'), 'tvOS Simulator')
})

test('buildDestination passes an explicit destination through untouched', () => {
  const resolved = buildDestination(DEVICES, { destination: 'platform=macOS,arch=arm64' })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.destination, 'platform=macOS,arch=arm64')
  assert.equal(resolved.explicit, true)
})

test('buildDestination resolves platform-only inputs', () => {
  assert.equal(buildDestination(DEVICES, { platform: 'ios' }).destination, 'generic/platform=iOS Simulator')
  assert.equal(buildDestination(DEVICES, { platform: 'macos' }).destination, 'platform=macOS')
  assert.equal(buildDestination(DEVICES, { platform: 'iphoneos' }).destination, 'generic/platform=iOS')
  const unknown = buildDestination(DEVICES, { platform: 'linux' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /Unknown platform/)
})

test('buildDestination resolves device names and UDIDs through the simulator list', () => {
  const byName = buildDestination(DEVICES, { device: 'iPhone 16' })
  assert.equal(byName.ok, true)
  assert.equal(byName.destination, 'platform=iOS Simulator,id=11111111-1111-1111-1111-111111111111')
  assert.equal(byName.device.name, 'iPhone 16')

  const byUdid = buildDestination(DEVICES, { device: '33333333-3333-3333-3333-333333333333' })
  assert.equal(byUdid.destination, 'platform=tvOS Simulator,id=33333333-3333-3333-3333-333333333333')

  const booted = buildDestination(DEVICES, { device: 'booted' })
  assert.equal(booted.destination, 'platform=iOS Simulator,id=22222222-2222-2222-2222-222222222222')

  const withOs = buildDestination(DEVICES, { device: 'iPhone 16', os: '26.1' })
  assert.equal(withOs.destination, 'platform=iOS Simulator,name=iPhone 16,OS=26.1')

  const missing = buildDestination(DEVICES, { device: 'iPad Pro' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /No simulator matches/)
  assert.equal(buildDestination(DEVICES, { device: 'iPhone 16', platform: 'macos' }).ok, false)
})

test('buildDestination carries no destination when nothing was requested', () => {
  const resolved = buildDestination(DEVICES, {})
  assert.equal(resolved.ok, true)
  assert.equal(resolved.destination, undefined)
  assert.match(resolved.note, /xcodebuild chooses/)
})

test('simulatorDestination and pickDefaultSimulator choose useful defaults', () => {
  const device = DEVICES[0]
  assert.equal(simulatorDestination(device), 'platform=iOS Simulator,id=11111111-1111-1111-1111-111111111111')
  assert.equal(
    simulatorDestination(device, { os: '27.2' }),
    'platform=iOS Simulator,name=iPhone 16,OS=27.2',
  )
  assert.equal(
    simulatorDestination(device, { platform: 'iOS', os: '27.2' }),
    'platform=iOS Simulator,name=iPhone 16,OS=27.2',
  )
  const booted = pickDefaultSimulator(DEVICES)
  assert.equal(booted.name, 'iPhone 16 Pro')
  assert.equal(pickDefaultSimulator(DEVICES.filter((device) => device.state !== 'Booted')).name, 'iPhone 16')
  assert.equal(pickDefaultSimulator(DEVICES, { platform: 'tvos' }).name, 'Apple TV')
  assert.equal(pickDefaultSimulator([]), undefined)
})

test('SwiftPM sandbox fallback rewrites swift invocations only', () => {
  assert.equal(needsSwiftSandboxFallback('sandbox-exec: sandbox_apply: Operation not permitted'), true)
  assert.equal(needsSwiftSandboxFallback('error: cannot find manifest'), false)

  assert.deepEqual(swiftSandboxFallbackArgv(['xcrun', 'swift', 'build', '--package-path', '/pkg']), [
    'xcrun',
    'swift',
    'build',
    '--disable-sandbox',
    '--package-path',
    '/pkg',
  ])
  assert.deepEqual(swiftSandboxFallbackArgv(['xcrun', 'swift', 'package', '--package-path', '/pkg', 'describe']), [
    'xcrun',
    'swift',
    'package',
    '--disable-sandbox',
    '--package-path',
    '/pkg',
    'describe',
  ])
  assert.deepEqual(swiftSandboxFallbackArgv(['xcrun', 'simctl', 'list']), ['xcrun', 'simctl', 'list'])
})

/* ------------------------------------------------------------------------- *
 * lib/test.js
 * ------------------------------------------------------------------------- */

test('parseTestOutput reports a passing XCTest run', () => {
  const parsed = parseTestOutput(TEST_PASSED_TEXT)
  assert.equal(parsed.result, 'passed')
  assert.equal(parsed.passed, true)
  assert.equal(parsed.executed, 1)
  assert.equal(parsed.failureCount, 0)
  assert.equal(parsed.caseCounts.passed, 1)
  assert.equal(parsed.failingTestCount, 0)
})

test('parseTestOutput reports failing tests with file and line', () => {
  const parsed = parseTestOutput(TEST_FAILED_TEXT)
  assert.equal(parsed.result, 'failed')
  assert.equal(parsed.passed, false)
  assert.equal(parsed.executed, 2)
  assert.equal(parsed.failureCount, 1)
  assert.equal(parsed.unexpectedFailures, 0)
  assert.equal(parsed.caseCounts.passed, 1)
  assert.equal(parsed.caseCounts.failed, 1)
  const failure = parsed.failingTests[0]
  assert.equal(failure.suite, 'MyAppTests.LoginTests')
  assert.equal(failure.name, 'testFailure')
  assert.equal(failure.file, '/private/tmp/MyApp/Tests/LoginTests.swift')
  assert.equal(failure.line, 42)
  assert.match(failure.message, /XCTAssertEqual failed/)
  assert.equal(parsed.failingTestCount, 1)
})

test('parseTestOutput prefers the XCTest summary over the Swift Testing footer', () => {
  const text = [
    "Test Suite 'All tests' failed at 2026-11-11 00:43:04.012.",
    '\t Executed 2 tests, with 1 failure (0 unexpected) in 4.456 (4.456) seconds',
    '◇ Test run started.',
    '✔ Test run with 0 tests in 0 suites passed after 0.001 seconds.',
  ].join('\n')
  const parsed = parseTestOutput(text)
  assert.equal(parsed.result, 'failed')
  assert.equal(parsed.executed, 2)
  assert.equal(parsed.failureCount, 1)
})

test('parseTestOutput handles compile failures without a test summary', () => {
  const text = [
    '/private/tmp/MyApp/Tests/LoginTests.swift:9:9: error: cannot find type \'LoginTests\' in scope',
    '** TEST FAILED **',
  ].join('\n')
  const parsed = parseTestOutput(text)
  assert.equal(parsed.result, 'failed')
  assert.equal(parsed.errorCount, 1)
  assert.equal(parsed.errors[0].line, 9)
})

test('parseTestOutput handles a Swift Testing summary when XCTest did not run', () => {
  const parsed = parseTestOutput('◇ Test run started.\n✔ Test run with 3 tests in 1 suite passed after 0.010 seconds.')
  assert.equal(parsed.result, 'passed')
  assert.equal(parsed.executed, 3)
  assert.equal(parsed.failureCount, 0)
})

/* ------------------------------------------------------------------------- *
 * Tool definitions with a fake runner (no toolchain)
 * ------------------------------------------------------------------------- */

function fakeContext(directory) {
  return {
    get(name) {
      return name === 'workingDirectory' ? { defaultDirectory: directory } : undefined
    },
  }
}

function fakeConfig() {
  return {
    xcodebuild: 'xcodebuild',
    developerDir: '',
    derivedDataPath: '.apple-dev/DerivedData',
    logDirectory: '.apple-dev/logs',
    timeoutMs: 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
  }
}

function resultFor(argv, options, { stdout = '', stderr = '', exitCode = 0 } = {}) {
  return {
    ok: exitCode === 0,
    command: argv.join(' '),
    argv,
    cwd: options && options.cwd,
    label: options && options.label,
    exitCode,
    signal: null,
    timedOut: false,
    cancelled: false,
    spawnError: undefined,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    truncated: false,
    durationMs: 12,
  }
}

test('createProjectTools returns exactly three plain tool definitions', () => {
  const tools = createProjectTools(fakeContext('/tmp'), fakeConfig(), async () => resultFor([], {}))
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['apple_dev_project', 'apple_dev_build', 'apple_dev_test'],
  )
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.timeoutMs, 'number')
    const rendered = tool.output.render({}, { ok: false, error: 'boom', summary: 'boom' })
    assert.equal(Array.isArray(rendered), true)
    assert.equal(rendered[0].type, 'text')
    assert.equal(typeof rendered[0].text, 'string')
  }
  assert.equal(typeof tools[1].presentCall, 'function')
  assert.equal(typeof tools[1].presentResult, 'function')
  assert.equal(typeof tools[2].presentCall, 'function')
  assert.equal(tools[1].presentCall({ scheme: 'MyApp', configuration: 'Debug' }).card, 'terminal')
  // presentResult receives the DSH ToolResult: presentation fields ride in `meta`.
  const buildValue = { ok: false, summary: 'Build failed', error: 'boom.swift:1:1: error: boom', exitCode: 65, outputTail: '** BUILD FAILED **' }
  const meta = tools[1].output.presentationMeta({}, buildValue)
  assert.equal(meta.summary, 'Build failed')
  assert.equal(meta.exitCode, 65)
  const resultView = tools[1].presentResult({}, {
    content: [{ type: 'text', text: 'Build failed' }],
    isError: true,
    meta,
  })
  assert.equal(resultView.card, 'terminal')
  assert.equal(resultView.exitCode, 65)
  assert.match(resultView.output, /Build failed/)
  assert.match(resultView.output, /BUILD FAILED/)
  assert.equal(tools[2].output.presentationMeta({}, { ok: true, summary: 'Tests passed', exitCode: 0 }).summary, 'Tests passed')
})

test('apple_dev_project validates its action argument', async () => {
  const tools = createProjectTools(fakeContext(tmpdir()), fakeConfig(), async () => resultFor([], {}))
  await assert.rejects(tools[0].execute({ action: 'bogus' }), /`action` must be one of/)
  await assert.rejects(tools[0].execute('not-an-object'), /`action` must be one of/)
})

test('apple_dev_project list discovers projects in a directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-list-'))
  try {
    await mkdir(join(root, 'MyApp.xcodeproj'), { recursive: true })
    const tools = createProjectTools(fakeContext(root), fakeConfig(), async () => resultFor([], {}))
    const result = await tools[0].execute({ action: 'list' }, {})
    assert.equal(result.ok, true)
    assert.equal(result.action, 'list')
    assert.equal(result.count, 1)
    assert.equal(result.entries[0].kind, 'project')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('apple_dev_project info drives xcodebuild -list -json through the runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-info-'))
  try {
    await mkdir(join(root, 'MyApp.xcodeproj'), { recursive: true })
    const calls = []
    const tools = createProjectTools(fakeContext(root), fakeConfig(), async (argv, options) => {
      calls.push(argv)
      return resultFor(argv, options, { stdout: XCODEBUILD_LIST_JSON })
    })
    const result = await tools[0].execute({ action: 'info' }, {})
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'project')
    assert.deepEqual(result.schemes, ['MyApp'])
    assert.deepEqual(result.targets, ['MyApp', 'MyAppTests'])
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'xcodebuild')
    assert.deepEqual(calls[0].slice(1, 3), ['-list', '-json'])
    assert.equal(calls[0][3], '-project')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('apple_dev_build parses success, saves a log and builds the expected command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-build-'))
  try {
    await mkdir(join(root, 'MyApp.xcodeproj'), { recursive: true })
    const calls = []
    const tools = createProjectTools(fakeContext(root), fakeConfig(), async (argv, options) => {
      calls.push(argv)
      return resultFor(argv, options, { stdout: BUILD_SUCCEEDED_TEXT })
    })
    const result = await tools[1].execute({}, {})
    assert.equal(result.ok, true)
    assert.equal(result.action, 'build')
    assert.equal(result.kind, 'xcode')
    assert.equal(result.result, 'succeeded')
    assert.equal(result.exitCode, 0)
    assert.equal(result.warningCount, 1)
    assert.match(result.logPath, /\.apple-dev\/logs\/build-/)
    const command = calls[0]
    assert.equal(command[0], 'xcodebuild')
    assert.deepEqual(command.slice(1, 3), ['-project', join(root, 'MyApp.xcodeproj')])
    assert.ok(command.includes('-configuration') && command.indexOf('Debug') > 0)
    assert.ok(command.includes('-derivedDataPath'))
    assert.ok(command.includes(join(root, '.apple-dev', 'DerivedData')))
    assert.deepEqual(command.slice(-1), ['build'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('apple_dev_build turns a failed build into a result, not a thrown error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-build-fail-'))
  try {
    await mkdir(join(root, 'MyApp.xcodeproj'), { recursive: true })
    const tools = createProjectTools(fakeContext(root), fakeConfig(), async (argv, options) =>
      resultFor(argv, options, { stdout: BUILD_FAILED_TEXT, exitCode: 65 }),
    )
    const result = await tools[1].execute({ scheme: 'MyApp' }, {})
    assert.equal(result.ok, false)
    assert.equal(result.result, 'failed')
    assert.equal(result.exitCode, 65)
    assert.equal(result.errorCount, 3)
    assert.match(result.error, /Login\.swift:42:18/)
    assert.ok(result.logPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('apple_dev_test parses failing tests and keeps exitCode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-test-'))
  try {
    await mkdir(join(root, 'MyApp.xcodeproj'), { recursive: true })
    const simulatorListJson = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-27-2': DEVICES.filter((device) => device.platform === 'iOS').map(
          (device) => ({ udid: device.udid, name: device.name, state: device.state, isAvailable: true }),
        ),
      },
    })
    const calls = []
    const tools = createProjectTools(fakeContext(root), fakeConfig(), async (argv, options) => {
      calls.push(argv)
      // Scheme resolution, simulator discovery, then the real test invocation.
      if (argv.includes('-list')) {
        return resultFor(argv, options, { stdout: XCODEBUILD_LIST_JSON })
      }
      if (argv.includes('simctl')) {
        return resultFor(argv, options, { stdout: simulatorListJson })
      }
      return resultFor(argv, options, { stdout: TEST_FAILED_TEXT, exitCode: 65 })
    })
    const result = await tools[2].execute({ only_testing: ['MyAppTests/LoginTests/testFailure'] }, {})
    assert.equal(result.ok, false)
    assert.equal(result.action, 'test')
    assert.equal(result.scheme, 'MyApp')
    assert.equal(result.executed, 2)
    assert.equal(result.failureCount, 1)
    assert.equal(result.failingTests[0].name, 'testFailure')
    assert.match(result.error, /testFailure/)
    assert.ok(result.logPath)
    const testCall = calls.find((argv) => argv.includes('test'))
    assert.ok(testCall)
    assert.ok(testCall.includes('-only-testing:MyAppTests/LoginTests/testFailure'))
    assert.ok(testCall.some((part) => String(part).startsWith('platform=iOS Simulator,id=')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------------- *
 * Real Swift package smoke test (throwaway package under the temp directory)
 * ------------------------------------------------------------------------- */

function swiftProbe() {
  if (process.platform !== 'darwin') return { ok: false, reason: 'requires macOS' }
  const probe = spawnSync('xcrun', ['--find', 'swift'], { encoding: 'utf8' })
  if (probe.status !== 0 || !probe.stdout.trim()) return { ok: false, reason: 'swift toolchain unavailable' }
  return { ok: true, path: probe.stdout.trim() }
}

/**
 * Minimal stand-in for the Host runner: spawns a real command and normalizes the
 * result to the runner contract. Used by the smoke test only.
 */
function localRunner(childEnv) {
  return (argv, options = {}) =>
    new Promise((resolve) => {
      const started = Date.now()
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      let timer
      let child
      const finish = (exitCode, signal) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve({
          ok: exitCode === 0 && !timedOut,
          command: argv.join(' '),
          argv,
          cwd: options.cwd,
          label: options.label,
          exitCode,
          signal: signal ?? null,
          timedOut,
          cancelled: false,
          spawnError: undefined,
          stdout,
          stderr,
          stdoutTruncated: false,
          stderrTruncated: false,
          truncated: false,
          durationMs: Date.now() - started,
        })
      }
      try {
        child = spawn(argv[0], argv.slice(1), {
          cwd: options.cwd,
          env: { ...process.env, ...childEnv },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        stderr = error.message
        finish(null, null)
        return
      }
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', (error) => {
        stderr += error.message
        finish(null, null)
      })
      child.on('close', (exitCode, signal) => finish(exitCode, signal))
      if (options.timeoutMs) {
        timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, options.timeoutMs)
      }
    })
}

const SMOKE_PROBE = swiftProbe()

test(
  'real Swift package smoke: discovery, describe, build, test and a real compile failure',
  { skip: SMOKE_PROBE.ok ? false : `skipped: ${SMOKE_PROBE.reason}`, timeout: 240_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'apple-dev-smoke-'))
    const home = join(root, 'home')
    const scratch = join(root, 'tmp')
    const clangCache = join(root, 'clang')
    const packagePath = join(root, 'SmokeKit')
    const childEnv = {
      HOME: home,
      TMPDIR: scratch,
      CLANG_MODULE_CACHE_PATH: clangCache,
      XDG_CACHE_HOME: join(home, '.cache'),
    }
    try {
      await mkdir(home, { recursive: true })
      await mkdir(scratch, { recursive: true })
      await mkdir(clangCache, { recursive: true })
      await mkdir(packagePath, { recursive: true })
      const init = spawnSync(
        'xcrun',
        ['swift', 'package', 'init', '--type', 'library', '--name', 'SmokeKit'],
        { cwd: packagePath, env: { ...process.env, ...childEnv }, encoding: 'utf8' },
      )
      assert.equal(init.status, 0, `swift package init failed: ${init.stderr}`)
      // Use XCTest so the test tool sees the classic Test Suite/Executed output.
      await writeFile(
        join(packagePath, 'Tests', 'SmokeKitTests', 'SmokeKitTests.swift'),
        [
          'import XCTest',
          '@testable import SmokeKit',
          '',
          'final class SmokeKitTests: XCTestCase {',
          '    func testExample() {',
          '        XCTAssertEqual(1, 1)',
          '    }',
          '}',
          '',
        ].join('\n'),
      )

      const discovery = await discoverProjects(root)
      assert.ok(
        discovery.entries.some((entry) => entry.kind === 'package' && entry.path === packagePath),
        'discovery should find the package',
      )

      const tools = createProjectTools(fakeContext(root), fakeConfig(), localRunner(childEnv))
      const [projectTool, buildTool, testTool] = tools

      const info = await projectTool.execute({ action: 'info', path: packagePath }, {})
      assert.equal(info.ok, true, `describe failed: ${info.error}`)
      assert.equal(info.kind, 'package')
      assert.ok(info.targets.some((target) => target.name === 'SmokeKit'))
      assert.ok(info.products.some((product) => product.name === 'SmokeKit'))

      const build = await buildTool.execute({ path: packagePath }, {})
      assert.equal(build.ok, true, `swift build failed: ${build.error || build.outputTail}`)
      assert.equal(build.result, 'succeeded')
      assert.equal(build.kind, 'package')
      assert.ok(build.logPath, 'build log should be saved')

      const run = await testTool.execute({ path: packagePath }, {})
      assert.equal(run.action, 'test')
      assert.equal(run.kind, 'package')
      assert.equal(run.ok, true, `swift test failed: ${run.error || run.outputTail}`)
      assert.equal(run.result, 'passed')
      assert.equal(run.executed, 1)
      assert.equal(run.failureCount, 0)
      assert.ok(run.logPath, 'test log should be saved')

      // A real compile error exercises the error parser end to end.
      await writeFile(
        join(packagePath, 'Sources', 'SmokeKit', 'Broken.swift'),
        'let broken: Int = "not an Int"\n',
      )
      const broken = await buildTool.execute({ path: packagePath }, {})
      assert.equal(broken.ok, false)
      assert.equal(broken.result, 'failed')
      assert.ok(broken.errorCount >= 1, `expected compile errors, got: ${broken.outputTail}`)
      assert.ok(
        broken.errors.some((error) => typeof error.file === 'string' && error.file.endsWith('Broken.swift')),
        `expected an error for Broken.swift, got ${JSON.stringify(broken.errors)}`,
      )
      assert.ok(broken.logPath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
