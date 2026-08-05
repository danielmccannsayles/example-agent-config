/**
 * aborted-thinking-replay pi extension
 *
 * Problem: transformMessages (pi-ai) drops assistant messages with
 * stopReason === "aborted" entirely — including any thinking and partial text
 * the model produced before the user hit escape. The thinking IS persisted to
 * the session file (message_end fires on abort, appendMessage has no stopReason
 * guard) and the thinking-signature-backfill extension already backfills
 * signatures on it. But on the next turn, transform-messages.js:156 does
 *   if (stopReason === "error" || stopReason === "aborted") continue;
 * so the model never sees its prior reasoning and re-derives from scratch.
 *
 * Fix: in the `context` hook (which receives a structuredClone from
 * runner.emitContext — non-destructive to the session file), un-drop aborted
 * assistant messages so they're replayed.
 *
 * Tool calls: the agent loop (agent-loop.js:107) returns before executing tools
 * when stopReason === "aborted", and a completed tool-call response gets
 * stopReason "toolUse" (openai-responses-shared.js:457-458), not "aborted".
 * So aborted messages only ever contain partial (mid-stream) tool calls with no
 * matching toolResults. We strip all tool calls and preserve the thinking + text
 * that preceded them.
 *
 * Trailing thinking: converted to text to avoid "reasoning without following
 * item" API errors. Non-trailing thinking (e.g. [thinking, text]) already has
 * a signature (backfilled at message_end) and replays as a reasoning item.
 *
 * Scoped to openai-responses — matches the signature backfill extension's scope.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function undropAborted(message: any): boolean {
  if (message?.role !== "assistant" || message.stopReason !== "aborted")
    return false;
  if (message.api && message.api !== "openai-responses") return false;
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return false;

  // Strip all tool calls. Aborted messages only contain partial (mid-stream)
  // tool calls with no matching toolResults (the agent loop never executes
  // tools for aborted messages). Completed tool calls get stopReason "toolUse".
  message.content = content.filter((b: any) => b.type !== "toolCall");

  // Convert trailing thinking blocks to text. A trailing reasoning item with
  // no following message/tool item can trigger "reasoning without following
  // item"; converting to text preserves the content safely.
  const newContent = message.content;
  for (let i = newContent.length - 1; i >= 0; i--) {
    const block = newContent[i];
    if (block.type !== "thinking") break;
    const text = block.thinking?.trim();
    if (text) {
      newContent[i] = { type: "text", text: block.thinking };
    } else {
      newContent.splice(i, 1);
    }
  }

  // If nothing's left (was only tool calls + empty thinking), leave it dropped.
  if (newContent.length === 0) return false;

  message.stopReason = "stop";
  return true;
}

export default function (pi: ExtensionAPI) {
  pi.on("context", (event) => {
    let modified = false;
    for (const message of event.messages) {
      if (undropAborted(message)) {
        modified = true;
      }
    }
    if (modified) {
      return { messages: event.messages };
    }
  });
}
