/**
 * Client-module tests without a DOM: load the real `client.js` source through a
 * fake module loader, capture the locale dictionaries and slot registrations,
 * and check the text contract the settings page renders.
 *
 * The render layer is React and is exercised in the GUI; here the guard is that
 * the module loads, registers both languages, keeps their keys in sync, and
 * every literal `t('...')` key exists in both dictionaries.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

function loadClient() {
  let definition
  const fakeWindow = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  // The bundle is a plain script whose only side effect is registering a factory.
  new Function('window', source)(fakeWindow)
  assert.ok(definition, 'client.js must call window.__ModuleLoader__.load')
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol.for('react.fragment'),
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: undefined }),
    useCallback: (fn) => fn,
  }
  return definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
}

const module_ = loadClient()

test('client registers its dictionaries for both languages', () => {
  const dictionaries = new Map()
  const slots = []
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    locale: {
      register(namespace, language, dictionary) {
        assert.equal(namespace, 'biucing-apple-dev')
        dictionaries.set(language, dictionary)
        return () => {}
      },
      bind: () => (key) => key,
    },
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(definition, component) {
        slots.push({ definition, component })
        return () => {}
      },
    },
  }
  module_.apply(ctx)

  assert.deepEqual([...dictionaries.keys()].sort(), ['en', 'zh'])
  const en = dictionaries.get('en')
  const zh = dictionaries.get('zh')
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'en and zh must define the same keys')
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string', `${key} must be text`)
    assert.ok(value.length > 0, `${key} must not be empty`)
    assert.ok(zh[key].length > 0, `${key} must have a Chinese translation`)
  }

  const slotNames = slots.map((entry) => entry.definition.name)
  assert.ok(slotNames.includes('settings.section'))
  assert.ok(slotNames.includes('settings.section.icon'))
  for (const entry of slots) assert.equal(typeof entry.component, 'function')
  const section = slots.find((entry) => entry.definition.name === 'settings.section')
  assert.equal(section.definition.id, 'biucing-apple-dev')
  assert.equal(section.definition.locale, 'biucing-apple-dev', 'the page carries the locale namespace')
})

test('every literal translation key used by the page exists in both dictionaries', async () => {
  const dictionaries = new Map()
  module_.apply({
    effect(fn) {
      fn()
      return () => {}
    },
    locale: {
      register(_namespace, language, dictionary) {
        dictionaries.set(language, dictionary)
        return () => {}
      },
      bind: () => (key) => key,
    },
    slots: { inject(_name, callback) { callback() }, register() { return () => {} } },
  })
  const used = new Set([...source.matchAll(/\bt\('([\w.]+)'\)/g)].map((match) => match[1]))
  assert.ok(used.size > 20, 'the page uses translation keys')
  for (const [language, dictionary] of dictionaries) {
    for (const key of used) {
      assert.ok(dictionary[key] !== undefined, `${language} is missing ${key}`)
    }
    for (const suffix of ['ready', 'connecting', 'unavailable', 'disabled', 'unknown']) {
      assert.ok(dictionary['mcp.state.' + suffix], `${language} is missing mcp.state.${suffix}`)
    }
    for (const hint of ['readyHint', 'connectingHint', 'unavailableHint', 'disabledHint']) {
      assert.ok(dictionary['mcp.' + hint], `${language} is missing mcp.${hint}`)
    }
  }
})

test('the MCP card is wired into the ready page state', () => {
  assert.match(source, /function McpCard\(props\)/)
  assert.match(source, /snapshot\.xcodeMcp \? h\(McpCard, \{ mcp: snapshot\.xcodeMcp, t: t \}\) : null/)
})
