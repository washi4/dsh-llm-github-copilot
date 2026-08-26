import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const root = new URL('..', import.meta.url)
const read = name => readFile(new URL(`src/client/${name}`, root), 'utf8')

async function loadSettingsComponent(status, active = 'en') {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let definition
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(value) { definition = value } } }
  })
  vm.runInContext(source, context)

  let component
  let stateCall = 0
  const fakeReact = {
    Fragment: Symbol('Fragment'),
    useEffect() {},
    useState(initial) {
      const value = stateCall++ === 0 ? status : initial
      return [value, () => {}]
    },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() }
  }
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
  const locale = {
    register() {},
    getSnapshot: () => ({ active, revision: 0 }),
    subscribe() { return () => {} }
  }
  const slots = {
    inject(name, callback) {
      if (name === 'settings.section') callback()
    },
    register(meta, value) {
      if (meta.id === 'github-copilot') component = value
      return {}
    }
  }
  definition.factory((name) => {
    if (name === 'react') return fakeReact
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        Button: 'Button',
        Input: 'Input',
        Modal: 'Modal',
        RiskConfirmation: 'RiskConfirmation',
        StateDot: 'StateDot',
        writeClipboard: async () => true
      }
    }
    throw new Error(`unexpected client dependency: ${name}`)
  }).apply({
    locale,
    effect() {},
    on() {},
    slots,
    commandUi: { decorate() {} },
    sessions: {},
    remote: {}
  })

  const renderText = (node) => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(renderText).join('')
    if (typeof node.type === 'function') return renderText(node.type(node.props))
    return renderText(node.props?.children)
  }
  stateCall = 0
  return renderText(component({}))
}

test('settings page renders all Credits states and refreshes through the status seam', async () => {
  const [components, page] = await Promise.all([
    read('05-common-components.js'),
    read('07-settings-page.js')
  ])
  assert.match(components, /function CreditsCard\(\{ credits \}\)/)
  assert.match(components, /state === "unlimited"/)
  assert.match(components, /text\("creditsUnavailable"\)/)
  assert.match(components, /role: "progressbar"/)
  assert.match(page, /status\.credits/)
  assert.match(page, /request\("\/status\?refresh=1"\)/)
})

test('rendered settings output distinguishes available, unlimited, and unavailable Credits', async () => {
  const base = { authenticated: true, state: 'authenticated', models: [], modelCount: 0 }
  const available = await loadSettingsComponent({
    ...base,
    credits: { state: 'available', usedPercent: 76, remaining: 24, entitlement: 100 }
  })
  assert.match(available, /Credits.*76% used/)
  assert.match(available, /Remaining: 24/)

  const unlimited = await loadSettingsComponent({
    ...base,
    credits: { state: 'unlimited' }
  })
  assert.match(unlimited, /Credits.*Unlimited/)

  const unavailable = await loadSettingsComponent({
    ...base,
    credits: { state: 'unavailable' }
  })
  assert.match(unavailable, /Credits.*Credit usage is unavailable/)
})

test('Credits reset dates use the active Harness locale with an English fallback', async () => {
  const source = await read('05-common-components.js')
  assert.match(source, /function formatCreditsResetDate\(value\)/)
  assert.match(source, /"zh-CN"/)
  assert.match(source, /"en-US"/)
  assert.match(source, /Intl\.DateTimeFormat/)
})

test('rendered Credits reset date changes with the active locale', async () => {
  const status = {
    authenticated: true,
    state: 'authenticated',
    models: [],
    modelCount: 0,
    credits: {
      state: 'available',
      usedPercent: 10,
      quotaResetDate: '2026-09-01T00:00:00Z'
    }
  }
  const english = await loadSettingsComponent(status, 'en')
  const chinese = await loadSettingsComponent(status, 'zh')
  assert.match(english, /Resets: Sep 1, 2026/)
  assert.match(chinese, /重置时间：/)
  assert.notEqual(english, chinese)
})

test('Credits localization dictionaries contain the required state and metric labels', async () => {
  const source = await read('01-i18n.js')
  for (const key of [
    'creditsTitle',
    'creditsUsed',
    'creditsRemaining',
    'creditsEntitlement',
    'creditsReset',
    'creditsPlan',
    'creditsUnlimited',
    'creditsUnavailable'
  ]) {
    assert.match(source, new RegExp(`^      ${key}:`, 'm'), key)
  }
})
