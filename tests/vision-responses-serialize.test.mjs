/**
 * Unit tests for Responses API serialization, including input_image support.
 * Tests the async serializeResponsesRequest() exported from lib/index.js.
 *
 * v0.4.0 changes:
 *   - The Request plan places stable handle text (input_text) BEFORE each
 *     input_image part.
 *   - Tool-result images are supported: function_call_output keeps text, images
 *     follow in a subsequent role:user message with per-call-id markers.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { serializeResponsesRequest } from '../lib/index.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function textBlock(text) { return { type: 'text', text } }
function imageBlock(id) {
  return { type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 512, width: 100, height: 100 } }
}

function mockResolver(map = {}) {
  return {
    resolve(ref) {
      const entry = map[ref.attachmentId]
      if (!entry) return Promise.reject(new Error(`unexpected attachmentId: ${ref.attachmentId}`))
      return Promise.resolve({
        ref, bytes: 512, mediaType: 'image/png',
        dataUrl: entry.dataUrl ?? `data:image/png;base64,${entry.b64 ?? 'AAAA'}`,
        handle: entry.handle ?? `Image ${ref.attachmentId}; request image 100x100px.`
      })
    }
  }
}

const noopResolver = { resolve: () => Promise.reject(new Error('unexpected image')) }

function makeOpts(messages, model = 'gpt-5.6-luna') {
  return { provider: 'github-copilot-official', model, messages }
}

// ── pure text ─────────────────────────────────────────────────────────────────

test('pure text user message → input_text item', async () => {
  const opts = makeOpts([{
    role: 'user', content: [textBlock('hello')], source: { kind: 'user' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  const item = body.input.find(i => i.role === 'user')
  assert.ok(Array.isArray(item.content))
  assert.equal(item.content[0].type, 'input_text')
  assert.equal(item.content[0].text, 'hello')
})

test('system message → input_text in system role', async () => {
  const opts = { ...makeOpts([]), system: 'be helpful' }
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  const sys = body.input[0]
  assert.equal(sys.role, 'system')
  assert.equal(sys.content[0].type, 'input_text')
  assert.equal(sys.content[0].text, 'be helpful')
})

// ── image support ─────────────────────────────────────────────────────────────

test('user message with image → input_image item', async () => {
  const opts = makeOpts([{
    role: 'user', content: [imageBlock('img1')], source: { kind: 'user' }
  }])
  const resolver = mockResolver({ img1: { dataUrl: 'data:image/png;base64,IMGDATA' } })
  const body = await serializeResponsesRequest(opts, undefined, resolver)
  const item = body.input.find(i => i.role === 'user')
  const imgPart = item.content.find(p => p.type === 'input_image')
  assert.ok(imgPart, 'should have input_image part')
  assert.equal(imgPart.image_url, 'data:image/png;base64,IMGDATA')
})

test('text + image maps text and image fields', async () => {
  const opts = makeOpts([{
    role: 'user',
    content: [textBlock('look at this'), imageBlock('img2')],
    source: { kind: 'user' }
  }])
  const resolver = mockResolver({ img2: { dataUrl: 'data:image/png;base64,DATA2' } })
  const body = await serializeResponsesRequest(opts, undefined, resolver)
  const parts = body.input.find(i => i.role === 'user').content
  const text = parts.find(part => part.type === 'input_text' && part.text === 'look at this')
  assert.ok(text)
  const image = parts.find(part => part.type === 'input_image')
  assert.ok(image)
  assert.equal(image.image_url, 'data:image/png;base64,DATA2')
})

test('missing image resolver preserves the native TypeError from HEAD', async () => {
  const opts = makeOpts([{
    role: 'user', content: [imageBlock('missing-resolver')], source: { kind: 'user' }
  }])
  await assert.rejects(
    serializeResponsesRequest(opts, undefined),
    (error) => error instanceof TypeError
      && error.message === "Cannot read properties of undefined (reading 'resolve')"
  )
})

test('null image resolution preserves the native TypeError from HEAD', async () => {
  const opts = makeOpts([{
    role: 'user', content: [imageBlock('null-resolution')], source: { kind: 'user' }
  }])
  await assert.rejects(
    serializeResponsesRequest(opts, undefined, { resolve: () => null }),
    (error) => error instanceof TypeError
      && error.message === "Cannot read properties of null (reading 'dataUrl')"
  )
})

// ── tool-result images ────────────────────────────────────────────────────────

test('tool-result image maps function_call_output and input_image fields', async () => {
  const opts = makeOpts([{
    role: 'user',
    content: [{
      type: 'tool-result', toolCallId: 'c1',
      content: [textBlock('screenshot'), imageBlock('img-tool')], isError: false
    }],
    source: { kind: 'tool', callId: 'c1' }
  }])
  const resolver = mockResolver({ 'img-tool': { dataUrl: 'data:image/png;base64,TOOL' } })
  const body = await serializeResponsesRequest(opts, undefined, resolver)
  const fco = body.input.find(i => i.type === 'function_call_output')
  assert.ok(fco)
  assert.equal(fco.call_id, 'c1')
  assert.equal(fco.output, 'screenshot')
  const image = body.input
    .flatMap(item => Array.isArray(item.content) ? item.content : [])
    .find(part => part.type === 'input_image')
  assert.ok(image)
  assert.equal(image.image_url, 'data:image/png;base64,TOOL')
})

// ── tool call serialization ───────────────────────────────────────────────────

test('tool call only in assistant turn → top-level function_call item, no assistant message', async () => {
  const opts = makeOpts([{
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call-abc', name: 'search', arguments: '{"q":"test"}' }],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  const fcItems = body.input.filter(i => i.type === 'function_call')
  assert.equal(fcItems.length, 1, 'exactly one function_call top-level item')
  assert.equal(fcItems[0].name, 'search')
  assert.equal(fcItems[0].call_id, 'call-abc')
  assert.equal(fcItems[0].arguments, '{"q":"test"}')
  assert.equal(fcItems[0].id, undefined, 'id must be omitted')
  const asstMsg = body.input.find(i => i.role === 'assistant')
  assert.equal(asstMsg, undefined, 'no assistant message when there is only a tool call')
})

test('real-world call_… id → id omitted, call_id preserved (regression)', async () => {
  const callId = 'call_00_JrdrVQskenAyDcreGWUA4666'
  const opts = makeOpts([{
    role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: 'get_weather', arguments: '{"city":"Tokyo"}' }],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  const fc = body.input.find(i => i.type === 'function_call')
  assert.ok(fc)
  assert.equal(fc.id, undefined)
  assert.equal(fc.call_id, callId)
  assert.equal(fc.name, 'get_weather')
})

test('tool call never appears inside assistant message content', async () => {
  const opts = makeOpts([{
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call-abc', name: 'search', arguments: '{}' }],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  for (const item of body.input) {
    if (!Array.isArray(item.content)) continue
    for (const part of item.content) {
      assert.notEqual(part.type, 'output_tool_call')
    }
  }
})

test('assistant text + tool call → separate message and function_call items', async () => {
  const opts = makeOpts([{
    role: 'assistant',
    content: [
      textBlock('I will search for that.'),
      { type: 'tool-call', id: 'call-xyz', name: 'search', arguments: '{"q":"foo"}' }
    ],
    source: { kind: 'model', provider: 'p', model: 'm' }
  }])
  const body = await serializeResponsesRequest(opts, undefined, noopResolver)
  const asstMsg = body.input.find(i => i.role === 'assistant')
  assert.ok(asstMsg)
  assert.equal(asstMsg.type, 'message')
  assert.equal(asstMsg.content[0].type, 'output_text')
  assert.equal(asstMsg.content[0].text, 'I will search for that.')
  const fc = body.input.find(i => i.type === 'function_call')
  assert.ok(fc)
  assert.equal(fc.name, 'search')
  assert.equal(fc.call_id, 'call-xyz')
})

// ── existing behavior preserved ───────────────────────────────────────────────

test('stream is always true in Responses wire', async () => {
  const body = await serializeResponsesRequest(makeOpts([{ role: 'user', content: [textBlock('hi')], source: { kind: 'user' } }]), undefined, noopResolver)
  assert.equal(body.stream, true)
})
