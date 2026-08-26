import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, CREDENTIALS_EVENT } from '../lib/index.js'

const OAUTH_TOKEN = 'gho_test_credits_token'
const MODEL_BODY = {
  data: [{
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    capabilities: { type: 'chat', supports: {}, limits: {} },
    supported_endpoints: ['/chat/completions']
  }]
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function makeHarness(options = {}) {
  const {
    credits,
    creditsStatus = 200,
    creditsRaw,
    creditsTransportFailure = false,
    creditsDeferred,
    deviceLogin = false
  } = options
  const routes = []
  const listeners = new Map()
  const calls = []
  const logs = []
  let currentToken = Object.hasOwn(options, 'token') ? options.token : OAUTH_TOKEN
  let currentCredits = credits
  const credentials = {
    resolve: async () => currentToken === undefined ? undefined : { value: currentToken },
    set: async (_ref, value) => { currentToken = value },
    unset: async () => { currentToken = undefined }
  }
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    }
  }
  const ctx = {
    get(key) {
      return key === 'credentials' ? credentials : undefined
    },
    on(event, listener) {
      listeners.set(event, listener)
    },
    effect() {},
    inject(dependencies, callback) {
      if (!dependencies.includes('webServer')) return
      callback({
        webServer,
        effect(effect) {
          const cleanup = effect()
          return cleanup
        }
      })
    },
    logger: {
      warn(...args) { logs.push(args.join(' ')) },
      error(...args) { logs.push(args.join(' ')) },
      info(...args) { logs.push(args.join(' ')) }
    },
    llm: {
      registerConfigurableProviders() {},
      registerAdapter() { return { replace() {} } },
      registerModelDiscovery() {}
    }
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url) === 'https://api.github.com/copilot_internal/v2/token') {
      return jsonResponse({
        token: 'copilot_api_token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        endpoints: { api: 'https://copilot.test' }
      })
    }
    if (String(url) === 'https://github.com/login/device/code' && deviceLogin) {
      return jsonResponse({
        device_code: 'device-code',
        user_code: 'user-code',
        verification_uri: 'https://github.com/login/device',
        interval: 1,
        expires_in: 30
      })
    }
    if (String(url) === 'https://github.com/login/oauth/access_token' && deviceLogin) {
      return jsonResponse({ access_token: OAUTH_TOKEN })
    }
    if (String(url) === 'https://copilot.test/models') return jsonResponse(MODEL_BODY)
    if (String(url) === 'https://api.github.com/copilot_internal/user') {
      if (creditsTransportFailure) throw new Error('network unavailable')
      if (creditsDeferred !== undefined) return creditsDeferred.promise
      if (creditsRaw !== undefined) {
        return new Response(creditsRaw, {
          status: creditsStatus,
          headers: { 'content-type': 'application/json' }
        })
      }
      return jsonResponse(currentCredits, creditsStatus)
    }
    throw new Error(`unexpected URL: ${url}`)
  }

  apply(ctx, {})

  const statusRoute = routes.find(route => route.path === '/github-copilot-auth/status')
  const logoutRoute = routes.find(route => route.path === '/github-copilot-auth/logout')
  const loginRoute = routes.find(route => route.path === '/github-copilot-auth/login')
  assert.ok(statusRoute, 'status route must be registered')
  assert.ok(logoutRoute, 'logout route must be registered')
  assert.ok(loginRoute, 'login route must be registered')
  const status = async (url = '/github-copilot-auth/status') => {
    let body
    const response = {
      writeHead() {},
      end(value) { body = value }
    }
    await statusRoute.handler({ method: 'GET', url }, response)
    return JSON.parse(body).value
  }

  return {
    status,
    async logout() {
      let body
      await logoutRoute.handler({ method: 'POST', url: '/github-copilot-auth/logout' }, { writeHead() {}, end(value) { body = value } })
      return JSON.parse(body).value
    },
    async login() {
      let body
      await loginRoute.handler({ method: 'POST', url: '/github-copilot-auth/login' }, { writeHead() {}, end(value) { body = value } })
      return JSON.parse(body).value
    },
    calls,
    logs,
    creditsDeferred,
    setToken(value) { currentToken = value },
    setCredits(value) { currentCredits = value },
    emitCredentialUpdate(ref = 'GITHUB_COPILOT_OAUTH_TOKEN') {
      listeners.get(CREDENTIALS_EVENT)?.(ref)
    },
    restore() { globalThis.fetch = originalFetch }
  }
}

test('status exposes a normalized limited Credits snapshot without changing auth fields', async () => {
  const harness = makeHarness({
    credits: {
      copilot_plan: 'pro',
      quota_reset_date: '2026-09-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: {
          entitlement: 100,
          remaining: 24,
          percent_remaining: 24,
          unlimited: false
        }
      }
    }
  })
  try {
    const status = await harness.status()
    assert.equal(status.authenticated, true)
    assert.equal(status.state, 'authenticated')
    assert.equal(status.modelCount, 1)
    assert.deepEqual(status.credits, {
      state: 'available',
      usedPercent: 76,
      remaining: 24,
      entitlement: 100,
      quotaResetDate: '2026-09-01T00:00:00Z',
      plan: 'pro'
    })
    const creditsCall = harness.calls.find(call => call.url.endsWith('/copilot_internal/user'))
    assert.equal(creditsCall.init.headers.authorization, `token ${OAUTH_TOKEN}`)
  } finally {
    harness.restore()
  }
})

test('status exposes unlimited Credits without misleading quota values', async () => {
  const harness = makeHarness({
    credits: {
      copilot_plan: 'business',
      quota_reset_date: '2026-09-01',
      quota_snapshots: { premium_interactions: { unlimited: true } }
    }
  })
  try {
    const status = await harness.status()
    assert.deepEqual(status.credits, {
      state: 'unlimited',
      quotaResetDate: '2026-09-01',
      plan: 'business'
    })
  } finally {
    harness.restore()
  }
})

test('status clamps out-of-range percentages and rejects malformed fields independently', async () => {
  const readCredits = async credits => {
    const harness = makeHarness({ credits })
    try {
      return (await harness.status()).credits
    } finally {
      harness.restore()
    }
  }
  const high = await readCredits({
    quota_snapshots: { premium_interactions: { percent_remaining: 150 } }
  })
  const low = await readCredits({
    quota_snapshots: { premium_interactions: { percent_remaining: -10 } }
  })
  const malformed = await readCredits({
    copilot_plan: 42,
    quota_reset_date: 'not-a-date',
    quota_snapshots: {
      premium_interactions: {
        percent_remaining: 50,
        remaining: -1,
        entitlement: '100'
      }
    }
  })
  assert.equal(high.usedPercent, 0)
  assert.equal(low.usedPercent, 100)
  assert.deepEqual(malformed, {
    state: 'available',
    usedPercent: 50
  })
})

test('missing or malformed quota and failed lookup become unavailable while auth remains usable', async () => {
  const fixtures = [
    { quota_snapshots: {} },
    { quota_snapshots: { premium_interactions: { remaining: -1, entitlement: '100', percent_remaining: Number.NaN } } }
  ]
  for (const credits of fixtures) {
    const harness = makeHarness({ credits })
    try {
      const status = await harness.status()
      assert.equal(status.authenticated, true)
      assert.equal(status.modelCount, 1)
      assert.deepEqual(status.credits, { state: 'unavailable' })
    } finally {
      harness.restore()
    }
  }

  const failed = makeHarness({ credits: { ignored: true }, creditsStatus: 503 })
  try {
    const status = await failed.status()
    assert.equal(status.authenticated, true)
    assert.equal(status.modelCount, 1)
    assert.deepEqual(status.credits, { state: 'unavailable' })
  } finally {
    failed.restore()
  }
})

test('status tolerates entitlement HTTP, transport, and JSON failures', async () => {
  for (const creditsStatus of [401, 403, 429, 500]) {
    const harness = makeHarness({ credits: {}, creditsStatus })
    try {
      const status = await harness.status()
      assert.equal(status.authenticated, true)
      assert.equal(status.modelCount, 1)
      assert.deepEqual(status.credits, { state: 'unavailable' })
    } finally {
      harness.restore()
    }
  }

  for (const options of [
    { creditsRaw: '{not-json}' },
    { creditsTransportFailure: true }
  ]) {
    const harness = makeHarness(options)
    try {
      const status = await harness.status()
      assert.equal(status.authenticated, true)
      assert.equal(status.modelCount, 1)
      assert.deepEqual(status.credits, { state: 'unavailable' })
    } finally {
      harness.restore()
    }
  }
})

test('Credits cache is reused, bypassed by refresh, and invalidated by credential changes', async () => {
  const harness = makeHarness({
    credits: {
      quota_snapshots: {
        premium_interactions: { percent_remaining: 80, remaining: 8, entitlement: 10 }
      }
    }
  })
  try {
    await Promise.all([harness.status(), harness.status()])
    harness.setCredits({
      quota_snapshots: {
        premium_interactions: { percent_remaining: 70, remaining: 7, entitlement: 10 }
      }
    })
    const cached = await harness.status()
    assert.equal(cached.credits.usedPercent, 20)

    const refreshed = await harness.status('/github-copilot-auth/status?refresh=1')
    assert.equal(refreshed.credits.usedPercent, 30)

    harness.setToken('gho_second_account_token')
    harness.setCredits({
      quota_snapshots: {
        premium_interactions: { percent_remaining: 60, remaining: 6, entitlement: 10 }
      }
    })
    harness.emitCredentialUpdate()
    const afterCredentialChange = await harness.status()
    assert.equal(afterCredentialChange.credits.usedPercent, 40)
    const creditsCalls = harness.calls.filter(call => call.url.endsWith('/copilot_internal/user'))
    assert.equal(creditsCalls.at(-1).init.headers.authorization, 'token gho_second_account_token')
  } finally {
    harness.restore()
  }
})

test('logout removes authenticated Credits from subsequent status results', async () => {
  const harness = makeHarness({
    credits: { quota_snapshots: { premium_interactions: { percent_remaining: 80 } } }
  })
  try {
    assert.equal((await harness.status()).credits.usedPercent, 20)
    const loggedOut = await harness.logout()
    assert.equal(loggedOut.authenticated, false)
    const status = await harness.status()
    assert.equal(status.authenticated, false)
    assert.equal('credits' in status, false)
  } finally {
    harness.restore()
  }
})

test('completed login makes Credits available through the status seam', async () => {
  const harness = makeHarness({
    token: undefined,
    deviceLogin: true,
    credits: { quota_snapshots: { premium_interactions: { percent_remaining: 80 } } }
  })
  try {
    const login = await harness.login()
    assert.equal(login.authenticated, false)
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal((await harness.status()).credits.usedPercent, 20)
  } finally {
    harness.restore()
  }
})

test('an in-flight Credits lookup cannot return after credential logout', async () => {
  let resolveCredits
  const creditsDeferred = {
    promise: new Promise(resolve => { resolveCredits = resolve })
  }
  const harness = makeHarness({ creditsDeferred })
  try {
    const pending = harness.status()
    while (!harness.calls.some(call => call.url.endsWith('/copilot_internal/user'))) {
      await new Promise(resolve => setImmediate(resolve))
    }
    harness.setToken(undefined)
    harness.emitCredentialUpdate()
    resolveCredits(jsonResponse({
      quota_snapshots: { premium_interactions: { percent_remaining: 20 } }
    }))
    const status = await pending
    assert.equal(status.authenticated, false)
    assert.equal('credits' in status, false)
  } finally {
    harness.restore()
  }
})

test('Credits lookup failures do not log the OAuth token or raw response', async () => {
  const rawResponse = 'sensitive-entitlement-response'
  const harness = makeHarness({ creditsRaw: `{ "error": "${rawResponse}" }`, creditsStatus: 503 })
  try {
    const status = await harness.status()
    assert.deepEqual(status.credits, { state: 'unavailable' })
    assert.equal(harness.logs.some(log => log.includes(OAUTH_TOKEN) || log.includes(rawResponse)), false)
  } finally {
    harness.restore()
  }
})

test('signed-out status does not expose Credits or call the entitlement endpoint', async () => {
  const harness = makeHarness({ token: undefined, credits: { quota_snapshots: {} } })
  try {
    const status = await harness.status()
    assert.equal(status.authenticated, false)
    assert.equal('credits' in status, false)
    assert.equal(harness.calls.some(call => call.url.endsWith('/copilot_internal/user')), false)
  } finally {
    harness.restore()
  }
})
