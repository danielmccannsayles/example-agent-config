// @import expansion for pi.
//
// pi reads CLAUDE.md / APPEND_SYSTEM.md as flat text — no native @import support.
// This extension processes @path tokens (the same syntax Claude Code uses) in
// before_agent_start, expanding them inline. Supports ~/, /, ./, and ../ paths.
// Recursive (imports can import), with a depth limit and cycle detection.
//
// Path syntax (matches Claude Code):
//   @~/agents/fragments/preferences.md   → homedir-relative
//   @/abs/path/file.md                    → absolute
//   @./relative/file.md                   → relative to importing file
//   @../relative/file.md                  → relative to importing file
//
// Code spans (`@path`) and fenced code blocks are skipped.

import { readFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_DEPTH = 5;

// Match @path at start of a line (after optional whitespace).
// Path must start with ~/, /, ./, or ../ to avoid matching @mentions, @emails, etc.
const IMPORT_RE = /^(\s*)@(~?\/[^\s`]+|\.\/[^\s`]+|\.\.\/[^\s`]+)\s*$/;

function resolveImportPath(importPath: string, baseDir: string): string | null {
  if (importPath.startsWith("~/")) {
    return join(homedir(), importPath.slice(2));
  }
  if (isAbsolute(importPath)) {
    return importPath;
  }
  // ./ or ../
  return resolve(baseDir, importPath);
}

function expandImports(
  content: string,
  baseDir: string,
  depth: number,
  seen: Set<string>,
): string {
  if (depth >= MAX_DEPTH) return content;

  const lines = content.split("\n");
  const out: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    // Track fenced code blocks (``` or ~~~)
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
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

    // Cycle detection
    if (seen.has(importPath)) {
      out.push(`<!-- @import cycle detected: ${importPath} — skipped -->`);
      continue;
    }

    let fileContent: string;
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

export default function importsExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const opts = event.systemPromptOptions;
    if (!opts?.contextFiles || opts.contextFiles.length === 0) return;

    let prompt = event.systemPrompt;
    let changed = false;

    for (const cf of opts.contextFiles) {
      if (!cf.content || !cf.content.includes("@")) continue;
      const baseDir = cf.path ? cf.path.replace(/[^/]+$/, "") : process.cwd();
      const expanded = expandImports(cf.content, baseDir, 0, new Set());
      if (expanded === cf.content) continue;
      prompt = prompt.replace(cf.content, expanded);
      changed = true;
    }

    if (!changed) return;
    return { systemPrompt: prompt };
  });
}
