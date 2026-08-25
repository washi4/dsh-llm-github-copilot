/**
 * Request-path coverage for GitHubCopilotAdapter.
 *
 * These tests exercise the public adapter stream seam: image projection,
 * Request-plan construction, wire serialization, endpoint selection, fetch,
 * and SSE translation. Assertions focus on the outgoing route and payload.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { GitHubCopilotAdapter } from '../lib/index.js'

const BASE_URL = 'https://copilot.test'

function textBlock(text) {
  return { type: 'text', text }
}

function imageMessage() {
  return {
    role: 'user',
    content: [{
      type: 'text',
      text: 'describe this'
    }, {
      type: 'image',
      attachment: {
        attachmentId: 'photo',
        mediaType: 'image/png',
        bytes: 3,
        width: 2,
        height: 2
      }
    }],
    source: { kind: 'user' }
  }
}

function imageMessageWithId(id) {
  const message = imageMessage()
  return {
    ...message,
    content: message.content.map(block => block.type === 'image'
      ? { ...block, attachment: { ...block.attachment, attachmentId: id } }
      : block)
  }
}

function model(id, endpoint) {
  return {
    id,
    name: id,
    endpoints: [endpoint],
    inputModalities: ['text', 'image'],
    vision: {
      maxImages: 1,
      maxImageBytes: 1024,
      mediaTypes: ['image/png']
    }
  }
}

function makeStore() {
  return {
    async readImageRequest(ref, _policy, _signal) {
      return {
        variantId: 'variant-photo',
        attachment: ref,
        data: Uint8Array.from([1, 2, 3]),
        mediaType: 'image/png',
        bytes: 3,
        width: 2,
        height: 2,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false
      }
    }
  }
}

function makeProjectionFailureStore() {
  return {
    async readImageRequest(ref, _policy, _signal) {
      return {
        variantId: `variant-${ref.attachmentId}`,
        attachment: ref,
        data: Uint8Array.from([1, 2, 3]),
        mediaType: ref.attachmentId === 'user-image' ? 'image/webp' : 'image/png',
        bytes: 3,
        width: 2,
        height: 2,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false
      }
    }
  }
}

function makeAdapter(entry, store) {
  return new GitHubCopilotAdapter({
    options: () => ({
      imageOverflowPolicy: 'offload-oldest',
      defaultImagePixelBudget: 4194304,
      maxInlineRequestImageBytes: 20 * 1024 * 1024,
      inlineImageOffloadByteQuantum: 10 * 1024 * 1024,
      retryPolicy: {}
    }),
    catalog: async () => [entry],
    resolveModel: async (_provider, modelId) => ({ id: modelId }),
    resolveConnection: async () => ({
      apiToken: 'test-token',
      baseUrl: BASE_URL
    }),
    resolveAttachments: () => store,
    warn: () => {}
  })
}

async function collectRequest(entry, responseBody) {
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return new Response(responseBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }

  try {
    const adapter = makeAdapter(entry, makeStore())
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'github-copilot-official',
      model: entry.id,
      messages: [imageMessage()]
    })) {
      chunks.push(chunk)
    }
    return { requests, chunks }
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('adapter sends projected image through Chat route and translates response', async () => {
  const responseBody = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
    'data: [DONE]'
  ].join('\n\n') + '\n\n'
  const entry = model('gpt-4.1', '/chat/completions')
  const { requests, chunks } = await collectRequest(entry, responseBody)

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, `${BASE_URL}/chat/completions`)
  assert.equal(requests[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    model: 'gpt-4.1',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'text', text: 'Image photo; request image 2x2px.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }
      ]
    }],
    stream: true,
    stream_options: { include_usage: true }
  })
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'ok'))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('adapter sends projected image through Responses route and translates response', async () => {
  const responseBody = [
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}`,
    `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } })}`
  ].join('\n\n') + '\n\n'
  const entry = model('gpt-5.6-luna', '/responses')
  const { requests, chunks } = await collectRequest(entry, responseBody)

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, `${BASE_URL}/responses`)
  assert.equal(requests[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    model: 'gpt-5.6-luna',
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'describe this' },
        { type: 'input_text', text: 'Image photo; request image 2x2px.' },
        { type: 'input_image', image_url: 'data:image/png;base64,AQID' }
      ]
    }],
    stream: true
  })
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'ok'))
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: { kind: 'stop' }
  })
})

test('adapter projection failure wins before Request-plan validation and fetch', async () => {
  const entry = {
    ...model('gpt-4.1', '/chat/completions'),
    vision: {
      ...model('gpt-4.1', '/chat/completions').vision,
      maxImages: 2
    }
  }
  const messages = [
    {
      role: 'system',
      content: [{
        type: 'image',
        attachment: {
          attachmentId: 'system-image',
          mediaType: 'image/png',
          bytes: 3,
          width: 2,
          height: 2
        }
      }],
      source: { kind: 'plugin', plugin: 'test' }
    },
    imageMessageWithId('user-image')
  ]
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    throw new Error('provider request should not be sent')
  }

  try {
    const adapter = makeAdapter(entry, makeProjectionFailureStore())
    await assert.rejects(
      async () => {
        for await (const _chunk of adapter.stream({
          provider: 'github-copilot-official',
          model: entry.id,
          messages
        })) {
        }
      },
      error => {
        assert.equal(error.code, 'UNSUPPORTED_CONTENT')
        assert.match(error.message, /derived request image type image\/webp/)
        return true
      }
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(requests.length, 0)
})
