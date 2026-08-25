//#region serialize
function chatPlanText(content) {
  return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function serializeChatUserContent(content) {
  const hasImage = content.some((block) => block.type === "image");
  if (!hasImage) return chatPlanText(content);
  const parts = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text.length > 0) parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const image = block.requestImage;
      parts.push({ type: "image_url", image_url: { url: image.dataUrl } });
    }
  }
  return parts;
}

function serializeChatAssistant(entry) {
  const text = chatPlanText(entry.content);
  const reasoning = entry.content
    .filter((block) => block.type === "reasoning")
    .map((block) => block.text)
    .join("");
  const toolCalls = entry.content
    .filter((block) => block.type === "tool-call")
    .map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: call.arguments
      }
    }));
  return {
    role: "assistant",
    content: text,
    ...reasoning.length > 0 ? { reasoning_content: reasoning, reasoning_text: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
  };
}

/**
 * Map the semantic Request plan into Chat-completions messages. Tool-result
 * images are already grouped by the plan, so this adapter only supplies the
 * Chat-specific role and content-part vocabulary.
 */
function serializeChatPlan(plan) {
  const wire = [];
  for (const entry of plan.entries) {
    if (entry.type === "system") {
      wire.push({ role: "system", content: chatPlanText(entry.content) });
    } else if (entry.type === "assistant") {
      wire.push(serializeChatAssistant(entry));
    } else if (entry.type === "tool-output") {
      wire.push({
        role: "tool",
        tool_call_id: entry.toolCallId,
        content: chatPlanText(entry.content) || "(no output)"
      });
    } else if (entry.type === "user") {
      wire.push({ role: "user", content: serializeChatUserContent(entry.content) });
    } else if (entry.type === "tool-image-batch") {
      const content = [];
      for (const block of entry.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        else if (block.type === "image") {
          content.push({ type: "image_url", image_url: { url: block.requestImage.dataUrl } });
        }
      }
      wire.push({ role: "user", content });
    }
  }
  return wire;
}

/** Map a prebuilt Request plan into the full Chat wire request body. */
function serializeRequestFromPlan(options, wire, plan) {
  const messages = [];
  if (options.system !== void 0) messages.push({ role: "system", content: options.system });
  messages.push(...serializeChatPlan(plan));
  const tools = options.tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== void 0 && tools.length > 0 ? { tools } : {},
    ...options.temperature !== void 0 ? { temperature: options.temperature } : {},
    ...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== void 0 ? { stop: options.stop } : {},
    ...wire === void 0 ? {} : wire.kind === "reasoning_effort" ? { reasoning_effort: wire.value } : { thinking: { type: "enabled", effort: wire.value } }
  };
}

/** Build the full wire request body (always streaming, usage reporting on). */
async function serializeRequest(options, wire, imageResolver) {
  const plan = await buildRequestPlan({
    messages: options.messages,
    imageResolver
  });
  return serializeRequestFromPlan(options, wire, plan);
}
//#endregion
