// Tinfoil web search as native pi tools.
//
// Registers `web_search` and `fetch` tools backed by Tinfoil's confidential web-search
// MCP server (search runs in a secure enclave, ZDR via Exa). Uses the Tinfoil JS SDK's
// SecureClient for attested, end-to-end-encrypted requests — the MCP transport rides on
// top of SecureClient.fetch so the enclave verifies before connecting.
//
// The tool result `content` carries full snippets for the model; a slim `details` drives
// a compact, expandable card (query + result list) so the UI stays readable.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SecureClient } from "tinfoil";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const ENCLAVE_URL = "https://websearch.tinfoil.sh";
const CONFIG_REPO = "tinfoilsh/confidential-websearch";

// Resolve a pi config value (apiKey / header) the same way pi does:
//   "!cmd"    -> run the command, return trimmed stdout (e.g. macOS keychain)
//   "$VAR"    -> process.env.VAR
//   "${VAR}"  -> process.env.VAR
//   "$$"      -> literal "$"
//   "$!"      -> literal "!"
//   otherwise -> literal value
// Missing env vars are left unresolved (pi behavior).
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

function resolveApiKey() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8"),
    );
    const raw = cfg?.providers?.tinfoil?.apiKey;
    if (!raw || typeof raw !== "string") return undefined;
    return resolvePiValue(raw);
  } catch {
    return undefined;
  }
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Lazily create a verified MCP client. SecureClient performs attestation on first
// ready(); the dedup promise caches it so the first tool call pays the cost.
let clientPromise = null;

async function getClient(signal) {
  if (clientPromise) return clientPromise;

  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error(
      "No Tinfoil API key (set providers.tinfoil.apiKey in models.json — supports !command, $ENV, or literal).",
    );
  }

  clientPromise = (async () => {
    const secure = new SecureClient({
      enclaveURL: ENCLAVE_URL,
      configRepo: CONFIG_REPO,
    });
    await secure.ready();

    // getEnclaveURL() returns the enclave root (e.g. "https://websearch.tinfoil.sh").
    // getBaseURL() returns the OpenAI-compatible API base (".../v1/"), which 404s for /mcp.
    const transport = new StreamableHTTPClientTransport(
      new URL(secure.getEnclaveURL() + "/mcp"),
      {
        fetch: secure.fetch,
        requestInit: {
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    );

    const client = new Client({
      name: "pi-tinfoil-websearch",
      version: "1",
    });
    await client.connect(transport);
    return client;
  })();

  try {
    return await clientPromise;
  } catch (err) {
    clientPromise = null;
    throw err;
  }
}

async function mcpCall(toolName, args, signal) {
  const client = await getClient(signal);
  const result = await client.callTool(
    { name: toolName, arguments: args },
    undefined,
    { signal },
  );
  const text = (result.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (result.isError) {
    throw new Error(text || "Web search tool returned an error.");
  }
  return { text, structured: result.structuredContent };
}

const SEARCH_PARAMS = Type.Object({
  query: Type.String({ description: "The web search query." }),
  max_results: Type.Optional(
    Type.Number({ description: "Maximum number of results to return." }),
  ),
  category: Type.Optional(
    Type.String({
      description: "Narrow to a category, e.g. 'news' or 'research paper'.",
    }),
  ),
  max_age_hours: Type.Optional(
    Type.Number({
      description: "Only return results published within the last N hours.",
    }),
  ),
});

const FETCH_PARAMS = Type.Object({
  urls: Type.Array(Type.String(), {
    description: "HTTP/HTTPS URLs to fetch and read as markdown (max 20).",
  }),
});

export default function tinfoilWebSearch(pi) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for current, real-time, or post-training information via Tinfoil's confidential search. " +
      "Returns ranked results with titles, URLs, publish dates, and content snippets. Cite sources as markdown links.",
    promptSnippet:
      "Use web_search for anything needing current or real-time information, then cite sources inline.",
    parameters: SEARCH_PARAMS,
    async execute(_toolCallId, params, signal) {
      const r = await mcpCall("search", params, signal);
      const results = r.structured?.results ?? [];
      const modelText = results.length
        ? results
            .map((x, i) => {
              const date = x.published_date ? ` — ${x.published_date}` : "";
              return `${i + 1}. [${x.title || x.url}](${x.url})${date}\n${(x.content || "").trim()}`;
            })
            .join("\n\n")
        : r.text || "No results.";
      return {
        content: [{ type: "text", text: modelText }],
        details: {
          query: params.query,
          results: results.map((x) => ({
            title: x.title,
            url: x.url,
            published_date: x.published_date,
          })),
        },
      };
    },
    renderCall(args, theme, ctx) {
      let line = theme.fg("toolTitle", theme.bold("web_search"));
      if (args?.query) line += ` ${theme.fg("muted", `"${args.query}"`)}`;
      if (ctx?.expanded) {
        const extras = Object.entries(args ?? {})
          .filter(
            ([k, v]) =>
              k !== "query" && v !== undefined && v !== null && v !== "",
          )
          .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`);
        if (extras.length) line += `  ${theme.fg("dim", extras.join("  "))}`;
      }
      return new Text(line, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      if (!details || !details.results) {
        const text = result.content?.[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      const results = details.results;
      if (results.length === 0)
        return new Text(theme.fg("dim", "No results"), 0, 0);

      let out = theme.fg(
        "muted",
        `${results.length} result${results.length === 1 ? "" : "s"}`,
      );
      const shown = expanded ? results : results.slice(0, 2);
      shown.forEach((x, i) => {
        const domain = hostname(x.url);
        const title = x.title || x.url;
        out += `\n${theme.fg("accent", `${i + 1}.`)} ${theme.fg("muted", title)}${domain ? ` ${theme.fg("dim", domain)}` : ""}`;
      });
      if (!expanded && results.length > 2) {
        out += `\n${theme.fg("dim", `… ${results.length - 2} more`)}`;
      }
      return new Text(out, 0, 0);
    },
  });

  pi.registerTool({
    name: "fetch",
    label: "Fetch Page",
    description:
      "Fetch one or more web pages and return their rendered markdown content for deeper reading. Use after web_search to read a specific result.",
    promptSnippet:
      "Use fetch to read the full content of a URL surfaced by web_search.",
    parameters: FETCH_PARAMS,
    async execute(_toolCallId, params, signal) {
      const r = await mcpCall("fetch", { urls: params.urls }, signal);
      const pages = r.structured?.pages ?? r.structured?.results ?? [];
      const modelText = pages.length
        ? pages
            .map((p) => `# ${p.url}\n${(p.content || p.error || "").trim()}`)
            .join("\n\n---\n\n")
        : r.text || "No content.";
      return {
        content: [{ type: "text", text: modelText }],
        details: {
          pages: pages.map((p) => ({
            url: p.url,
            chars: (p.content || "").length,
            error: p.error,
          })),
        },
      };
    },
    renderCall(args, theme) {
      const n = args?.urls?.length || 0;
      let line = theme.fg("toolTitle", theme.bold("fetch"));
      if (n === 1) line += ` ${theme.fg("muted", args.urls[0])}`;
      else if (n > 1) line += ` ${theme.fg("muted", `${n} pages`)}`;
      return new Text(line, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      if (!details || !details.pages) {
        const text = result.content?.[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      const pages = details.pages;
      let out = theme.fg(
        "muted",
        `${pages.length} page${pages.length === 1 ? "" : "s"} fetched`,
      );
      const shown = expanded ? pages : pages.slice(0, 2);
      for (const p of shown) {
        const meta = p.error
          ? theme.fg("error", "failed")
          : theme.fg("dim", `${p.chars} chars`);
        out += `\n${theme.fg("accent", "•")} ${theme.fg("muted", hostname(p.url) || p.url)} ${meta}`;
      }
      if (!expanded && pages.length > 2) {
        out += `\n${theme.fg("dim", `… ${pages.length - 2} more`)}`;
      }
      return new Text(out, 0, 0);
    },
  });
}
