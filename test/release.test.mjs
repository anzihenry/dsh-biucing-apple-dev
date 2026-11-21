/**
 * Release tests: argv/plist builders, output and lane parsers, fastlane root
 * discovery, and the tool's archive/export/lanes/lane paths with a fake runner.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/runner.js'
import {
  buildArchiveArgv,
  buildExportArgv,
  buildExportOptionsPlist,
  buildLaneArgv,
  findFastlaneRoot,
  isValidLaneName,
  latestArchive,
  parseLanes,
  parseReleaseOutput,
} from '../lib/release.js'
import { createReleaseTools, formatReleaseReport } from '../lib/tools-release.js'

const LANES_TEXT = `
[21:09:53]: fastlane 2.242.0 (Ruby 4.0.10, homebrew)
--------- ios---------
----- fastlane ios hello
Say hello

----- fastlane ios beta
Build the beta

Execute using \`fastlane [lane_name]\`
`

function ok(stdout) {
  return { ok: true, exitCode: 0, stdout, stderr: '', command: 'fake', durationMs: 3 }
}

test('argv builders keep one argument per value', () => {
  assert.deepEqual(
    buildArchiveArgv({
      containerKind: 'workspace',
      containerPath: '/p/App.xcworkspace',
      scheme: 'App',
      configuration: 'Release',
      destination: 'generic/platform=iOS',
      archivePath: '/out/App.xcarchive',
      derivedDataPath: '/dd',
      extraArgs: ['-quiet'],
    }),
    ['xcodebuild', 'archive', '-workspace', '/p/App.xcworkspace', '-scheme', 'App', '-configuration', 'Release',
      '-destination', 'generic/platform=iOS', '-archivePath', '/out/App.xcarchive', '-derivedDataPath', '/dd', '-quiet'],
  )
  assert.deepEqual(
    buildExportArgv({ archivePath: '/out/App.xcarchive', exportPath: '/out/ipa', plistPath: '/out/ExportOptions.plist' }),
    ['xcodebuild', '-exportArchive', '-archivePath', '/out/App.xcarchive', '-exportPath', '/out/ipa', '-exportOptionsPlist', '/out/ExportOptions.plist'],
  )
  assert.deepEqual(buildLaneArgv({ lane: 'beta', env: 'staging', extraArgs: ['--verbose'] }), ['fastlane', 'beta', '--env', 'staging', '--verbose'])
})

test('ExportOptions.plist carries method/team/signing and escapes values', () => {
  const plist = buildExportOptionsPlist({ method: 'app-store-connect', teamId: 'AB&CD', signingStyle: 'manual', uploadSymbols: false })
  assert.match(plist, /<key>method<\/key>\s*<string>app-store-connect<\/string>/)
  assert.match(plist, /<key>teamID<\/key>\s*<string>AB&amp;CD<\/string>/)
  assert.match(plist, /<key>signingStyle<\/key>\s*<string>manual<\/string>/)
  assert.match(plist, /<key>uploadSymbols<\/key>\s*<false\/>/)
  assert.match(buildExportOptionsPlist({ method: 'nonsense' }), /<string>app-store-connect<\/string>/)
})

test('parseReleaseOutput recognizes archive/export results and errors', () => {
  const ok = parseReleaseOutput('** ARCHIVE SUCCEEDED **\n')
  assert.equal(ok.archiveSucceeded, true)
  const failed = parseReleaseOutput('** ARCHIVE FAILED **\n/p/App.swift:12:5: error: cannot find type Foo\n')
  assert.equal(failed.archiveFailed, true)
  assert.equal(failed.errorCount, 1)
  assert.equal(failed.errors[0].file, '/p/App.swift')
  assert.equal(parseReleaseOutput('** EXPORT SUCCEEDED **').exportSucceeded, true)
})

test('parseLanes strips ANSI and keeps platform/name/description', () => {
  const lanes = parseLanes(`\u001b[33m--------- ios---------\u001b[0m\n----- fastlane ios hello\nSay hello\n\n----- fastlane ios beta\nBuild the beta\n`)
  assert.deepEqual(lanes, [
    { platform: 'ios', name: 'hello', description: 'Say hello' },
    { platform: 'ios', name: 'beta', description: 'Build the beta' },
  ])
  assert.equal(isValidLaneName('beta_2'), true)
  assert.equal(isValidLaneName('bad lane'), false)
})

test('findFastlaneRoot walks up and latestArchive picks the newest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-release-'))
  try {
    await mkdir(join(root, 'fastlane'), { recursive: true })
    await writeFile(join(root, 'fastlane', 'Fastfile'), 'lane :hello do\nend\n')
    await mkdir(join(root, 'Sources', 'Nested'), { recursive: true })
    assert.equal(await findFastlaneRoot(join(root, 'Sources', 'Nested')), root)
    assert.equal(await findFastlaneRoot(join(root, 'fastlane')), root)
    assert.equal(await findFastlaneRoot(join(root, 'fastlane', 'Fastfile')), root)

    await mkdir(join(root, 'archives', 'A.xcarchive'), { recursive: true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await mkdir(join(root, 'archives', 'B.xcarchive'), { recursive: true })
    assert.equal(await latestArchive(join(root, 'archives')), join(root, 'archives', 'B.xcarchive'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('release tool archives a project with a fake runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-arch-'))
  try {
    await mkdir(join(root, 'App.xcodeproj'), { recursive: true })
    const config = resolveConfig({ archiveDirectory: join(root, 'archives') })
    const calls = []
    const runner = async (argv, options) => {
      calls.push({ argv, options })
      return ok('** ARCHIVE SUCCEEDED **\n')
    }
    const ctx = { get: (service) => (service === 'workingDirectory' ? { defaultDirectory: root } : undefined) }
    const tool = createReleaseTools(ctx, config, runner)[0]
    const result = await tool.execute({ action: 'archive', scheme: 'App' }, {})
    assert.equal(result.ok, true, result.error)
    assert.equal(result.archivePath.startsWith(join(root, 'archives')), true)
    assert.equal(calls[0].argv.includes('-project'), true)
    assert.equal(calls[0].argv.includes('-scheme'), true)
    assert.match(formatReleaseReport(result), /ARCHIVE SUCCEEDED/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('release tool exports to an IPA and runs fastlane lanes/lane', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-exp-'))
  try {
    await mkdir(join(root, 'App.xcodeproj'), { recursive: true })
    await mkdir(join(root, 'archives', 'App.xcarchive'), { recursive: true })
    await mkdir(join(root, 'fastlane'), { recursive: true })
    await writeFile(join(root, 'fastlane', 'Fastfile'), 'lane :hello do\nend\n')
    const config = resolveConfig({ archiveDirectory: join(root, 'archives'), exportDirectory: join(root, 'exports') })
    const calls = []
    const runner = async (argv, options) => {
      calls.push({ argv, options })
      if (argv[0] === 'xcodebuild' && argv.includes('-exportArchive')) {
        const exportPath = argv[argv.indexOf('-exportPath') + 1]
        await mkdir(exportPath, { recursive: true })
        await writeFile(join(exportPath, 'App.ipa'), 'ipa-bytes')
        return ok('** EXPORT SUCCEEDED **\n')
      }
      if (argv[0] === 'fastlane' && argv[1] === 'lanes') return ok(LANES_TEXT)
      return ok('hello from fastlane\n')
    }
    const ctx = { get: (service) => (service === 'workingDirectory' ? { defaultDirectory: root } : undefined) }
    const tool = createReleaseTools(ctx, config, runner)[0]

    const exported = await tool.execute({ action: 'export', archive_path: join(root, 'archives', 'App.xcarchive') }, {})
    assert.equal(exported.ok, true, exported.error)
    assert.match(exported.ipaPath, /App\.ipa$/)
    assert.ok(exported.plistPath)

    const lanes = await tool.execute({ action: 'lanes', path: root }, {})
    assert.equal(lanes.ok, true, lanes.error)
    assert.deepEqual(lanes.lanes.map((lane) => lane.name), ['hello', 'beta'])
    assert.equal(calls.find((call) => call.argv[1] === 'lanes').options.cwd, root)

    const lane = await tool.execute({ action: 'lane', lane: 'hello', path: root }, {})
    assert.equal(lane.ok, true, lane.error)
    assert.match(lane.output, /hello from fastlane/)
    assert.equal(lane.output.includes('\u001b'), false, 'ANSI codes are stripped')
    const laneCall = calls.find((call) => call.argv[0] === 'fastlane' && call.argv[1] === 'hello')
    assert.equal(laneCall.options.cwd, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
