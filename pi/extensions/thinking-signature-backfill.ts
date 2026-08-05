/**
 * thinking-signature-backfill pi extension
 *
 * Problem: Some openai-responses providers (e.g. Tinfoil/vLLM with GLM-5.2) don't
 * emit response.output_item.done for reasoning-only responses (thinking + stop,
 * no text/tool). When the model produces only reasoning and stops, or when the
 * stream is aborted mid-thinking, the thinking block is persisted without a
 * thinkingSignature. On the next turn, convertResponsesMessages silently drops
 * unsigned thinking blocks — the model loses its prior reasoning and re-derives
 * from scratch.
 *
 * Fix: Two hooks:
 * 1. message_end — backfill thinkingSignature on the finalized assistant message
 *    before it's persisted to the session file. Fixes new messages.
 * 2. context — backfill thinkingSignature on messages before each LLM call.
 *    Fixes old session data that already has missing signatures.
 *
 * The synthesized signature matches the format that processResponsesStream
 * creates from response.output_item.done:
 *   { id, summary: [], type: "reasoning", content: [{type:"reasoning_text",text}],
 *     encrypted_content: null, status: "completed" }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function hashId(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return `rs_pi_${Math.abs(h).toString(36)}`;
}

function backfillMessage(message: any): boolean {
  if (message?.role !== "assistant") return false;
  // Only backfill for openai-responses — Anthropic/Bedrock use thinkingSignature
  // as an opaque blob, not a JSON reasoning item.
  if (message.api && message.api !== "openai-responses") return false;
  const content = message.content;
  if (!Array.isArray(content)) return false;

  let modified = false;
  for (const block of content) {
    if (
      block?.type === "thinking" &&
      !block.thinkingSignature &&
      block.thinking?.trim()
    ) {
      block.thinkingSignature = JSON.stringify({
        id: hashId(block.thinking),
        summary: [],
        type: "reasoning",
        content: [{ type: "reasoning_text", text: block.thinking }],
        encrypted_content: null,
        status: "completed",
      });
      modified = true;
    }
  }
  return modified;
}

export default function (pi: ExtensionAPI) {
  // Fix new messages: backfill before persistence
  pi.on("message_end", (event) => {
    const message = event.message;
    if (backfillMessage(message)) {
      return { message };
    }
  });

  // Fix old session data: backfill before each LLM call
  pi.on("context", (event) => {
    let modified = false;
    for (const message of event.messages) {
      if (backfillMessage(message)) {
        modified = true;
      }
    }
    if (modified) {
      return { messages: event.messages };
    }
  });
}
