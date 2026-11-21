/**
 * Crash-report tests: .ips parsing, frame address computation, dSYM discovery,
 * atos planning, and the `apple_dev_logs` symbolicate action end to end.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  collectDsymBinaries,
  collectThreads,
  crashFacts,
  formatSymbolicatedReport,
  hexAddress,
  parseIps,
  symbolicateReport,
} from '../lib/crash.js'
import { createDiagTools } from '../lib/tools-diag.js'

const HEADER = {
  app_name: 'Demo',
  app_version: '1.2',
  build_version: '42',
  os_version: 'iOS 27.2',
  platform: 'iOS',
  bug_type: '309',
  timestamp: '2026-11-21 10:00:00.00 +0800',
}

const PAYLOAD = {
  procName: 'Demo',
  pid: 1234,
  faultingThread: 0,
  exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', codes: '0x0000000000000001' },
  termination: { indicator: 'Segmentation fault: 11', namespace: 'SIGNAL', code: 11 },
  threads: [
    {
      triggered: true,
      frames: [
        { imageIndex: 0, imageOffset: 4096, symbol: 'DemoApp.body.getter', symbolLocation: 12, sourceFile: 'DemoApp.swift', sourceLine: 42 },
        { imageIndex: 0, imageOffset: 8192 },
        { imageIndex: 1, imageOffset: 16, symbol: 'start' },
      ],
    },
    { frames: [{ imageIndex: 1, imageOffset: 32 }] },
  ],
  usedImages: [
    { name: 'Demo', path: '/x/Demo.app/Demo', base: 4294967296, arch: 'arm64' },
    { name: 'libsystem', path: '/usr/lib/libsystem.dylib', base: 4295000000, arch: 'arm64' },
  ],
}

const IPS = `${JSON.stringify(HEADER)}\n${JSON.stringify(PAYLOAD)}`

const ATOS_LINE = 'DemoApp.crashTrampoline + 24 (DemoApp.swift:88)'

async function makeDsym(root) {
  const dwarf = join(root, 'Demo.app.dSYM', 'Contents', 'Resources', 'DWARF')
  await mkdir(dwarf, { recursive: true })
  await writeFile(join(dwarf, 'Demo'), 'dwarf-bytes')
  return join(root, 'Demo.app.dSYM')
}

test('parseIps accepts the header+payload form and a single JSON document', () => {
  const parsed = parseIps(IPS)
  assert.equal(parsed.header.app_name, 'Demo')
  assert.equal(parsed.payload.procName, 'Demo')
  const single = parseIps(JSON.stringify(PAYLOAD))
  assert.equal(single.payload.pid, 1234)
  assert.throws(() => parseIps('not a report'), /not an \.ips document/)
})

test('crashFacts and collectThreads compute image addresses', () => {
  const report = parseIps(IPS)
  const facts = crashFacts(report)
  assert.equal(facts.app, 'Demo')
  assert.equal(facts.exception.type, 'EXC_BAD_ACCESS')
  assert.equal(facts.termination.indicator, 'Segmentation fault: 11')
  assert.equal(facts.threadCount, 2)

  const collected = collectThreads(report)
  assert.equal(collected.threads[0].triggered, true)
  assert.equal(collected.threads[1].triggered, false)
  const second = collected.threads[0].frames[1]
  assert.equal(second.imageName, 'Demo')
  assert.equal(second.base, 4294967296)
  assert.equal(second.offset, 8192)
  assert.equal(second.address, 4294967296 + 8192)
  assert.equal(hexAddress(second.address), '0x100002000')
})

test('collectDsymBinaries maps a bundle, its folder and an .app path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-dsym-'))
  try {
    const bundle = await makeDsym(root)
    const fromBundle = await collectDsymBinaries(bundle)
    assert.ok(fromBundle.get('demo'))
    const fromFolder = await collectDsymBinaries(root)
    assert.ok(fromFolder.get('demo'))
    await mkdir(join(root, 'Demo.app'), { recursive: true })
    const fromApp = await collectDsymBinaries(join(root, 'Demo.app'))
    assert.ok(fromApp.get('demo'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('symbolicateReport resolves only frames missing a symbol and notes missing images', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-sym-'))
  try {
    const bundle = await makeDsym(root)
    const calls = []
    const runner = async (argv) => {
      calls.push(argv)
      return { ok: true, argv, command: argv.join(' '), exitCode: 0, stdout: `${ATOS_LINE}\n`, stderr: '' }
    }
    const result = await symbolicateReport({ text: IPS, dsym: bundle, runner })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 1, 'one atos call per image with unsymbolized frames')
    const argv = calls[0]
    assert.deepEqual(argv.slice(0, 3), ['xcrun', 'atos', '-arch'])
    assert.ok(argv.includes('-l'))
    assert.ok(argv.includes('0x100000000'))
    assert.ok(argv.includes('0x100002000'))

    const frames = result.threads[0].frames
    assert.equal(frames[0].symbol, 'DemoApp.body.getter', 'existing symbols are kept')
    assert.equal(frames[1].resolved, ATOS_LINE)
    assert.equal(frames[2].symbol, 'start')
    assert.deepEqual(result.missingImages, [], 'the crashed thread is fully symbolized')

    // The second thread's libsystem frame has no symbol and no dSYM.
    const all = await symbolicateReport({ text: IPS, dsym: bundle, runner, allThreads: true })
    assert.equal(all.threads.length, 2)
    assert.ok(all.missingImages.includes('libsystem'), 'unmatched images are reported')

    const rendered = formatSymbolicatedReport(all)
    assert.match(rendered, /Demo 1\.2 on iOS 27\.2/)
    assert.match(rendered, /EXC_BAD_ACCESS \/ SIGSEGV/)
    assert.match(rendered, /DemoApp\.crashTrampoline/)
    assert.match(rendered, /No dSYM matched: libsystem/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('apple_dev_logs symbolicate reads the report and returns symbolized frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apple-dev-tool-'))
  try {
    const bundle = await makeDsym(root)
    const report = join(root, 'Demo.ips')
    await writeFile(report, IPS, 'utf8')
    const runner = async (argv) => ({ ok: true, argv, command: argv.join(' '), exitCode: 0, stdout: `${ATOS_LINE}\n`, stderr: '' })
    const tools = createDiagTools({ get: () => undefined }, {}, runner)
    const logs = tools.find((tool) => tool.name === 'apple_dev_logs')
    const result = await logs.execute({ action: 'symbolicate', report, dsym: bundle }, {})
    assert.equal(result.ok, true)
    assert.equal(result.threads[0].frames[1].resolved, ATOS_LINE)
    const rendered = logs.output.render({}, result)
    assert.match(rendered[0].text, /apple_dev_logs · symbolicate/)

    const missing = await logs.execute({ action: 'symbolicate' }, {})
    assert.equal(missing.ok, false)
    assert.match(missing.error, /report` is required/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
