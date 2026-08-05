#!/usr/bin/env node
// compile-prompt.mjs — assemble and output the exact prompt an agent sees.
//
// Run: node compile-prompt.mjs [claude|pi]
// Outputs the assembled prompt (with @imports expanded) to prompt.md (gitignored).
//
// For claude: reads claude/CLAUDE.md, expands @import (Claude's native syntax).
// For pi: reads pi/agent/AGENTS.md, expands @import (same logic as imports.ts).

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const REPO = execSync("git rev-parse --show-toplevel", {
  encoding: "utf-8",
}).trim();
const agent = process.argv[2];

if (!agent || !["claude", "pi", "codex"].includes(agent)) {
  console.error("Usage: node compile-prompt.mjs [claude|pi|codex]");
  process.exit(1);
}

const INDEX_FILE =
  agent === "claude"
    ? "claude/CLAUDE.md"
    : agent === "pi"
      ? "pi/agent/AGENTS.md"
      : "codex/AGENTS.md";

const IMPORT_RE = /^(\s*)@(~?\/[^\s`]+|\.\/[^\s`]+|\.\.\/[^\s`]+)\s*$/;

function resolveImportPath(importPath, baseDir) {
  // The index files import @~/agents/... (absolute, so they resolve through the
  // ~/.claude / ~/.pi symlinks). Map ~/agents/ to this checkout so the script
  // works wherever the repo lives; other ~/ paths resolve to $HOME as usual.
  if (importPath.startsWith("~/agents/"))
    return join(REPO, importPath.slice("~/agents/".length));
  if (importPath.startsWith("~/")) return join(homedir(), importPath.slice(2));
  if (isAbsolute(importPath)) return importPath;
  return resolve(baseDir, importPath);
}

function expandImports(content, baseDir, depth = 0, seen = new Set()) {
  if (depth >= 5) return content;
  const lines = content.split("\n");
  const out = [];
  let inCodeFence = false;

  for (const line of lines) {
    if (line.match(/^\s*(`{3,}|~{3,})/)) {
      inCodeFence = !inCodeFence;
      out.push(line);
      continue;
    }
    if (inCodeFence) {
      out.push(line);
      continue;
    }

    const m = line.match(IMPORT_RE);
    if (!m) {
      out.push(line);
      continue;
    }

    const importPath = resolveImportPath(m[2], baseDir);
    if (!importPath) {
      out.push(line);
      continue;
    }
    if (seen.has(importPath)) {
      out.push(`<!-- @import cycle: ${importPath} — skipped -->`);
      continue;
    }

    let fileContent;
    try {
      fileContent = readFileSync(importPath, "utf-8");
    } catch {
      out.push(`<!-- @import not found: ${importPath} -->`);
      continue;
    }

    seen.add(importPath);
    const expanded = expandImports(
      fileContent,
      importPath.replace(/[^/]+$/, ""),
      depth + 1,
      seen,
    );
    seen.delete(importPath);

    out.push(expanded);
  }

  return out.join("\n");
}

const indexContent = readFileSync(join(REPO, INDEX_FILE), "utf-8");
const assembled = expandImports(
  indexContent,
  join(REPO, INDEX_FILE).replace(/[^/]+$/, ""),
);

const outPath = join(REPO, "prompt.md");
writeFileSync(outPath, assembled);
console.log(
  `Assembled ${agent} prompt → ${outPath} (${assembled.split("\n").length} lines, ${assembled.length} chars)`,
);
