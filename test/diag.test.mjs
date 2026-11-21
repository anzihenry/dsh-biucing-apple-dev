/**
 * Unit and integration tests for the diagnostics half of the Apple Dev plugin.
 *
 * Pure parsers are tested against inline fixtures shaped like real tool output;
 * operations are tested with a fake runner that records argv/stdin so the
 * contract (runner-only process execution, no shell interpolation, plutil via
 * stdin) is asserted directly. A few smoke tests run on a real macOS host.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseSimulatorList } from '../lib/env.js'
import {
  buildLogPredicate,
  buildLogShowArgv,
  crashReportDirectories,
  isCrashReportName,
  listCrashReports,
  parseCrashReportMetadata,
  parseLogWindow,
  quoteLogPredicate,
  readCrashReport,
  showLogs,
  sortCrashReports,
} from '../lib/logs.js'
import {
  decodeXmlEntities,
  inspectApp,
  parseCodeDirectory,
  parseCodesignDescription,
  parsePlistJson,
  parsePlistXml,
  parseRequirements,
  parseSigningIdentities,
  parseSpctlOutput,
  profileDirectories,
  readEntitlements,
  readIdentities,
  readProvisioningProfiles,
  sortProvisioningProfiles,
  summarizeProvisioningProfile,
  verifyApp,
} from '../lib/signing.js'
import { createDiagTools } from '../lib/tools-diag.js'

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const DEVICES_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [
      { udid: 'AAAAAAAA-0000-0000-0000-000000000001', name: 'iPhone 17', state: 'Booted', isAvailable: true },
      { udid: 'BBBBBBBB-0000-0000-0000-000000000002', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
    ],
  },
})

const IDENTITY_TEXT = [
  '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Jane Doe (ABCDE12345)"',
  '     1 valid identities found',
  '',
].join('\n')

const CODESIGN_DV = [
  'Executable=/tmp/App.app/Contents/MacOS/App',
  'Identifier=com.example.demo',
  'Format=app bundle with Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=12+5 location=embedded',
  'Platform identifier=27',
  'Hash type=sha256 size=32',
  'CandidateCDHash sha256=8f65d8749643b08cb26c7abb7d8f47f2cf66ad95',
  'CandidateCDHashFull sha256=8f65d8749643b08cb26c7abb7d8f47f2cf66ad957a5aa8e9b781d3719fcb041d',
  'Hash choices=sha256',
  'CDHash=8f65d8749643b08cb26c7abb7d8f47f2cf66ad95',
  'Signature size=4567',
  'Authority=Apple Development: Jane Doe (ABCDE12345)',
  'Authority=Apple Worldwide Developer Relations Certification Authority',
  'Authority=Apple Root CA',
  'Signed Time=Nov 10, 2026 at 10:00:00',
  'Info.plist entries=20',
  'TeamIdentifier=ABCDE12345',
  'Sealed Resources version=2 rules=13 files=42',
  'Internal requirements count=1 size=68',
  '',
].join('\n')

const PROFILE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AppIDName</key>
  <string>XC com example</string>
  <key>CreationDate</key>
  <date>2025-10-11T03:37:14Z</date>
  <key>DeveloperCertificates</key>
  <array>
    <data>aGVsbG8=</data>
  </array>
  <key>DER-Encoded-Profile</key>
  <data>cHJvZmlsZQ==</data>
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key>
    <string>TEAMID1234.com.example.demo</string>
    <key>com.apple.developer.team-identifier</key>
    <string>TEAMID1234</string>
    <key>get-task-allow</key>
    <true/>
  </dict>
  <key>ExpirationDate</key>
  <date>2027-10-11T03:37:14Z</date>
  <key>IsXcodeManaged</key>
  <true/>
  <key>Name</key>
  <string>iOS Team Provisioning Profile: com.example.demo</string>
  <key>Platform</key>
  <array>
    <string>iOS</string>
    <string>xrOS</string>
  </array>
  <key>ProvisionedDevices</key>
  <array>
    <string>00008101-00111DC111F8001E</string>
    <string>00008103-0012154A0A20801E</string>
  </array>
  <key>TeamIdentifier</key>
  <array>
    <string>TEAMID1234</string>
  </array>
  <key>TeamName</key>
  <string>Example Team</string>
  <key>UUID</key>
  <string>11111111-2222-3333-4444-555555555555</string>
</dict>
</plist>
`

const ENTITLEMENTS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0"><dict>',
  '<key>application-identifier</key><string>TEAMID1234.com.example.demo</string>',
  '<key>get-task-allow</key><true/>',
  '<key>keychain-access-groups</key><array><string>TEAMID1234.*</string></array>',
  '</dict></plist>',
].join('')

const CRASH_IPS = [
  '{"app_name":"Demo","timestamp":"2026-11-10 10:00:00.00 +0800","app_version":"1.2.3","bundleID":"com.example.demo","bug_type":"309","os_version":"iOS 27.2 (24C1)","incident_id":"ABC-123"}',
  '{"procName":"Demo","exception":{"type":"EXC_BAD_ACCESS"}}',
].join('\n')

const LEGACY_CRASH = [
  'Process: Demo [123]',
  'Identifier: com.example.demo',
  'Version: 1.2.3 (42)',
  'Date/Time: 2026-11-10 10:00:00.000 +0800',
  'OS Version: iOS 27.2 (24C1)',
  'Exception Type: EXC_BAD_ACCESS (SIGSEGV)',
  '',
].join('\n')

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

function fakeRunner(handler) {
  const calls = []
  const run = async (argv, options = {}) => {
    const command = argv.join(' ')
    calls.push({ argv, options, command })
    const base = {
      ok: false,
      command,
      argv,
      cwd: options.cwd ?? '/tmp/session',
      exitCode: 1,
      signal: null,
      timedOut: false,
      cancelled: false,
      spawnError: undefined,
      stdout: '',
      stderr: `unexpected command: ${command}`,
      stdoutTruncated: false,
      stderrTruncated: false,
      truncated: false,
      durationMs: 1,
    }
    const response = typeof handler === 'function' ? handler(argv, options, command) : handler && handler[command]
    if (response === undefined || response === null) return base
    return { ...base, ...(await response) }
  }
  run.calls = calls
  return run
}

function fakeContext(directory = '/tmp/session') {
  return {
    get(name) {
      if (name === 'workingDirectory') return { get: () => directory, defaultDirectory: directory }
      return undefined
    },
  }
}

async function makeTempDirectory(t, prefix = 'dsh-diag-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

/* ------------------------------------------------------------------------- *
 * Tool definitions
 * ------------------------------------------------------------------------- */

test('createDiagTools returns exactly the two valid plain tool definitions', () => {
  const tools = createDiagTools(fakeContext(), {}, fakeRunner())
  assert.equal(tools.length, 2)
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['apple_dev_logs', 'apple_dev_signing'])

  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 80)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.deepEqual(tool.parameters.required, ['action'])
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.timeoutMs, 'number')
    const rendered = tool.output.render({}, { ok: false, error: 'boom' })
    assert.equal(rendered.length, 1)
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /boom/)
  }

  const signing = tools.find((tool) => tool.name === 'apple_dev_signing')
  assert.deepEqual(signing.parameters.properties.action.enum, ['identities', 'profiles', 'inspect', 'entitlements', 'verify'])
  assert.equal(signing.parameters.properties.path.type, 'string')
  assert.equal(signing.parameters.properties.limit.type, 'integer')

  const logs = tools.find((tool) => tool.name === 'apple_dev_logs')
  assert.deepEqual(logs.parameters.properties.action.enum, ['show', 'crashes', 'symbolicate'])
  assert.equal(logs.parameters.properties.device.type, 'string')
  assert.equal(logs.parameters.properties.message_contains.type, 'string')
})

test('both tool renderers render every action without throwing', () => {
  const tools = createDiagTools(fakeContext(), {}, fakeRunner())
  const signing = tools.find((tool) => tool.name === 'apple_dev_signing')
  const logs = tools.find((tool) => tool.name === 'apple_dev_logs')

  const signingValues = [
    { action: 'identities', ok: true, count: 0, identities: [] },
    { action: 'identities', ok: true, count: 1, identities: [{ hash: 'A'.repeat(40), name: 'Apple Development: X' }] },
    { action: 'profiles', ok: true, count: 0, total: 0, profiles: [], directories: [{ directory: '/x', exists: false, files: 0 }] },
    { action: 'inspect', ok: true, path: '/tmp/App.app', signed: false, details: {}, note: 'not signed' },
    {
      action: 'inspect',
      ok: true,
      path: '/tmp/App.app',
      signed: true,
      details: parseCodesignDescription(CODESIGN_DV),
      requirements: 'identifier "com.example.demo"',
    },
    { action: 'entitlements', ok: true, path: '/tmp/App.app', available: false, entitlements: {} },
    { action: 'entitlements', ok: true, path: '/tmp/App.app', available: true, entitlements: { 'get-task-allow': true, list: ['a', 'b'] } },
    {
      action: 'verify',
      ok: false,
      path: '/tmp/App.app',
      verified: false,
      signature: { ok: false, exitCode: 1, output: 'not signed' },
      spctl: { ok: false, available: true, accepted: false, decision: 'rejected', reason: 'no usable signature' },
    },
  ]
  signingValues.push({ action: 'inspect', ok: false, path: '/missing.app', error: 'No file or directory at /missing.app.' })
  signingValues.push({ action: 'entitlements', ok: false, path: '/missing.app', error: 'No file or directory at /missing.app.' })
  signingValues.push({ action: 'verify', ok: false, path: '/missing.app', error: 'No file or directory at /missing.app.' })
  for (const value of signingValues) {
    const rendered = signing.output.render({}, value)
    assert.equal(rendered[0].type, 'text')
    assert.ok(rendered[0].text.length > 0)
    if (value.ok === false && value.error && value.action !== 'verify') {
      assert.doesNotMatch(rendered[0].text, /NOT SIGNED/)
    }
  }

  const logsValues = [
    { action: 'show', ok: true, device: { name: 'iPhone 17', platform: 'iOS', osVersion: '27.2', state: 'Booted', udid: 'U' }, window: '5m', predicate: undefined, totalLines: 2, lineLimit: 200, output: 'a\nb' },
    { action: 'show', ok: false, error: 'No simulator is booted.', candidates: [{ name: 'iPhone 17', platform: 'iOS', osVersion: '27.2', state: 'Shutdown', udid: 'U' }] },
    {
      action: 'crashes',
      ok: true,
      device: { name: 'iPhone 17', platform: 'iOS', osVersion: '27.2', state: 'Booted', udid: 'U' },
      count: 1,
      total: 1,
      directories: [{ directory: '/tmp/crashes', exists: true, count: 1 }],
      reports: [{ name: 'Demo.ips', path: '/tmp/crashes/Demo.ips', modified: '2026-11-10T02:00:00.000Z', size: 120 }],
      newest: {
        name: 'Demo.ips',
        path: '/tmp/crashes/Demo.ips',
        size: 120,
        modified: '2026-11-10T02:00:00.000Z',
        metadata: parseCrashReportMetadata(CRASH_IPS),
        summary: { app: 'Demo', version: '1.2.3', exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV' }, termination: { indicator: 'Segmentation fault: 11' }, threadCount: 3, faultingThread: 0 },
      },
    },
    {
      action: 'symbolicate',
      ok: true,
      facts: {
        app: 'Demo',
        version: '1.2',
        osVersion: 'iOS 27.2',
        exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', codes: '0x1' },
        termination: { indicator: 'Segmentation fault: 11' },
      },
      threads: [{ index: 0, triggered: true, frames: [{ imageName: 'Demo', address: 4294967296, offset: 4096, symbol: 'main', sourceFile: 'main.swift', sourceLine: 1 }] }],
      missingImages: [],
      notes: [],
    },
  ]
  for (const value of logsValues) {
    const rendered = logs.output.render({}, value)
    assert.equal(rendered[0].type, 'text')
    assert.ok(rendered[0].text.length > 0)
  }
})

test('both tools reject unknown actions with a readable error', async () => {
  const tools = createDiagTools(fakeContext(), {}, fakeRunner())
  const signing = tools.find((tool) => tool.name === 'apple_dev_signing')
  const logs = tools.find((tool) => tool.name === 'apple_dev_logs')
  await assert.rejects(() => signing.execute({ action: 'sign' }, {}), /action.*identities/)
  await assert.rejects(() => logs.execute({ action: 'stream' }, {}), /action.*show/)
})

/* ------------------------------------------------------------------------- *
 * Signing parsers
 * ------------------------------------------------------------------------- */

test('parseSigningIdentities reads count and name/hash pairs', () => {
  const parsed = parseSigningIdentities(IDENTITY_TEXT)
  assert.equal(parsed.count, 1)
  assert.deepEqual(parsed.identities, [{ hash: '0123456789ABCDEF0123456789ABCDEF01234567', name: 'Apple Development: Jane Doe (ABCDE12345)' }])

  const empty = parseSigningIdentities('     0 valid identities found\n')
  assert.equal(empty.count, 0)
  assert.deepEqual(empty.identities, [])
})

test('parseCodeDirectory reads version, size, flags and location', () => {
  const parsed = parseCodeDirectory('v=20500 size=1234 flags=0x10000(runtime) hashes=12+5 location=embedded')
  assert.equal(parsed.version, '20500')
  assert.equal(parsed.size, 1234)
  assert.deepEqual(parsed.flags, { raw: '0x10000', names: ['runtime'] })
  assert.equal(parsed.hashes, '12+5')
  assert.equal(parsed.location, 'embedded')
  assert.deepEqual(parseCodeDirectory('v=20400 size=10 flags=0x0(none)'), {
    version: '20400',
    size: 10,
    flags: { raw: '0x0', names: ['none'] },
    hashes: undefined,
    location: undefined,
  })
})

test('parseCodesignDescription parses a verbose codesign report', () => {
  const details = parseCodesignDescription(CODESIGN_DV)
  assert.equal(details.executable, '/tmp/App.app/Contents/MacOS/App')
  assert.equal(details.identifier, 'com.example.demo')
  assert.equal(details.teamIdentifier, 'ABCDE12345')
  assert.equal(details.format, 'app bundle with Mach-O thin (arm64)')
  assert.equal(details.cdhash, '8f65d8749643b08cb26c7abb7d8f47f2cf66ad95')
  assert.equal(details.authorities.length, 3)
  assert.equal(details.authorities[0], 'Apple Development: Jane Doe (ABCDE12345)')
  assert.deepEqual(details.flags, { raw: '0x10000', names: ['runtime'] })
  assert.equal(details.signedTime, 'Nov 10, 2026 at 10:00:00')
  assert.equal(details.signatureSize, 4567)
  assert.deepEqual(details.candidateCdhashes, [{ type: 'sha256', value: '8f65d8749643b08cb26c7abb7d8f47f2cf66ad95' }])

  const unsigned = parseCodesignDescription('/tmp/x: code object is not signed at all')
  assert.equal(unsigned.identifier, undefined)
  assert.deepEqual(unsigned.authorities, [])
})

test('parseCodesignDescription treats "TeamIdentifier=not set" as absent', () => {
  const details = parseCodesignDescription('Identifier=com.apple.calculator\nTeamIdentifier=not set\n')
  assert.equal(details.teamIdentifier, undefined)
})

test('parseRequirements extracts the designated requirement', () => {
  const parsed = parseRequirements('Executable=/tmp/App.app/Contents/MacOS/App\ndesignated => identifier "com.example.demo" and anchor apple\n')
  assert.equal(parsed.designated, 'identifier "com.example.demo" and anchor apple')
  assert.equal(parsed.entries.length, 1)
  assert.equal(parseRequirements('not signed at all').designated, undefined)
})

test('parseSpctlOutput reads accepted and rejected assessments', () => {
  const accepted = parseSpctlOutput('/System/Applications/Calculator.app: accepted\nsource=Apple System\norigin=macOS Software Signing\n')
  assert.equal(accepted.decision, 'accepted')
  assert.equal(accepted.path, '/System/Applications/Calculator.app')
  assert.equal(accepted.source, 'Apple System')
  assert.equal(accepted.origin, 'macOS Software Signing')

  const rejected = parseSpctlOutput('/tmp/x: rejected\nsource=no usable signature\n')
  assert.equal(rejected.decision, 'rejected')
  assert.equal(rejected.reason, undefined)
  assert.equal(rejected.source, 'no usable signature')

  const withReason = parseSpctlOutput('/tmp/x: rejected (the code is valid but does not seem to be an app)\nsource=Unnotarized Developer ID\n')
  assert.equal(withReason.decision, 'rejected')
  assert.equal(withReason.reason, 'the code is valid but does not seem to be an app')
})

/* ------------------------------------------------------------------------- *
 * Plist parsing and provisioning-profile summaries
 * ------------------------------------------------------------------------- */

test('parsePlistJson tolerates leading plutil noise and rejects garbage', () => {
  assert.deepEqual(parsePlistJson('{"a":1,"b":[true]}'), { a: 1, b: [true] })
  assert.deepEqual(parsePlistJson('warning line\n{"a":1}'), { a: 1 })
  assert.equal(parsePlistJson('not json'), undefined)
  assert.equal(parsePlistJson('[1,2]'), undefined)
})

test('decodeXmlEntities decodes named and numeric references', () => {
  assert.equal(decodeXmlEntities('a &amp; b &lt; c &quot;d&quot; &#65; &#x42;'), 'a & b < c "d" A B')
})

test('parsePlistXml parses dictionaries, arrays, scalars, dates and drops data blobs', () => {
  const parsed = parsePlistXml(PROFILE_PLIST)
  assert.equal(parsed.Name, 'iOS Team Provisioning Profile: com.example.demo')
  assert.equal(parsed.UUID, '11111111-2222-3333-4444-555555555555')
  assert.equal(parsed.TeamIdentifier[0], 'TEAMID1234')
  assert.deepEqual(parsed.Platform, ['iOS', 'xrOS'])
  assert.equal(parsed.ExpirationDate, '2027-10-11T03:37:14.000Z')
  assert.equal(parsed.ProvisionedDevices.length, 2)
  assert.equal(parsed.IsXcodeManaged, true)
  assert.equal(parsed.Entitlements['get-task-allow'], true)
  // Binary payloads are summarized, never returned as raw certificate material.
  assert.deepEqual(parsed.DeveloperCertificates, [{ kind: 'data', bytes: 5 }])
  assert.deepEqual(parsed['DER-Encoded-Profile'], { kind: 'data', bytes: 7 })
})

test('parsePlistXml handles empty elements, nested arrays and real numbers', () => {
  const parsed = parsePlistXml('<plist><dict><key>empty</key><array/><key>emptyString</key><string/><key>nested</key><array><dict><key>x</key><real>1.5</real></dict></array><key>off</key><false/></dict></plist>')
  assert.deepEqual(parsed, { empty: [], emptyString: '', nested: [{ x: 1.5 }], off: false })
  assert.throws(() => parsePlistXml('<plist><dict><key>a</key></dict></plist>'), /Malformed plist XML/)
})

test('summarizeProvisioningProfile reduces a profile to metadata', () => {
  const payload = parsePlistXml(PROFILE_PLIST)
  const summary = summarizeProvisioningProfile(payload, { now: Date.parse('2026-11-11T00:00:00Z') })
  assert.equal(summary.name, 'iOS Team Provisioning Profile: com.example.demo')
  assert.equal(summary.uuid, '11111111-2222-3333-4444-555555555555')
  assert.equal(summary.teamName, 'Example Team')
  assert.equal(summary.teamIdentifier, 'TEAMID1234')
  assert.equal(summary.applicationIdentifier, 'TEAMID1234.com.example.demo')
  assert.equal(summary.getTaskAllow, true)
  assert.equal(summary.provisionedDevices, 2)
  assert.deepEqual(summary.platform, ['iOS', 'xrOS'])
  assert.equal(summary.isXcodeManaged, true)
  assert.equal(summary.expired, false)
  assert.equal(summary.expiresInDays, 334)
  // No certificate/DER blobs or device UDIDs leak into the summary.
  assert.equal(Object.keys(summary).some((key) => /cert|device[sS]|der/i.test(key) && key !== 'provisionedDevices'), false)
  assert.equal(JSON.stringify(summary).includes('aGVsbG8'), false)
})

test('sortProvisioningProfiles puts soonest expiration first and undated last', () => {
  const sorted = sortProvisioningProfiles([
    { name: 'later', expirationDate: '2027-01-01T00:00:00.000Z' },
    { name: 'undated' },
    { name: 'sooner', expirationDate: '2026-12-01T00:00:00.000Z' },
  ])
  assert.deepEqual(sorted.map((profile) => profile.name), ['sooner', 'later', 'undated'])
})

/* ------------------------------------------------------------------------- *
 * Signing operations
 * ------------------------------------------------------------------------- */

test('readIdentities reports an empty keychain as a successful result', async () => {
  const runner = fakeRunner({
    'security find-identity -v -p codesigning': { ok: true, stdout: '     0 valid identities found\n' },
  })
  const result = await readIdentities(runner)
  assert.equal(result.ok, true)
  assert.equal(result.count, 0)
  assert.deepEqual(result.identities, [])
})

test('readIdentities turns a failed security command into a readable error', async () => {
  const runner = fakeRunner({ 'security find-identity -v -p codesigning': { ok: false, exitCode: 1, stderr: 'no keychain' } })
  const result = await readIdentities(runner)
  assert.equal(result.ok, false)
  assert.match(result.error, /no keychain/)
})

test('readProvisioningProfiles lists missing directories without failing', async () => {
  const runner = fakeRunner()
  const result = await readProvisioningProfiles(runner, { directories: ['/tmp/definitely-missing-dsh-profiles'] })
  assert.equal(result.ok, true)
  assert.equal(result.count, 0)
  assert.deepEqual(result.profiles, [])
  assert.deepEqual(result.directories, [{ directory: '/tmp/definitely-missing-dsh-profiles', exists: false, files: 0 }])
})

test('readProvisioningProfiles decodes via security cms + plutil and asserts stdin piping', async (t) => {
  const directory = await makeTempDirectory(t)
  await writeFile(join(directory, 'one.mobileprovision'), 'cms')
  const runner = fakeRunner((argv, options) => {
    if (argv[0] === 'security' && argv[1] === 'cms') return { ok: true, stdout: PROFILE_PLIST }
    if (argv[0] === 'plutil') {
      assert.deepEqual(options.stdin, { data: PROFILE_PLIST })
      const payload = parsePlistXml(PROFILE_PLIST)
      return { ok: true, stdout: JSON.stringify(payload) }
    }
    return undefined
  })
  const result = await readProvisioningProfiles(runner, { directories: [directory] })
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(result.profiles[0].name, 'iOS Team Provisioning Profile: com.example.demo')
  assert.equal(result.profiles[0].decodedWith, 'plutil')
  assert.ok(result.directories[0].exists)
})

test('readProvisioningProfiles falls back to the XML parser when plutil rejects <data>', async (t) => {
  const directory = await makeTempDirectory(t)
  await writeFile(join(directory, 'one.mobileprovision'), 'cms')
  const runner = fakeRunner((argv) => {
    if (argv[0] === 'security' && argv[1] === 'cms') return { ok: true, stdout: PROFILE_PLIST }
    if (argv[0] === 'plutil') return { ok: false, exitCode: 1, stderr: '/dev/stdin: Invalid object in plist for JSON format' }
    return undefined
  })
  const result = await readProvisioningProfiles(runner, { directories: [directory] })
  assert.equal(result.ok, true)
  assert.equal(result.profiles[0].uuid, '11111111-2222-3333-4444-555555555555')
  assert.equal(result.profiles[0].decodedWith, 'plist-xml')
  // plutil is only attempted once; the rest of the batch uses the parser.
  assert.equal(runner.calls.filter((call) => call.argv[0] === 'plutil').length, 1)
})

test('readProvisioningProfiles falls back to openssl when security cms fails', async (t) => {
  const directory = await makeTempDirectory(t)
  await writeFile(join(directory, 'one.mobileprovision'), 'cms')
  const runner = fakeRunner((argv) => {
    if (argv[0] === 'security' && argv[1] === 'cms') return { ok: false, exitCode: 1, stderr: 'cert import failed' }
    if (argv[0] === 'openssl') return { ok: true, stdout: PROFILE_PLIST }
    if (argv[0] === 'plutil') return { ok: false, exitCode: 1, stderr: 'Invalid object' }
    return undefined
  })
  const result = await readProvisioningProfiles(runner, { directories: [directory] })
  assert.equal(result.ok, true)
  assert.equal(result.profiles[0].name, 'iOS Team Provisioning Profile: com.example.demo')
  assert.ok(result.warnings.some((warning) => /openssl/.test(warning)))
})

test('readProvisioningProfiles sorts by expiration, dedupes UUIDs and tracks decode errors', async (t) => {
  const directory = await makeTempDirectory(t)
  await writeFile(join(directory, 'later.mobileprovision'), 'cms')
  await writeFile(join(directory, 'sooner.mobileprovision'), 'cms')
  await writeFile(join(directory, 'broken.mobileprovision'), 'cms')
  await writeFile(join(directory, 'ignored.txt'), 'nope')
  const profiles = {
    later: PROFILE_PLIST.replace('2027-10-11T03:37:14Z', '2027-12-01T00:00:00Z').replace('11111111-2222-3333-4444-555555555555', '22222222-2222-3333-4444-555555555555').replace('iOS Team Provisioning Profile: com.example.demo', 'Later'),
    sooner: PROFILE_PLIST.replace('2027-10-11T03:37:14Z', '2026-12-01T00:00:00Z').replace('11111111-2222-3333-4444-555555555555', '33333333-2222-3333-4444-555555555555').replace('iOS Team Provisioning Profile: com.example.demo', 'Sooner'),
    broken: undefined,
  }
  const runner = fakeRunner((argv) => {
    if (argv[0] === 'security' && argv[1] === 'cms') {
      const name = argv[argv.length - 1].split('/').pop().replace('.mobileprovision', '')
      if (profiles[name]) return { ok: true, stdout: profiles[name] }
      return { ok: false, exitCode: 1, stderr: 'corrupt profile' }
    }
    if (argv[0] === 'openssl') return { ok: false, exitCode: 1, stderr: 'corrupt profile' }
    if (argv[0] === 'plutil') return { ok: false, exitCode: 1, stderr: 'Invalid object' }
    return undefined
  })
  const result = await readProvisioningProfiles(runner, { directories: [directory], limit: 5 })
  assert.equal(result.ok, true)
  assert.equal(result.total, 3)
  assert.equal(result.profiles[0].name, 'Sooner')
  assert.equal(result.profiles[1].name, 'Later')
  assert.ok(result.profiles[2].decodeError)
})

test('inspectApp parses codesign details and the designated requirement', async (t) => {
  const directory = await makeTempDirectory(t)
  const app = join(directory, 'App.app')
  await mkdir(app)
  const runner = fakeRunner((argv) => {
    if (argv[0] === 'codesign' && argv[1] === '-dv') return { ok: true, stderr: CODESIGN_DV }
    if (argv[0] === 'codesign' && argv[1] === '-d' && argv[2] === '-r-') {
      return { ok: true, stderr: `Executable=${app}/Contents/MacOS/App\ndesignated => identifier "com.example.demo" and anchor apple\n` }
    }
    return undefined
  })
  const result = await inspectApp(runner, app)
  assert.equal(result.ok, true)
  assert.equal(result.signed, true)
  assert.equal(result.details.identifier, 'com.example.demo')
  assert.equal(result.details.teamIdentifier, 'ABCDE12345')
  assert.equal(result.requirements, 'identifier "com.example.demo" and anchor apple')
})

test('inspectApp reports an unsigned object as ok:true signed:false', async (t) => {
  const directory = await makeTempDirectory(t)
  const app = join(directory, 'App.app')
  await mkdir(app)
  const runner = fakeRunner((argv) => {
    if (argv[0] === 'codesign') return { ok: false, exitCode: 1, stderr: `${app}: code object is not signed at all` }
    return undefined
  })
  const result = await inspectApp(runner, app)
  assert.equal(result.ok, true)
  assert.equal(result.signed, false)
  assert.match(result.note, /not signed/i)
})

test('inspectApp fails for a missing path without throwing', async () => {
  const result = await inspectApp(fakeRunner(), '/tmp/definitely-missing-dsh-app.app')
  assert.equal(result.ok, false)
  assert.match(result.error, /No file or directory/)
})

test('readEntitlements pipes the XML plist through plutil via stdin', async (t) => {
  const directory = await makeTempDirectory(t)
  const app = join(directory, 'App.app')
  await mkdir(app)
  const runner = fakeRunner((argv, options) => {
    if (argv[0] === 'codesign' && argv[1] === '-d' && argv[2] === '--entitlements') return { ok: true, stdout: ENTITLEMENTS_XML }
    if (argv[0] === 'plutil') {
      assert.deepEqual(options.stdin, { data: ENTITLEMENTS_XML })
      return { ok: true, stdout: '{"application-identifier":"TEAMID1234.com.example.demo","get-task-allow":true}' }
    }
    return undefined
  })
  const result = await readEntitlements(runner, app)
  assert.equal(result.ok, true)
  assert.equal(result.available, true)
  assert.equal(result.count, 2)
  assert.equal(result.entitlements['application-identifier'], 'TEAMID1234.com.example.demo')
  assert.equal(result.decodedWith, 'plutil')
})

test('readEntitlements reports unsigned objects and signature without entitlements', async (t) => {
  const directory = await makeTempDirectory(t)
  const app = join(directory, 'App.app')
  await mkdir(app)
  const unsigned = await readEntitlements(fakeRunner({ [`codesign -d --entitlements :- ${app}`]: { ok: false, exitCode: 1, stderr: `${app}: code object is not signed at all` } }), app)
  assert.equal(unsigned.ok, true)
  assert.equal(unsigned.available, false)
  assert.equal(unsigned.signed, false)

  const none = await readEntitlements(fakeRunner({ [`codesign -d --entitlements :- ${app}`]: { ok: true, stdout: '', stderr: 'warning: deprecated' } }), app)
  assert.equal(none.ok, true)
  assert.equal(none.available, false)
  assert.match(none.note, /no entitlements/i)
})

test('verifyApp reports codesign and spctl outcomes independently', async (t) => {
  const directory = await makeTempDirectory(t)
  const app = join(directory, 'App.app')
  await mkdir(app)
  const runner = fakeRunner((argv) => {
    if (argv[0] === 'codesign' && argv[1] === '--verify') return { ok: true }
    if (argv[0] === 'spctl') return { ok: false, exitCode: 3, stderr: `${app}: rejected\nsource=no usable signature\n` }
    return undefined
  })
  const result = await verifyApp(runner, app)
  assert.equal(result.ok, true)
  assert.equal(result.verified, true)
  assert.equal(result.signature.ok, true)
  assert.equal(result.spctl.accepted, false)
  assert.equal(result.spctl.decision, 'rejected')
  assert.equal(result.spctl.source, 'no usable signature')
})

test('verifyApp surfaces a signature failure as ok:false with output', async (t) => {
  const directory = await makeTempDirectory(t)
  const app = join(directory, 'App.app')
  await mkdir(app)
  const runner = fakeRunner((argv) => {
    if (argv[0] === 'codesign' && argv[1] === '--verify') return { ok: false, exitCode: 1, stderr: `${app}: code object is not signed at all` }
    if (argv[0] === 'spctl') return { ok: false, exitCode: 3, stderr: `${app}: rejected\nsource=no usable signature\n` }
    return undefined
  })
  const result = await verifyApp(runner, app)
  assert.equal(result.ok, false)
  assert.equal(result.verified, false)
  assert.match(result.error, /not signed/)
})

/* ------------------------------------------------------------------------- *
 * Logs parsers
 * ------------------------------------------------------------------------- */

test('parseLogWindow accepts typical windows and rejects invalid ones', () => {
  assert.deepEqual(parseLogWindow(undefined), { text: '5m', seconds: 300 })
  assert.deepEqual(parseLogWindow('30s'), { text: '30s', seconds: 30 })
  assert.deepEqual(parseLogWindow(' 2H '), { text: '2h', seconds: 7200 })
  assert.deepEqual(parseLogWindow('1d'), { text: '1d', seconds: 86400 })
  assert.throws(() => parseLogWindow('yesterday'), /last/)
  assert.throws(() => parseLogWindow('5 minutes'), /last/)
  assert.throws(() => parseLogWindow('0s'), /positive/)
  assert.throws(() => parseLogWindow('48h'), /capped/)
})

test('buildLogPredicate quotes and escapes filter values', () => {
  assert.equal(buildLogPredicate({}), undefined)
  assert.equal(buildLogPredicate({ process: 'Demo' }), 'process == "Demo"')
  assert.equal(
    buildLogPredicate({ process: 'My "App"', message_contains: 'back\\slash' }),
    'process == "My \\"App\\"" AND eventMessage CONTAINS[c] "back\\\\slash"',
  )
  assert.equal(
    buildLogPredicate({ subsystem: 'com.example.app', category: 'network', message_contains: 'timeout' }),
    'subsystem == "com.example.app" AND category == "network" AND eventMessage CONTAINS[c] "timeout"',
  )
  assert.equal(quoteLogPredicate('a"b\\c'), '"a\\"b\\\\c"')
  assert.throws(() => buildLogPredicate({ process: 'line\nbreak' }), /control characters/)
  assert.throws(() => buildLogPredicate({ process: 42 }), /must be a string/)
  assert.throws(() => buildLogPredicate({ process: 'x'.repeat(501) }), /longer than/)
})

test('buildLogShowArgv keeps every value in its own argv slot', () => {
  assert.deepEqual(buildLogShowArgv({ udid: 'UDID-1', window: '5m' }), [
    'xcrun', 'simctl', 'spawn', 'UDID-1', 'log', 'show', '--style', 'compact', '--last', '5m',
  ])
  assert.deepEqual(buildLogShowArgv({ udid: 'UDID-1', window: '30s', predicate: 'process == "Demo"' }), [
    'xcrun', 'simctl', 'spawn', 'UDID-1', 'log', 'show', '--style', 'compact', '--last', '30s', '--predicate', 'process == "Demo"',
  ])
  const injected = buildLogShowArgv({ udid: 'A; rm -rf /', window: '5m' })
  assert.equal(injected[3], 'A; rm -rf /')
  assert.equal(injected.length, 10)
  assert.throws(() => buildLogShowArgv({ udid: '  ' }), /UDID/)
})

test('crashReportDirectories builds the simulator and host report paths', () => {
  const directories = crashReportDirectories('UDID-1', { home: '/Users/example' })
  assert.deepEqual(directories, [
    '/Users/example/Library/Developer/CoreSimulator/Devices/UDID-1/data/Library/Logs/DiagnosticReports',
    '/Users/example/Library/Logs/DiagnosticReports',
  ])
  assert.deepEqual(crashReportDirectories(undefined, { home: '/Users/example' }), ['/Users/example/Library/Logs/DiagnosticReports'])
  assert.deepEqual(crashReportDirectories('UDID-1', { home: '/Users/example', includeHost: false }), [
    '/Users/example/Library/Developer/CoreSimulator/Devices/UDID-1/data/Library/Logs/DiagnosticReports',
  ])
})

test('isCrashReportName accepts .ips/.crash only', () => {
  assert.equal(isCrashReportName('Demo-2026-11-10.ips'), true)
  assert.equal(isCrashReportName('Demo.crash'), true)
  assert.equal(isCrashReportName('Demo.diag'), false)
  assert.equal(isCrashReportName(undefined), false)
})

test('parseCrashReportMetadata reads .ips JSON headers and legacy .crash headers', () => {
  const ips = parseCrashReportMetadata(CRASH_IPS)
  assert.equal(ips.format, 'ips')
  assert.equal(ips.appName, 'Demo')
  assert.equal(ips.version, '1.2.3')
  assert.equal(ips.bundleId, 'com.example.demo')
  assert.equal(ips.bugType, '309')
  assert.equal(ips.incidentId, 'ABC-123')

  const legacy = parseCrashReportMetadata(LEGACY_CRASH)
  assert.equal(legacy.format, 'crash')
  assert.equal(legacy.appName, 'Demo')
  assert.equal(legacy.version, '1.2.3 (42)')
  assert.equal(legacy.exceptionType, 'EXC_BAD_ACCESS (SIGSEGV)')
})

test('sortCrashReports is newest first with undated entries last', () => {
  const sorted = sortCrashReports([
    { name: 'old', modifiedAt: 1000 },
    { name: 'undated' },
    { name: 'new', modifiedAt: 5000 },
  ])
  assert.deepEqual(sorted.map((report) => report.name), ['new', 'old', 'undated'])
})

test('listCrashReports filters extensions, orders by mtime and honours limit', async (t) => {
  const directory = await makeTempDirectory(t)
  await writeFile(join(directory, 'Old-2026-01-01.ips'), CRASH_IPS)
  await writeFile(join(directory, 'New-2026-11-10.ips'), CRASH_IPS)
  await writeFile(join(directory, 'Ignore.diag'), 'not a crash')
  await utimes(join(directory, 'Old-2026-01-01.ips'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
  await utimes(join(directory, 'New-2026-11-10.ips'), new Date('2026-11-10T00:00:00Z'), new Date('2026-11-10T00:00:00Z'))

  const listed = await listCrashReports([directory, '/tmp/definitely-missing-dsh-crashes'], { limit: 1 })
  assert.equal(listed.total, 2)
  assert.equal(listed.reports.length, 1)
  assert.equal(listed.reports[0].name, 'New-2026-11-10.ips')
  assert.equal(listed.truncated, true)
  assert.deepEqual(listed.scanned.map((entry) => entry.exists), [true, false])

  const read = await readCrashReport(listed.reports[0].path)
  assert.equal(read.ok, true)
  assert.equal(read.metadata.appName, 'Demo')

  const missing = await readCrashReport('/tmp/definitely-missing-dsh-report.ips')
  assert.equal(missing.ok, false)
  assert.match(missing.error, /Could not read/)
})

/* ------------------------------------------------------------------------- *
 * Tool execution through the fake runner
 * ------------------------------------------------------------------------- */

test('apple_dev_signing identities executes through the runner and returns ok for an empty keychain', async () => {
  const tools = createDiagTools(fakeContext(), {}, fakeRunner({
    'security find-identity -v -p codesigning': { ok: true, stdout: '     0 valid identities found\n' },
  }))
  const signing = tools.find((tool) => tool.name === 'apple_dev_signing')
  const result = await signing.execute({ action: 'identities' }, {})
  assert.equal(result.ok, true)
  assert.equal(result.action, 'identities')
  assert.equal(result.count, 0)
  assert.deepEqual(result.identities, [])
})

test('apple_dev_signing profiles honours a path override directory', async (t) => {
  const directory = await makeTempDirectory(t)
  await writeFile(join(directory, 'one.mobileprovision'), 'cms')
  const runner = fakeRunner((argv) => {
    if (argv[0] === 'security' && argv[1] === 'cms') return { ok: true, stdout: PROFILE_PLIST }
    if (argv[0] === 'plutil') return { ok: true, stdout: JSON.stringify(parsePlistXml(PROFILE_PLIST)) }
    return undefined
  })
  const tools = createDiagTools(fakeContext(), {}, runner)
  const signing = tools.find((tool) => tool.name === 'apple_dev_signing')
  const result = await signing.execute({ action: 'profiles', path: directory }, {})
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(result.profiles[0].uuid, '11111111-2222-3333-4444-555555555555')
})

test('apple_dev_signing inspect/entitlements/verify resolve the path against the session directory', async (t) => {
  const directory = await makeTempDirectory(t)
  const app = join(directory, 'App.app')
  await mkdir(app)
  const runner = fakeRunner((argv) => {
    if (argv[0] === 'codesign' && argv[1] === '-dv') return { ok: true, stderr: CODESIGN_DV }
    if (argv[0] === 'codesign' && argv[1] === '-d' && argv[2] === '-r-') return { ok: true, stderr: 'designated => identifier "com.example.demo" and anchor apple\n' }
    if (argv[0] === 'codesign' && argv[2] === '--entitlements') return { ok: true, stdout: ENTITLEMENTS_XML }
    if (argv[0] === 'plutil') return { ok: true, stdout: '{"application-identifier":"TEAMID1234.com.example.demo"}' }
    if (argv[0] === 'codesign' && argv[1] === '--verify') return { ok: true }
    if (argv[0] === 'spctl') return { ok: true, stderr: `${app}: accepted\nsource=Apple System\n` }
    return undefined
  })
  const tools = createDiagTools(fakeContext(directory), {}, runner)
  const signing = tools.find((tool) => tool.name === 'apple_dev_signing')

  const inspected = await signing.execute({ action: 'inspect', path: 'App.app' }, {})
  assert.equal(inspected.ok, true)
  assert.equal(inspected.details.identifier, 'com.example.demo')

  const entitlements = await signing.execute({ action: 'entitlements', path: 'App.app' }, {})
  assert.equal(entitlements.ok, true)
  assert.equal(entitlements.available, true)

  const verified = await signing.execute({ action: 'verify', path: 'App.app' }, {})
  assert.equal(verified.ok, true)
  assert.equal(verified.verified, true)
  assert.equal(verified.spctl.accepted, true)
})

test('apple_dev_logs show resolves a booted device, applies the predicate and tails lines', async () => {
  const lines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`)
  const runner = fakeRunner((argv) => {
    if (argv.join(' ') === 'xcrun simctl list devices --json') return { ok: true, stdout: DEVICES_JSON }
    if (argv[0] === 'xcrun' && argv[1] === 'simctl' && argv[2] === 'spawn') return { ok: true, stdout: lines.join('\n') }
    return undefined
  })
  const tools = createDiagTools(fakeContext(), {}, runner)
  const logs = tools.find((tool) => tool.name === 'apple_dev_logs')
  const result = await logs.execute({ action: 'show', last: '30s', process: 'Demo', limit: 3 }, {})

  assert.equal(result.ok, true)
  assert.equal(result.window, '30s')
  assert.equal(result.predicate, 'process == "Demo"')
  assert.equal(result.device.udid, 'AAAAAAAA-0000-0000-0000-000000000001')
  assert.equal(result.totalLines, 10)
  assert.match(result.output, /line-8/)
  assert.match(result.output, /line-10/)
  assert.doesNotMatch(result.output, /line-7/)

  const spawnCall = runner.calls.find((call) => call.argv[0] === 'xcrun' && call.argv[2] === 'spawn')
  assert.deepEqual(spawnCall.argv.slice(-2), ['--predicate', 'process == "Demo"'])
})

test('apple_dev_logs show validates last and keeps filter escaping in argv', async () => {
  const tools = createDiagTools(fakeContext(), {}, fakeRunner())
  const logs = tools.find((tool) => tool.name === 'apple_dev_logs')
  await assert.rejects(() => logs.execute({ action: 'show', last: 'whenever' }, {}), /last/)
  await assert.rejects(() => logs.execute({ action: 'show', process: 'bad\nvalue' }, {}), /control characters/)
})

test('apple_dev_logs show reports device resolution failures with candidates', async () => {
  const runner = fakeRunner({ 'xcrun simctl list devices --json': { ok: true, stdout: DEVICES_JSON } })
  const tools = createDiagTools(fakeContext(), {}, runner)
  const logs = tools.find((tool) => tool.name === 'apple_dev_logs')
  const result = await logs.execute({ action: 'show', device: 'No Such Phone' }, {})
  assert.equal(result.ok, false)
  assert.match(result.error, /No simulator matches/)
  assert.ok(result.candidates.length >= 1)
  assert.equal(result.candidates[0].name, 'iPhone 17')
})

test('apple_dev_logs crashes lists reports from a path override and reads the newest', async (t) => {
  const directory = await makeTempDirectory(t)
  await writeFile(join(directory, 'New-2026-11-10.ips'), CRASH_IPS)
  await utimes(join(directory, 'New-2026-11-10.ips'), new Date('2026-11-10T00:00:00Z'), new Date('2026-11-10T00:00:00Z'))

  const tools = createDiagTools(fakeContext(), {}, fakeRunner())
  const logs = tools.find((tool) => tool.name === 'apple_dev_logs')
  const result = await logs.execute({ action: 'crashes', path: directory }, {})
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(result.total, 1)
  assert.equal(result.reports[0].name, 'New-2026-11-10.ips')
  assert.ok(result.reports[0].path.startsWith(directory))
  assert.equal(result.newest.metadata.appName, 'Demo')
  assert.equal(result.newest.content, undefined, 'content is omitted by default')
  assert.equal(result.newest.summary.app, 'Demo')
  assert.equal(result.newest.summary.exception.type, 'EXC_BAD_ACCESS')

  const withContent = await logs.execute({ action: 'crashes', path: directory, include_content: true }, {})
  assert.match(withContent.newest.content, /app_name/)
})

test('apple_dev_logs crashes falls back to host reports when no simulator is booted', async () => {
  const shutdownOnly = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [
        { udid: 'CCCCCCCC-0000-0000-0000-000000000003', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
      ],
    },
  })
  const runner = fakeRunner({ 'xcrun simctl list devices --json': { ok: true, stdout: shutdownOnly } })
  const tools = createDiagTools(fakeContext(), {}, runner)
  const logs = tools.find((tool) => tool.name === 'apple_dev_logs')
  const result = await logs.execute({ action: 'crashes' }, {})
  assert.equal(result.ok, true)
  assert.equal(result.device, undefined)
  assert.ok(result.warnings.some((warning) => /host crash reports only/.test(warning)))
})

/* ------------------------------------------------------------------------- *
 * Real macOS smoke checks (skipped elsewhere and when tools are unavailable)
 * ------------------------------------------------------------------------- */

function realRunner(argv, options = {}) {
  const startedAt = Date.now()
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    cwd: options.cwd,
    input: options.stdin && typeof options.stdin === 'object' ? options.stdin.data : undefined,
    timeout: options.timeoutMs ?? 30000,
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  return {
    ok: result.status === 0 && !result.error,
    command: argv.join(' '),
    argv,
    cwd: options.cwd ?? process.cwd(),
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal ?? null,
    timedOut: false,
    cancelled: false,
    spawnError: result.error ? String(result.error.message) : undefined,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    truncated: false,
    durationMs: Date.now() - startedAt,
  }
}

test('smoke: real security find-identity works and parses', { skip: process.platform !== 'darwin' }, async () => {
  const result = await readIdentities(realRunner)
  assert.equal(result.ok, true)
  assert.ok(Number.isInteger(result.count))
  assert.ok(Array.isArray(result.identities))
})

test('smoke: real simctl list devices parses', { skip: process.platform !== 'darwin' }, () => {
  const result = spawnSync('xcrun', ['simctl', 'list', 'devices', '--json'], { encoding: 'utf8', timeout: 60000 })
  if (result.error) return
  assert.equal(result.status, 0)
  const devices = parseSimulatorList(result.stdout)
  assert.ok(Array.isArray(devices))
})

test('smoke: real provisioning profiles decode when the machine has any', { skip: process.platform !== 'darwin' }, async (t) => {
  let withProfiles
  for (const directory of profileDirectories()) {
    let names = []
    try {
      names = await readdir(directory)
    } catch {
      continue
    }
    if (names.some((name) => /\.mobileprovision$/i.test(name))) {
      withProfiles = directory
      break
    }
  }
  if (!withProfiles) {
    t.skip('no provisioning profiles are installed on this machine')
    return
  }
  const result = await readProvisioningProfiles(realRunner, { directories: [withProfiles], limit: 3 })
  assert.equal(result.ok, true)
  assert.ok(result.profiles.length > 0)
  if (result.profiles.some((profile) => profile.name)) {
    const decoded = result.profiles.find((profile) => profile.name)
    assert.equal(typeof decoded.uuid, 'string')
    assert.equal(typeof decoded.applicationIdentifier, 'string')
  } else {
    t.diagnostic('profiles were found but could not be decoded in this environment (sandboxed keychain)')
  }
})
