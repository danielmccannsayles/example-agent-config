// Describe images for non-vision models via a Tinfoil vision model.
//
// When the active model can't see images (e.g. GLM-5.2, input:["text"]), pi's
// transform-messages step replaces every image block with the literal string
// "(image omitted: model does not support images)" before the request is sent.
// This extension hooks the `context` event — which fires per LLM call, BEFORE
// that downgrade — and, for text-only models, describes each image via a
// Tinfoil vision model (gemma4-31b by default), replacing the image block with
// the description text. Mirrors tinfoil-webapp's client-side
// describeImageWithMultimodal flow.
//
// Vision-capable models (input includes "image") are left untouched: images
// pass through natively. Descriptions are cached per image hash for the process
// lifetime so repeated turns don't re-describe.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VISION_MODEL = process.env.TINFOIL_VISION_MODEL || "gemma4-31b";
const DESCRIBE_TIMEOUT_MS = 60_000;
const FAILURE_TTL_MS = 30_000;

// Describe the image for a coding agent that cannot see it. The output is
// treated as ground-truth content. Lead with a structural description (what
// the image IS — a dark-background screenshot, a terminal, a diagram) so the
// downstream text-only model understands it's rendered content, not a vision
// model's editorializing. Then quote all visible text verbatim with styling
// notes, so lines like an italic thinking block don't read as commentary.
const DESCRIBE_PROMPT = [
  "Describe this image for a coding agent that cannot see it. Your output will be",
  "fed verbatim to a text-only model — it must be factual and complete.",
  "",
  "Format your response in two parts:",
  "",
  "1. STRUCTURE (1-3 sentences): What kind of image is this? (terminal screenshot,",
  "   code editor, chat UI, diagram, chart, photo, etc.) Describe the visual",
  "   context: background color, layout, regions, text styling (italic, bold,",
  "   colored, dimmed), and where things are positioned. This orients the reader.",
  "",
  "2. VISIBLE TEXT (verbatim): Reproduce ALL text visible in the image EXACTLY —",
  "   code, commands, file paths, URLs, error messages, stack traces, log lines,",
  "   labels, captions. Exact characters, line breaks, and indentation. If a line",
  "   has distinct styling (italic, dimmed, a different color), note that inline",
  "   like: (italic, dimmed) the text. If the image is mostly text, quote each line.",
  "",
  "Rules:",
  "- Do NOT guess intent, interpret meaning, or characterize the user.",
  '- Do NOT add commentary like "Also", "It appears", "The user is being".',
  '- Do NOT say "The image shows" or "I can see" — just describe.',
  "- If text is cut off at an edge, note it: (cut off)",
  "- Color: only mention when it carries meaning (status colors, syntax highlighting).",
  "",
  "Example output for a terminal screenshot:",
  "Dark-background terminal screenshot. Two lines of monospaced text.",
  '(italic, dimmed) Also "hewwo" – Daniel being playful. Let me retry web_sea',
  "Hewwo! Let me retry websearch now.",
].join("\n");

// Resolve a pi config value the same way pi does:
//   "!cmd"    -> run the command, return trimmed stdout (e.g. macOS keychain)
//   "$VAR"    -> process.env.VAR
//   "${VAR}"  -> process.env.VAR
//   "$$"      -> literal "$"
//   "$!"      -> literal "!"
//   otherwise -> literal value
function resolvePiValue(value) {
  if (value.startsWith("!")) {
    const cmd = value.slice(1);
    try {
      return execSync(cmd, {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch (err) {
      throw new Error(`apiKey command failed: ${cmd} (${err.message})`);
    }
  }
  return value.replace(
    /\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, plain) => {
      if (match === "$$") return "$";
      if (match === "$!") return "!";
      const name = braced || plain;
      return process.env[name] ?? match;
    },
  );
}

let cachedConfig = null;
function resolveTinfoilConfig() {
  if (cachedConfig) return cachedConfig;
  const cfg = JSON.parse(
    readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8"),
  );
  const provider = cfg?.providers?.tinfoil;
  if (!provider)
    throw new Error("No tinfoil provider in ~/.pi/agent/models.json");
  const apiKey = provider.apiKey ? resolvePiValue(provider.apiKey) : "";
  if (!apiKey)
    throw new Error(
      "No tinfoil apiKey configured (providers.tinfoil.apiKey in models.json)",
    );
  const baseUrl = (provider.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl)
    throw new Error(
      "No tinfoil baseUrl configured (providers.tinfoil.baseUrl in models.json)",
    );
  const endpoint =
    process.env.TINFOIL_VISION_URL || `${baseUrl}/chat/completions`;
  cachedConfig = { apiKey, endpoint };
  return cachedConfig;
}

// cache: image hash -> { ok: true, text } | { ok: false, text, ts }
const cache = new Map();

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

async function fetchDescription(image, ctx, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DESCRIBE_TIMEOUT_MS);
  const signal = ctx?.signal;
  if (signal) {
    if (signal.aborted) controller.abort();
    else
      signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }
  try {
    const res = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: DESCRIBE_PROMPT },
              {
                type: "image_url",
                image_url: {
                  url: `data:${image.mimeType};base64,${image.data}`,
                },
              },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      const detail = errBody ? `: ${errBody.slice(0, 200)}` : "";
      throw new Error(`vision model HTTP ${res.status}${detail}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((c) => c?.type === "text")
              .map((c) => c.text)
              .join("\n")
          : "";
    if (!text.trim()) throw new Error("vision model returned empty content");
    return { ok: true, text };
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? `timed out after ${DESCRIBE_TIMEOUT_MS / 1000}s`
        : err?.message || String(err);
    return { ok: false, text: msg };
  } finally {
    clearTimeout(timeout);
  }
}

async function describeImage(image, ctx) {
  const key = sha256(`${image.mimeType}:${image.data}`);
  const cached = cache.get(key);
  if (cached) {
    // Successes are cached for the process lifetime; failures expire so a
    // transient outage (e.g. cold start, network blip) self-heals.
    if (cached.ok || Date.now() - cached.ts < FAILURE_TTL_MS) return cached;
    cache.delete(key);
  }
  const result = await fetchDescription(image, ctx, resolveTinfoilConfig());
  cache.set(key, result.ok ? result : { ...result, ts: Date.now() });
  return result;
}

function isImageBlock(block) {
  return (
    block &&
    typeof block === "object" &&
    block.type === "image" &&
    typeof block.data === "string"
  );
}

// The read tool appends this to image tool-results when the active model is
// text-only. Once this extension replaces the image with a description, the
// note is stale and contradictory ("will be omitted" — but we just included a
// description). Strip it from sibling text blocks in any message we touch.
const STALE_IMAGE_NOTE =
  /\n?\[Current model does not support images\. The image will be omitted from this request\.\]/;

export default function tinfoilImageDescribe(pi) {
  pi.on("context", async (event, ctx) => {
    const model = ctx?.model;
    // Vision-capable model: let images pass through natively.
    if (model?.input?.includes("image")) return;

    // Fast path: scan for any image block. If none, no-op (avoids cloning work
    // on the common no-image turn).
    let hasImage = false;
    for (const msg of event.messages) {
      if (Array.isArray(msg.content) && msg.content.some(isImageBlock)) {
        hasImage = true;
        break;
      }
    }
    if (!hasImage) return;

    // Collect every image block ref (deduped by hash) so we can describe them
    // in parallel, then splice text blocks back in.
    const unique = new Map(); // hash -> { image, ctx }
    const targets = []; // { msg, blockIdx }
    for (const msg of event.messages) {
      if (msg.role !== "user" && msg.role !== "toolResult") continue;
      if (!Array.isArray(msg.content)) continue;
      msg.content.forEach((block, i) => {
        if (!isImageBlock(block)) return;
        targets.push({ msg, blockIdx: i });
        const hash = sha256(`${block.mimeType}:${block.data}`);
        if (!unique.has(hash)) unique.set(hash, block);
      });
    }
    if (targets.length === 0) return;

    // Describe unique images in parallel.
    const results = new Map(); // hash -> { ok, text }
    await Promise.all(
      [...unique.values()].map(async (image) => {
        const r = await describeImage(image, ctx);
        results.set(sha256(`${image.mimeType}:${image.data}`), r);
      }),
    );

    // Rebuild each affected message's content array, swapping image blocks for
    // text blocks. event.messages is a deep clone (pi guarantees this), so
    // mutating in place is safe.
    const touched = new Set();
    for (const { msg, blockIdx } of targets) {
      if (touched.has(msg)) continue;
      touched.add(msg);
      msg.content = msg.content.map((block) => {
        if (isImageBlock(block)) {
          const hash = sha256(`${block.mimeType}:${block.data}`);
          const r = results.get(hash);
          if (r?.ok) {
            const label = `[Image content below — exact text and elements visible in the image:]`;
            return { type: "text", text: `${label}\n${r.text}` };
          }
          const detail = r?.text || "unknown error";
          return {
            type: "text",
            text: `[Image attachment — description unavailable: ${detail}]`,
          };
        }
        // Strip the stale "will be omitted" note from sibling text blocks —
        // we're providing a description, so the image is NOT being omitted.
        if (block.type === "text" && STALE_IMAGE_NOTE.test(block.text)) {
          return { ...block, text: block.text.replace(STALE_IMAGE_NOTE, "") };
        }
        return block;
      });
    }

    return { messages: event.messages };
  });
}
