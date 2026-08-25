/**
 * Unit tests for Chat Completions serialization, including image support.
 * Tests the async serializeRequest() exported from lib/index.js.
 *
 * v0.4.0 changes:
 *   - The Request plan places stable handle text BEFORE each image_url part.
 *   - Tool-result images are supported: role:tool keeps text, images follow
 *     in a subsequent user message with per-call-id markers.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { serializeRequest } from '../lib/index.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function textBlock(text) { return { type: 'text', text } }
function imageBlock(id, mediaType = 'image/png', bytes = 1024) {
  return { type: 'image', attachment: { attachmentId: id, mediaType, bytes, width: 100, height: 100 } }
}
function textMsg(text, role = 'user') {
  return { role, content: [textBlock(text)], source: { kind: role === 'user' ? 'user' : 'model' } }
}
function imageMsg(id) {
  return { role: 'user', content: [imageBlock(id)], source: { kind: 'user' } }
}
function mixedMsg(text, id) {
  return { role: 'user', content: [textBlock(text), imageBlock(id)], source: { kind: 'user' } }
}
function toolResultMsg(callId, innerContent) {
  return {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: innerContent, isError: false }],
    source: { kind: 'tool', callId }
  }
}

function makeOptions(messages, model = 'gpt-4.1') {
  return { provider: 'github-copilot-official', model, messages }
}

/**
 * Mock imageResolver that returns a predetermined dataUrl and handle per
 * attachmentId.  The handle defaults to a string containing the id.
 */
function mockResolver(map = {}) {
  return {
    resolve(ref) {
      const entry = map[ref.attachmentId]
      if (!entry) return Promise.reject(new Error(`unexpected attachmentId: ${ref.attachmentId}`))
      return Promise.resolve({
        ref,
        bytes: entry.bytes ?? 512,
        mediaType: entry.mediaType ?? 'image/png',
        dataUrl: entry.dataUrl ?? `data:image/png;base64,${entry.b64 ?? 'AAAA'}`,
        handle: entry.handle ?? `Image ${ref.attachmentId}; request image 100x100px.`
      })
    }
  }
}

const noopResolver = { resolve: () => Promise.reject(new Error('unexpected image')) }

// ── pure text (backward-compat wire shape) ────────────────────────────────────

test('pure text user message → string content (not array)', async () => {
  const opts = makeOptions([textMsg('hello', 'user')])
  const body = await serializeRequest(opts, undefined, noopResolver)
  const msg = body.messages.find(m => m.role === 'user')
  assert.equal(typeof msg.content, 'string')
  assert.equal(msg.content, 'hello')
})

test('pure text system message → string content', async () => {
  const opts = { ...makeOptions([]), system: 'be helpful' }
  const body = await serializeRequest(opts, undefined, noopResolver)
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, 'be helpful')
})

test('multiple pure-text turns produce only string-content messages', async () => {
  const opts = makeOptions([
    textMsg('hi', 'user'),
    { role: 'assistant', content: [textBlock('hello')], source: { kind: 'model', provider: 'p', model: 'm' } },
    textMsg('thanks', 'user')
  ])
  const body = await serializeRequest(opts, undefined, noopResolver)
  for (const m of body.messages) {
    assert.equal(typeof m.content, 'string', `message role=${m.role} should have string content`)
  }
})

// ── text + image (user messages) ──────────────────────────────────────────────

test('user message with text and image maps image data to image_url', async () => {
  const opts = makeOptions([mixedMsg('describe this', 'img1')])
  const resolver = mockResolver({ img1: { dataUrl: 'data:image/png;base64,ABC' } })
  const body = await serializeRequest(opts, undefined, resolver)
  const msg = body.messages.find(m => m.role === 'user')
  assert.ok(Array.isArray(msg.content))
  assert.equal(msg.content[0].type, 'text')
  assert.equal(msg.content[0].text, 'describe this')
  const image = msg.content.find(part => part.type === 'image_url')
  assert.ok(image)
  assert.equal(image.image_url.url, 'data:image/png;base64,ABC')
})

test('image-only user message maps to an image_url content part', async () => {
  const opts = makeOptions([imageMsg('img2')])
  const resolver = mockResolver({ img2: { dataUrl: 'data:image/jpeg;base64,XYZ' } })
  const body = await serializeRequest(opts, undefined, resolver)
  const msg = body.messages.find(m => m.role === 'user')
  assert.ok(Array.isArray(msg.content))
  const image = msg.content.find(part => part.type === 'image_url')
  assert.ok(image)
  assert.equal(image.image_url.url, 'data:image/jpeg;base64,XYZ')
})

test('missing image resolver preserves the native TypeError from HEAD', async () => {
  const opts = makeOptions([imageMsg('missing-resolver')])
  await assert.rejects(
    serializeRequest(opts, undefined),
    (error) => error instanceof TypeError
      && error.message === "Cannot read properties of undefined (reading 'resolve')"
  )
})

test('null image resolution preserves the native TypeError from HEAD', async () => {
  const opts = makeOptions([imageMsg('null-resolution')])
  await assert.rejects(
    serializeRequest(opts, undefined, { resolve: () => null }),
    (error) => error instanceof TypeError
      && error.message === "Cannot read properties of null (reading 'dataUrl')"
  )
})

// ── tool-result images ────────────────────────────────────────────────────────

test('tool-result image maps tool output and image_url fields', async () => {
  const opts = makeOptions([
    toolResultMsg('call-1', [textBlock('screenshot taken'), imageBlock('tool-img')])
  ])
  const resolver = mockResolver({ 'tool-img': { dataUrl: 'data:image/png;base64,TOOL' } })
  const body = await serializeRequest(opts, undefined, resolver)
  const toolMsg = body.messages.find(m => m.role === 'tool')
  assert.ok(toolMsg)
  assert.equal(toolMsg.tool_call_id, 'call-1')
  assert.equal(toolMsg.content, 'screenshot taken')
  const image = body.messages
    .flatMap(message => Array.isArray(message.content) ? message.content : [])
    .find(part => part.type === 'image_url')
  assert.ok(image)
  assert.equal(image.image_url.url, 'data:image/png;base64,TOOL')
})

// ── wire shape invariants ─────────────────────────────────────────────────────

test('stream and stream_options fields are always present', async () => {
  const body = await serializeRequest(makeOptions([textMsg('hi')]), undefined, noopResolver)
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
})

test('model id is forwarded to wire', async () => {
  const body = await serializeRequest(makeOptions([textMsg('hi')], 'gpt-4o'), undefined, noopResolver)
  assert.equal(body.model, 'gpt-4o')
})
