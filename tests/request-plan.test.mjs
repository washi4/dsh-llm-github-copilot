/**
 * Shared Request-plan invariants. Wire-format tests stay focused on mapping
 * the immutable plan into Chat and Responses payload vocabulary.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRequestPlan,
  serializeRequest,
  serializeResponsesRequest
} from '../lib/index.js'

function textBlock(text) { return { type: 'text', text } }
function imageBlock(id) {
  return {
    type: 'image',
    attachment: {
      attachmentId: id,
      mediaType: 'image/png',
      bytes: 64,
      width: 100,
      height: 50
    }
  }
}
function userMessage(content, kind = 'user') {
  return { role: 'user', content, source: { kind } }
}

function resolver() {
  return {
    resolve(ref) {
      return {
        ref,
        version: {
          attachment: ref,
          variantId: `variant-${ref.attachmentId}`,
          data: new Uint8Array([1, 2, 3]),
          mediaType: 'image/png',
          bytes: 3,
          width: 100,
          height: 50
        },
        bytes: 3,
        mediaType: 'image/png',
        dataUrl: `data:image/png;base64,${ref.attachmentId}`,
        handle: `Image ${ref.attachmentId}; request image 100x50px.`
      }
    }
  }
}

test('public serializers retain their original arity', () => {
  assert.equal(serializeRequest.length, 3)
  assert.equal(serializeResponsesRequest.length, 3)
})

test('Request plan is immutable and keeps ordered resolved images', async () => {
  const imageResolver = resolver()
  const plan = await buildRequestPlan({
    messages: [userMessage([imageBlock('a'), textBlock('between'), imageBlock('b')])],
    imageResolver
  })

  assert.equal(plan.entries.length, 1)
  assert.deepEqual(plan.entries[0].content.map(block => block.type), [
    'text', 'image', 'text', 'text', 'image'
  ])
  assert.equal(plan.entries[0].content[0].text.includes('a'), true)
  assert.equal(plan.entries[0].content[1].requestImage.handle.includes('a'), true)
  assert.equal(plan.entries[0].content[3].text.includes('b'), true)
  assert.equal(plan.entries[0].content[4].requestImage.handle.includes('b'), true)
  assert.equal(Object.isFrozen(plan), true)
  assert.equal(Object.isFrozen(plan.entries), true)
  assert.equal(Object.isFrozen(plan.entries[0].content), true)
  assert.equal(Object.isFrozen(plan.requestImages[0]), true)
  assert.throws(() => plan.entries.push({ type: 'user', content: [] }), TypeError)
})

test('assistant content is one ordered immutable semantic sequence', async () => {
  const plan = await buildRequestPlan({
    messages: [{
      role: 'assistant',
      content: [
        textBlock('before'),
        { type: 'tool-call', id: 'c1', name: 'one', arguments: '{}' },
        { type: 'reasoning', text: 'think' },
        textBlock('after'),
        { type: 'tool-call', id: 'c2', name: 'two', arguments: '{}' }
      ],
      source: { kind: 'model', provider: 'p', model: 'm' }
    }],
    imageResolver: resolver()
  })

  const entry = plan.entries[0]
  assert.deepEqual(entry.content.map(block => block.type), [
    'text', 'tool-call', 'reasoning', 'text', 'tool-call'
  ])
  assert.equal(entry.content[0].text, 'before')
  assert.equal(entry.content[1].id, 'c1')
  assert.equal(entry.content[4].id, 'c2')
  assert.equal(entry.toolCalls, undefined)
  assert.equal(Object.isFrozen(entry.content), true)
})

test('Chat serializer matches the fixed HEAD-compatible payload shape', async () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        textBlock('before'),
        { type: 'tool-call', id: 'c1', name: 'one', arguments: '{}' },
        { type: 'reasoning', text: 'think' },
        textBlock('after'),
        { type: 'tool-call', id: 'c2', name: 'two', arguments: '{}' }
      ],
      source: { kind: 'model', provider: 'p', model: 'm' }
    },
    userMessage([{
      type: 'tool-result',
      toolCallId: 'c1',
      content: [
        textBlock('result'),
        imageBlock('tool-image'),
        {
          type: 'tool-result',
          toolCallId: 'nested',
          content: [textBlock('nested'), imageBlock('nested-image')]
        }
      ]
    }], 'tool')
  ]
  const imageResolver = resolver()
  const body = await serializeRequest(
    { model: 'gpt-4.1', messages },
    undefined,
    imageResolver
  )
  assert.deepEqual(body, {
    model: 'gpt-4.1',
    messages: [
      {
        role: 'assistant',
        content: 'beforeafter',
        reasoning_content: 'think',
        reasoning_text: 'think',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'one', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'two', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image associated with tool call c1:' },
          { type: 'text', text: 'Image tool-image; request image 100x50px.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,tool-image' } }
        ]
      }
    ],
    stream: true,
    stream_options: { include_usage: true }
  })
})

test('Responses serializer matches the fixed HEAD-compatible payload shape', async () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        textBlock('before'),
        { type: 'tool-call', id: 'c1', name: 'one', arguments: '{}' },
        { type: 'reasoning', text: 'think' },
        textBlock('after'),
        { type: 'tool-call', id: 'c2', name: 'two', arguments: '{}' }
      ],
      source: { kind: 'model', provider: 'p', model: 'm' }
    },
    userMessage([{
      type: 'tool-result',
      toolCallId: 'c1',
      content: [
        textBlock('result'),
        imageBlock('tool-image'),
        {
          type: 'tool-result',
          toolCallId: 'nested',
          content: [textBlock('nested'), imageBlock('nested-image')]
        }
      ]
    }], 'tool')
  ]
  const imageResolver = resolver()
  const body = await serializeResponsesRequest(
    { model: 'gpt-5.6-luna', messages },
    undefined,
    imageResolver,
    false
  )
  assert.deepEqual(body, {
    model: 'gpt-5.6-luna',
    input: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'beforeafter' }]
      },
      { type: 'function_call', call_id: 'c1', name: 'one', arguments: '{}' },
      { type: 'function_call', call_id: 'c2', name: 'two', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'result' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Image associated with tool call c1:' },
          { type: 'input_text', text: 'Image tool-image; request image 100x50px.' },
          { type: 'input_image', image_url: 'data:image/png;base64,tool-image' }
        ]
      }
    ],
    stream: true
  })
})

test('both adapters map missing toolCallId to provider fields', async () => {
  const messages = [userMessage([{
    type: 'tool-result',
    content: [imageBlock('missing-id-image')]
  }], 'tool')]
  const imageResolver = resolver()
  const chat = await serializeRequest(
    { model: 'gpt-4.1', messages },
    undefined,
    imageResolver
  )
  assert.equal(chat.messages[0].tool_call_id, undefined)
  assert.equal(
    chat.messages[1].content.find(part => part.type === 'image_url').image_url.url,
    'data:image/png;base64,missing-id-image'
  )

  const responses = await serializeResponsesRequest(
    { model: 'gpt-5.6-luna', messages },
    undefined,
    imageResolver,
    false
  )
  assert.equal(responses.input[0].call_id, undefined)
  assert.equal(
    responses.input[1].content.find(part => part.type === 'input_image').image_url,
    'data:image/png;base64,missing-id-image'
  )
})

test('plan owns stable handles and tool-call association markers', async () => {
  const imageResolver = resolver()
  const plan = await buildRequestPlan({
    messages: [
      userMessage([imageBlock('u1'), textBlock('between'), imageBlock('u2')]),
      userMessage([{
        type: 'tool-result',
        toolCallId: 'c1',
        content: [textBlock('result'), imageBlock('t1')]
      }], 'tool')
    ],
    imageResolver
  })

  const userEntry = plan.entries.find(entry => entry.type === 'user')
  assert.deepEqual(userEntry.content.map(block => block.type), [
    'text', 'image', 'text', 'text', 'image'
  ])
  assert.match(userEntry.content[0].text, /Image u1/)
  assert.equal(userEntry.content[1].requestImage.attachmentId, 'u1')
  assert.equal(userEntry.content[2].text, 'between')
  assert.match(userEntry.content[3].text, /Image u2/)
  assert.equal(userEntry.content[4].requestImage.attachmentId, 'u2')

  const batch = plan.entries.find(entry => entry.type === 'tool-image-batch')
  assert.deepEqual(batch.content.map(block => block.type), ['text', 'text', 'image'])
  assert.equal(batch.content[0].text, 'Image associated with tool call c1:')
  assert.match(batch.content[1].text, /Image t1/)
  assert.equal(batch.content[2].requestImage.attachmentId, 't1')
})

test('plan owns consecutive tool-output ordering and image batching', async () => {
  const imageResolver = resolver()
  const plan = await buildRequestPlan({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c1', name: 'one', arguments: '{}' },
          { type: 'tool-call', id: 'c2', name: 'two', arguments: '{}' }
        ],
        source: { kind: 'model', provider: 'p', model: 'm' }
      },
      userMessage([{
        type: 'tool-result',
        toolCallId: 'c1',
        content: [textBlock('one'), imageBlock('i1')],
        isError: false
      }], 'tool'),
      userMessage([{
        type: 'tool-result',
        toolCallId: 'c2',
        content: [textBlock('two'), imageBlock('i2')],
        isError: false
      }], 'tool'),
      userMessage([textBlock('next')])
    ],
    imageResolver
  })

  assert.deepEqual(plan.entries.map(entry => entry.type), [
    'assistant', 'tool-output', 'tool-output', 'tool-image-batch', 'user'
  ])
  assert.deepEqual(plan.entries[3].content.map(block => block.type), [
    'text', 'text', 'image', 'text', 'text', 'image'
  ])
  assert.deepEqual(
    plan.entries[3].content
      .filter(block => block.type === 'image')
      .map(block => block.requestImage.attachmentId),
    ['i1', 'i2']
  )
  assert.equal(plan.entries[1].content[0].text, 'one')
  assert.equal(plan.entries[2].content[0].text, 'two')
})

test('text-only tool result emits one tool-output without a tool-image-batch', async () => {
  const plan = await buildRequestPlan({
    messages: [userMessage([{
      type: 'tool-result',
      toolCallId: 'text-only',
      content: [textBlock('done')],
      isError: false
    }], 'tool')],
    imageResolver: resolver()
  })

  assert.deepEqual(plan.entries.map(entry => entry.type), ['tool-output'])
  assert.deepEqual(plan.entries[0].content, [{ type: 'text', text: 'done' }])
  assert.equal(plan.entries[0].toolCallId, 'text-only')
  assert.equal(plan.requestImages.length, 0)
})

test('plan preserves HEAD nested tool-result semantics', async () => {
  const imageResolver = resolver()
  const plan = await buildRequestPlan({
    messages: [userMessage([{
      type: 'tool-result',
      toolCallId: 'outer',
      content: [
        textBlock('outer'),
        imageBlock('direct'),
        {
          type: 'tool-result',
          toolCallId: 'nested',
          content: [textBlock('nested'), imageBlock('nested')]
        }
      ]
    }], 'tool')],
    imageResolver
  })

  assert.deepEqual(plan.entries.map(entry => entry.type), [
    'tool-output', 'tool-image-batch'
  ])
  assert.equal(plan.entries[0].content[0].text, 'outer')
  assert.deepEqual(plan.entries[1].content.map(block => block.type), [
    'text', 'text', 'image'
  ])
  assert.equal(plan.entries[1].content[0].text, 'Image associated with tool call outer:')
  assert.equal(plan.entries[1].content[2].requestImage.attachmentId, 'direct')
})

test('plan retains image-bearing tool results without a toolCallId', async () => {
  const plan = await buildRequestPlan({
    messages: [userMessage([{
      type: 'tool-result',
      content: [imageBlock('unassociated')]
    }], 'tool')],
    imageResolver: resolver()
  })

  const batch = plan.entries.find(entry => entry.type === 'tool-image-batch')
  assert.ok(batch)
  assert.equal(batch.content[0].text, 'Image associated with tool call undefined:')
  assert.equal(batch.content[2].requestImage.attachmentId, 'unassociated')
})

test('plan validates unsupported images using the shared content invariant', async () => {
  const imageResolver = resolver()
  await assert.rejects(
    () => buildRequestPlan({
      messages: [{
        role: 'system',
        content: [textBlock('prompt'), imageBlock('system-image')],
        source: { kind: 'plugin', plugin: 'test' }
      }],
      imageResolver
    }),
    error => error.code === 'UNSUPPORTED_CONTENT'
      && /system messages/.test(error.message)
  )
  await assert.rejects(
    () => buildRequestPlan({
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool-result',
          toolCallId: 'nested',
          content: [imageBlock('assistant-image')]
        }],
        source: { kind: 'model', provider: 'p', model: 'm' }
      }],
      imageResolver
    }),
    error => error.code === 'UNSUPPORTED_CONTENT'
      && /assistant messages/.test(error.message)
  )
})

test('ordered resolution errors take precedence over later unsupported images', async () => {
  const firstFailure = new Error('first image could not be resolved')
  await assert.rejects(
    () => buildRequestPlan({
      messages: [
        userMessage([imageBlock('first')]),
        {
          role: 'system',
          content: [imageBlock('unsupported-system')],
          source: { kind: 'plugin', plugin: 'test' }
        }
      ],
      imageResolver: {
        resolve() {
          throw firstFailure
        }
      }
    }),
    error => error === firstFailure
  )
})

function resolvedImage(ref, call, handle) {
  const image = {
    ref,
    bytes: call,
    mediaType: 'image/png',
    dataUrl: `data:image/png;base64,call-${call}`
  }
  if (handle !== undefined) image.handle = handle
  return image
}

test('original serializers resolve every repeated image occurrence in order', async () => {
  for (const [name, serialize, model, expected] of [
    ['Chat', serializeRequest, 'gpt-4.1', [
      { type: 'text', text: 'handle-1' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,call-1' } },
      { type: 'text', text: 'handle-2' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,call-2' } }
    ]],
    ['Responses', serializeResponsesRequest, 'gpt-5.6-luna', [
      { type: 'input_text', text: 'handle-1' },
      { type: 'input_image', image_url: 'data:image/png;base64,call-1' },
      { type: 'input_text', text: 'handle-2' },
      { type: 'input_image', image_url: 'data:image/png;base64,call-2' }
    ]]
  ]) {
    const calls = []
    const imageResolver = {
      resolve(ref) {
        const call = calls.length + 1
        calls.push(ref.attachmentId)
        return resolvedImage(ref, call, `handle-${call}`)
      }
    }
    const body = await serialize(
      { model, messages: [userMessage([imageBlock('same'), imageBlock('same')])] },
      undefined,
      imageResolver
    )
    assert.deepEqual(calls, ['same', 'same'], `${name} resolver call order`)
    const content = name === 'Chat'
      ? body.messages[0].content
      : body.input[0].content
    assert.deepEqual(content, expected, `${name} payload order`)
  }
})

test('original serializers do not suppress a later repeated-image resolver error', async () => {
  for (const [name, serialize, model] of [
    ['Chat', serializeRequest, 'gpt-4.1'],
    ['Responses', serializeResponsesRequest, 'gpt-5.6-luna']
  ]) {
    const laterError = new Error(`${name} later image failure`)
    let calls = 0
    const imageResolver = {
      resolve(ref) {
        calls++
        if (calls === 2) throw laterError
        return resolvedImage(ref, calls, `handle-${calls}`)
      }
    }
    await assert.rejects(
      () => serialize(
        { model, messages: [userMessage([imageBlock('same'), imageBlock('same')])] },
        undefined,
        imageResolver
      ),
      error => error === laterError
    )
    assert.equal(calls, 2, `${name} resolver calls`)
  }
})

test('original serializers omit handle text when the resolver provides no handle', async () => {
  for (const handle of [undefined, null]) {
    for (const [name, serialize, model, expected] of [
      ['Chat', serializeRequest, 'gpt-4.1', [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,call-1' } }
      ]],
      ['Responses', serializeResponsesRequest, 'gpt-5.6-luna', [
        { type: 'input_image', image_url: 'data:image/png;base64,call-1' }
      ]]
    ]) {
      const imageResolver = {
        resolve(ref) {
          const resolved = resolvedImage(ref, 1)
          if (handle !== undefined) resolved.handle = handle
          return resolved
        }
      }
      const body = await serialize(
        { model, messages: [userMessage([imageBlock('no-handle')])] },
        undefined,
        imageResolver
      )
      const content = name === 'Chat'
        ? body.messages[0].content
        : body.input[0].content
      assert.deepEqual(content, expected, `${name} handle=${String(handle)}`)
    }
  }
})
