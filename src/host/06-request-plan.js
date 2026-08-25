//#region request plan
/**
 * Build the immutable, ordered, Wire-neutral representation shared by the
 * Chat and Responses request adapters.
 *
 * Request-image projection decides which durable images survive and resolves
 * them through the route-specific resolver. This module only walks the
 * projected conversation, preserves semantic order, groups tool-result
 * images, and validates content that neither Wire format can represent.
 *
 * @module dsh-llm-github-copilot/request-plan
 */

function requestPlanText(blocks) {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function freezePlanValue(value, seen = new Set()) {
  if (value == null || typeof value !== "object" || seen.has(value)) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezePlanValue(child, seen);
  return Object.freeze(value);
}

function requestImageSnapshot(ref, resolved) {
  const handle = resolved?.handle;
  const dataUrl = resolved.dataUrl;
  const version = resolved.version;
  const sourceAttachment = version?.attachment ?? resolved.ref ?? ref;
  const attachment = structuredClone(sourceAttachment);
  return {
    attachment: { ...attachment },
    attachmentId: attachment.attachmentId ?? ref.attachmentId,
    ...version?.variantId === void 0 ? {} : { variantId: version.variantId },
    mediaType: resolved.mediaType ?? version?.mediaType ?? attachment.mediaType,
    bytes: resolved.bytes ?? version?.bytes ?? attachment.bytes,
    ...version?.width === void 0 && attachment.width === void 0
      ? {}
      : { width: version?.width ?? attachment.width },
    ...version?.height === void 0 && attachment.height === void 0
      ? {}
      : { height: version?.height ?? attachment.height },
    dataUrl,
    ...handle === void 0 ? {} : { handle }
  };
}

/**
 * Build a plan from already-projected messages.
 *
 * @param {object} params
 * @param {readonly import("@deepseek-ai/dsh-llm").Message[]} params.messages
 * @param {{ resolve(ref: object): Promise<object> | object }} params.imageResolver
 * @returns {Promise<Readonly<{ entries: readonly object[], requestImages: readonly object[] }>>}
 */
async function buildRequestPlan({ messages, imageResolver }) {
  const entries = [];
  const requestImages = [];
  let pendingToolImages = [];

  const resolveImage = async (ref) => {
    const resolved = await imageResolver.resolve(ref);
    const image = requestImageSnapshot(ref, resolved);
    const frozen = freezePlanValue(image);
    requestImages.push(frozen);
    return frozen;
  };

  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return;
    entries.push({
      type: "tool-image-batch",
      content: pendingToolImages
    });
    pendingToolImages = [];
  };

  const appendToolResult = async (result) => {
    const directContent = [];
    for (const block of result.content) {
      if (block.type === "text") directContent.push({ type: "text", text: block.text });
      else if (block.type === "image") {
        const image = await resolveImage(block.attachment);
        pendingToolImages.push({
          type: "text",
          text: `Image associated with tool call ${result.toolCallId}:`
        });
        if (image.handle) {
          pendingToolImages.push({ type: "text", text: image.handle });
        }
        pendingToolImages.push({ type: "image", requestImage: image });
      }
    }
    entries.push({
      type: "tool-output",
      toolCallId: result.toolCallId,
      content: directContent,
      ...result.isError === void 0 ? {} : { isError: result.isError }
    });
  };

  const appendUserContent = async (blocks) => {
    const content = [];
    for (const block of blocks) {
      if (block.type === "text") {
        if (block.text.length > 0) content.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const requestImage = await resolveImage(block.attachment);
        if (requestImage.handle) {
          content.push({ type: "text", text: requestImage.handle });
        }
        content.push({
          type: "image",
          requestImage
        });
      }
    }
    return content;
  };

  for (const message of messages) {
    if (message.role === "system" || message.role === "assistant") {
      flushToolImages();
      if (contentHasImage(message.content)) {
        throw new LlmError(
          `GitHub Copilot adapter does not support image content in ${message.role} messages.`,
          "UNSUPPORTED_CONTENT"
        );
      }
      if (message.role === "system") {
        entries.push({
          type: "system",
          content: message.content
            .filter((block) => block.type === "text")
            .map((block) => ({ type: "text", text: block.text }))
        });
      } else {
        entries.push({
          type: "assistant",
          content: message.content
            .filter((block) => block.type === "text"
              || block.type === "reasoning"
              || block.type === "tool-call")
            .map((block) => block.type === "tool-call"
              ? {
                  type: "tool-call",
                  id: block.id,
                  name: block.name,
                  arguments: block.arguments
                }
              : { type: block.type, text: block.text })
        });
      }
      continue;
    }

    const toolResults = message.content.filter((block) => block.type === "tool-result");
    const userBlocks = message.content.filter((block) => block.type !== "tool-result");
    for (const result of toolResults) await appendToolResult(result);

    const text = requestPlanText(userBlocks);
    const hasImages = userBlocks.some((block) => block.type === "image");
    if (userBlocks.length > 0 && (text.length > 0 || hasImages)) {
      flushToolImages();
      entries.push({
        type: "user",
        content: await appendUserContent(userBlocks)
      });
    } else if (toolResults.length === 0) {
      flushToolImages();
      entries.push({ type: "user", content: [] });
    }
  }
  flushToolImages();

  return freezePlanValue({
    entries,
    requestImages
  });
}
//#endregion
