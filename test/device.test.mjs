/**
 * Physical-device tests: devicectl JSON normalization (both the modern
 * `properties` shape and the deprecated fields), device selection, argv
 * builders, and the tool's guard rails.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDeviceAppsArgv,
  buildDeviceInstallArgv,
  buildDeviceLaunchArgv,
  buildDeviceListArgv,
  buildDeviceScreenshotArgv,
  buildDeviceTerminateArgv,
  filterApps,
  parseApps,
  parseDeviceList,
  parseProcesses,
  selectDevice,
} from '../lib/device.js'
import { createDeviceTools, formatDeviceReport, formatDeviceRow } from '../lib/tools-device.js'

const LIST = {
  info: { outcome: 'success', commandType: 'devicectl.list.devices' },
  result: {
    devices: [
      {
        identifier: 'AB5AF25B-896C-5535-BC37-AC7608EFBB7E',
        properties: {
          hardware: {
            udid: '00008140-001E38DA0EF3001C',
            marketingName: 'iPhone 16 Pro Max',
            productType: 'iPhone17,2',
            platform: 'iOS',
            reality: 'physical',
          },
          state: { name: 'Henry’s iPhone', bootState: 'booted', developerModeStatus: { enabled: { mode: 1 } } },
          connection: { state: 'connected', pairingState: 'paired' },
          software: { osVersionNumber: { stringValue: '27.2.1' }, osBuildVersions: { buildVersion: { name: '24B156' } } },
        },
      },
      {
        identifier: 'SIM-1',
        hardwareProperties: { udid: 'AAAA', marketingName: 'iPhone 17', platform: 'iOS', reality: 'simulated' },
        deviceProperties: { name: 'iPhone 17', osVersionNumber: '27.2', bootState: 'shutdown' },
        connectionProperties: { tunnelState: 'connected' },
      },
    ],
  },
}

const APPS = {
  result: {
    apps: [
      { bundleIdentifier: 'dev.dsh.demo', name: 'Demo', version: '1.2', bundleVersion: '42', url: 'file:///x/Demo.app/' },
      { bundleIdentifier: 'com.apple.mobilesafari', name: 'Safari', version: '27', bundleVersion: '1', removable: false },
    ],
  },
}

const PROCESSES = {
  result: {
    runningProcesses: [
      { executable: 'file:///private/var/containers/Bundle/Application/x/Demo.app/Demo', processIdentifier: 4242 },
      { executable: 'file:///usr/libexec/backboardd', processIdentifier: 88 },
    ],
  },
}

test('parseDeviceList reads modern properties and legacy fallbacks', () => {
  const devices = parseDeviceList(LIST)
  assert.equal(devices.length, 2)
  const phone = devices[0]
  assert.equal(phone.name, 'Henry’s iPhone')
  assert.equal(phone.udid, '00008140-001E38DA0EF3001C')
  assert.equal(phone.model, 'iPhone 16 Pro Max')
  assert.equal(phone.osVersion, '27.2.1')
  assert.equal(phone.osBuild, '24B156')
  assert.equal(phone.connection, 'connected')
  assert.equal(phone.reality, 'physical')
  assert.equal(phone.developerMode, 'enabled')

  const simulator = devices[1]
  assert.equal(simulator.name, 'iPhone 17')
  assert.equal(simulator.osVersion, '27.2')
  assert.equal(simulator.reality, 'simulated')
  assert.equal(simulator.bootState, 'shutdown')
  assert.equal(simulator.connection, 'connected')
})

test('selectDevice prefers the connected physical device and resolves UDID/name', () => {
  const devices = parseDeviceList(LIST)
  assert.equal(selectDevice(devices, '').device.udid, '00008140-001E38DA0EF3001C')
  assert.equal(selectDevice(devices, '00008140-001e38da0ef3001c').device.name, 'Henry’s iPhone')
  assert.equal(selectDevice(devices, 'iPhone 17').device.identifier, 'SIM-1')
  assert.match(formatDeviceRow(devices[0]), /paired · tunnel connected/, 'pairing and tunnel state are distinct')
  assert.match(formatDeviceRow(devices[1]), /tunnel connected|paired/, 'simulated entries keep their state')
  const missing = selectDevice(devices, 'iPad')
  assert.ok(missing.error)
  assert.equal(missing.candidates.length, 2)
})

test('parseApps/parseProcesses/filterApps normalize devicectl rows', () => {
  const apps = parseApps(APPS)
  assert.equal(apps.length, 2)
  assert.equal(apps[0].bundleId, 'dev.dsh.demo')
  assert.equal(apps[0].build, '42')
  assert.equal(filterApps(apps, 'safari').length, 1)

  const processes = parseProcesses(PROCESSES)
  assert.equal(processes[0].pid, 4242)
  assert.equal(processes[0].executable, '/private/var/containers/Bundle/Application/x/Demo.app/Demo')
})

test('devicectl argv builders keep every value as one argument', () => {
  assert.deepEqual(buildDeviceListArgv(), ['xcrun', 'devicectl', 'list', 'devices', '--json-output', '-', '--quiet'])
  assert.deepEqual(
    buildDeviceLaunchArgv('SEL', 'dev.dsh.demo', { args: ['-a', 'b c'], terminateExisting: true }),
    ['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', 'SEL', '--terminate-existing', 'dev.dsh.demo', '-a', 'b c', '--json-output', '-', '--quiet'],
  )
  assert.deepEqual(
    buildDeviceTerminateArgv('SEL', 42, { kill: true }),
    ['xcrun', 'devicectl', 'device', 'process', 'terminate', '--device', 'SEL', '--pid', '42', '--kill', '--json-output', '-', '--quiet'],
  )
  assert.deepEqual(
    buildDeviceInstallArgv('SEL', '/tmp/Demo.app'),
    ['xcrun', 'devicectl', 'device', 'install', 'app', '--device', 'SEL', '/tmp/Demo.app', '--json-output', '-', '--quiet'],
  )
  assert.deepEqual(
    buildDeviceAppsArgv('SEL'),
    ['xcrun', 'devicectl', 'device', 'info', 'apps', '--device', 'SEL', '--include-all-apps', '--json-output', '-', '--quiet'],
  )
  assert.deepEqual(
    buildDeviceScreenshotArgv('SEL', '/tmp/a.png'),
    ['xcrun', 'devicectl', 'device', 'capture', 'screenshot', '--device', 'SEL', '--destination', '/tmp/a.png'],
  )
})

test('device tool lists physical devices and guards required arguments', async () => {
  const calls = []
  const runner = async (argv) => {
    calls.push(argv)
    return { ok: true, argv, command: argv.join(' '), exitCode: 0, stdout: JSON.stringify(LIST), stderr: '' }
  }
  const tool = createDeviceTools({ get: () => undefined }, {}, runner)[0]
  const listed = await tool.execute({ action: 'list' }, {})
  assert.equal(listed.ok, true)
  assert.equal(listed.devices.length, 1, 'list hides simulated devices')
  assert.equal(listed.devices[0].name, 'Henry’s iPhone')
  assert.match(formatDeviceReport(listed), /iPhone 16 Pro Max/)

  const noPid = await tool.execute({ action: 'terminate' }, {})
  assert.equal(noPid.ok, false)
  assert.match(noPid.error, /pid is required/)

  const noApp = await tool.execute({ action: 'install' }, {})
  assert.equal(noApp.ok, false)
  assert.match(noApp.error, /app_path is required/)
})
