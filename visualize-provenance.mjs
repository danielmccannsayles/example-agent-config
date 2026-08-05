#!/usr/bin/env node
// Visualize what's encrypted on GitHub and what each agent sees.
//
// Run: node visualize-provenance.mjs
// Opens a browser with the visualization.
//
// Encryption status is checked empirically through git blob content -
// git-crypt blobs start with the \x00GITCRYPT magic header.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";

const REPO = execSync("git rev-parse --show-toplevel", {
  encoding: "utf-8",
}).trim();
const GITCRYPT_MAGIC = Buffer.from([
  0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54,
]); // \x00GITCRYPT

// ── 1. Get all tracked files ──────────────────────────────────────────────
const IGNORE_PATTERNS = [
  /^claude\/plugins\//, // plugin cache/config, not interesting
  /^pi\/agent\/npm\//, // npm deps, not interesting
];

const trackedFiles = execSync("git ls-files", { cwd: REPO, encoding: "utf-8" })
  .trim()
  .split("\n")
  .filter(Boolean)
  .filter((f) => !IGNORE_PATTERNS.some((p) => p.test(f)));

// ── 2. Check encryption status empirically (git blob content) ─────────────
function isEncrypted(filepath) {
  // Check staged index first, then HEAD. The index reflects uncommitted
  // .gitattributes changes (e.g. newly encrypted files not yet committed).
  for (const ref of [`:${filepath}`, `HEAD:${filepath}`]) {
    try {
      const blob = execSync(`git cat-file -p ${ref}`, {
        cwd: REPO,
        encoding: "buffer",
        stdio: ["pipe", "pipe", "ignore"],
      });
      return blob.subarray(0, GITCRYPT_MAGIC.length).equals(GITCRYPT_MAGIC);
    } catch {
      /* try next ref */
    }
  }
  return false;
}

// ── 3. Parse @import chains ───────────────────────────────────────────────
const IMPORT_RE = /^(\s*)@(~?\/[^\s`]+|\.\/[^\s`]+|\.\.\/[^\s`]+)\s*$/;

function resolveImportPath(importPath, baseDir) {
  // ~/agents/ maps to this checkout (see compile-prompt.mjs); other ~/ → $HOME.
  if (importPath.startsWith("~/agents/"))
    return join(REPO, importPath.slice("~/agents/".length));
  if (importPath.startsWith("~/")) return join(homedir(), importPath.slice(2));
  if (isAbsolute(importPath)) return importPath;
  return resolve(baseDir, importPath);
}

function parseImports(filepath) {
  const fullPath = resolve(REPO, filepath);
  let content;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    return [];
  }
  const imports = [];
  let inCodeFence = false;
  for (const line of content.split("\n")) {
    if (line.match(/^\s*(`{3,}|~{3,})/)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    const m = line.match(IMPORT_RE);
    if (!m) continue;
    const resolved = resolveImportPath(m[2], fullPath.replace(/[^/]+$/, ""));
    const relPath = relative(REPO, resolved);
    if (relPath && !relPath.startsWith("..")) {
      imports.push(relPath);
      imports.push(...parseImports(relPath));
    }
  }
  return [...new Set(imports)];
}

// ── 4. ~50-char snippet of a file's content ───────────────────────────────
function snippet(filepath) {
  try {
    const content = readFileSync(resolve(REPO, filepath), "utf-8").trim();
    const body = content.replace(/^---[\s\S]*?---\n?/, ""); // skip frontmatter
    const oneline = body.replace(/\n+/g, " ").trim();
    return oneline.length > 50 ? oneline.slice(0, 50) + " …" : oneline;
  } catch {
    return "";
  }
}

// ── 5. Build the data ─────────────────────────────────────────────────────
const claudeImports = parseImports("claude/CLAUDE.md");
const piImports = parseImports("pi/agent/AGENTS.md");
const codexImports = parseImports("codex/AGENTS.md");

// ── 5b. Claude access (information-guard sandbox) ──────────────────────────────────
// The sandbox blocks read AND write at the kernel level (sandbox-exec EPERM).
// The git guard blocks commit/push for the entire repo (applies to all files
// equally, so shown as a note rather than per-file).
// Pi is never sandboxed — it can always read everything.
// Claude is sandboxed via `information-guard-sandbox` (wraps the whole process).
// Codex is sandboxed via its own native Seatbelt sandbox (same kernel
// mechanism), configured in ~/.codex/config.toml — NOT via information-guard-sandbox
let protectedPaths = [];
try {
  const config = JSON.parse(
    readFileSync(
      join(homedir(), ".config/information-guard/sandbox.json"),
      "utf-8",
    ),
  );
  protectedPaths = (config.protectedPaths || []).map((p) =>
    p.replace(/^~\//, homedir() + "/"),
  );
} catch {}

let protectedRepos = [];
try {
  const text = readFileSync(
    join(homedir(), ".config/information-guard/repos.txt"),
    "utf-8",
  );
  protectedRepos = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((p) => p.replace(/^~\//, homedir() + "/"));
} catch {}

function isClaudeBlocked(filepath) {
  const fullPath = resolve(REPO, filepath);
  return protectedPaths.some(
    (p) => fullPath === p || fullPath.startsWith(p + "/"),
  );
}

const repoGitGuarded = protectedRepos.some(
  (r) => REPO === r || REPO.startsWith(r + "/"),
);

const allFiles = trackedFiles.map((f) => ({
  path: f,
  encrypted: isEncrypted(f),
  inClaude: claudeImports.includes(f),
  inPi: piImports.includes(f),
  inCodex: codexImports.includes(f),
  agentBlocked: isClaudeBlocked(f),
}));

const encCount = allFiles.filter((f) => f.encrypted).length;
const plainCount = allFiles.length - encCount;

// Per-agent status: "prompt" (in @import chain), "read" (can read, not in
// prompt), or "blocked" (sandbox prevents reading — Claude only; pi is never
// sandboxed). A file can be encrypted on GitHub but still readable locally
// (e.g. claude/memory — encrypted, but Claude can read its own memories).
function piStatus(f) {
  return f.inPi ? "prompt" : null;
}
function claudeStatus(f) {
  if (f.inClaude) return "prompt";
  if (f.agentBlocked) return "blocked";
  return "read";
}
function codexStatus(f) {
  if (f.inCodex) return "prompt";
  if (f.agentBlocked) return "blocked";
  return "read";
}

// ── 6. Build a tree grouped by directory ──────────────────────────────────
function buildTree(files) {
  const tree = {};
  for (const f of files) {
    const parts = f.path.split("/");
    const name = parts.pop();
    const dir = parts.join("/") || ".";
    if (!tree[dir]) tree[dir] = [];
    tree[dir].push({ name, ...f });
  }
  const rank = (d) => {
    if (d.startsWith("fragments")) return 0;
    if (d.includes("memory")) return 1;
    return 2;
  };
  return Object.keys(tree)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((d) => ({
      dir: d,
      files: tree[d].sort((a, b) => a.name.localeCompare(b)),
    }));
}

function badge(encrypted) {
  return encrypted
    ? '<span class="badge enc">enc</span>'
    : '<span class="badge plain">plain</span>';
}

const STATUS_TITLES = {
  prompt: "in system prompt via @import",
  read: "can read, not in prompt",
  blocked: "information-guard sandbox blocks read/write",
  mixed: "mixed statuses in this dir",
};

function agentBadge(agent, status) {
  if (!status) return "";
  return `<span class="agent ${agent}-${status}" title="${agent}: ${STATUS_TITLES[status] || status}">${agent}: ${status}</span>`;
}

function aggregateStatus(statuses) {
  const unique = [...new Set(statuses)];
  if (unique.length === 1) return unique[0];
  return "mixed";
}

function fileLeaf(f) {
  const snip = snippet(f.path);
  const pi = agentBadge("pi", piStatus(f));
  const claude = agentBadge("claude", claudeStatus(f));
  const codex = agentBadge("codex", codexStatus(f));
  return `      <div class="leaf">
        <span class="fname">${f.name}</span> ${badge(f.encrypted)} ${pi} ${claude} ${codex} <span class="snip">${snip}</span>
      </div>`;
}

function dirBranch(group) {
  const allEnc = group.files.every((f) => f.encrypted);
  const allPlain = group.files.every((f) => !f.encrypted);
  const dirBadge = allEnc
    ? '<span class="badge enc">enc</span>'
    : allPlain
      ? '<span class="badge plain">plain</span>'
      : '<span class="badge mixed">mixed</span>';
  const piAgg = aggregateStatus(group.files.map(piStatus));
  const claudeAgg = aggregateStatus(group.files.map(claudeStatus));
  const codexAgg = aggregateStatus(group.files.map(codexStatus));
  // Collapse if all files share the same encryption + pi status + claude status.
  const uniform =
    (allEnc || allPlain) &&
    piAgg !== "mixed" &&
    claudeAgg !== "mixed" &&
    codexAgg !== "mixed";
  const count = group.files.length;
  const summary = `    <summary class="dir">${group.dir}/ ${dirBadge} ${agentBadge("pi", piAgg)} ${agentBadge("claude", claudeAgg)} ${agentBadge("codex", codexAgg)} <span class="count">${count} file${count > 1 ? "s" : ""}</span></summary>`;
  return `  <details class="branch"${uniform ? "" : " open"}>
${summary}
    <div class="leaves">
${group.files.map(fileLeaf).join("\n")}
    </div>
  </details>`;
}

const tree = buildTree(allFiles);

// ── 7. Generate HTML ─────────────────────────────────────────────────────
const blockedCount = allFiles.filter((f) => f.agentBlocked).length;
const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Agent Config Provenance</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; margin-bottom: .3rem; }
  .summary { display: flex; gap: .8rem; margin: 1rem 0 1.5rem; }
  .stat { background: #f5f5f5; padding: .4rem .8rem; border-radius: 6px; font-size: .8rem; }
  .stat strong { font-size: 1.1rem; display: block; }
  .note { font-size: .75rem; color: #888; margin-bottom: 1.5rem; }
  .branch { margin-bottom: .5rem; }
  .dir { font-family: monospace; font-size: .85rem; font-weight: 600; color: #333; margin-bottom: .2rem; cursor: pointer; }
  .count { font-weight: 400; color: #999; font-size: .75rem; }
  .leaves { margin-left: 1.2rem; }
  .leaf { margin-bottom: .2rem; display: flex; align-items: baseline; gap: .3rem; flex-wrap: wrap; }
  .fname { font-family: monospace; font-size: .8rem; color: #555; }
  .snip { font-size: .75rem; color: #aaa; line-height: 1.3; }
  .badge { font-size: .65rem; padding: .05rem .3rem; border-radius: 3px; font-weight: 600; }
  .enc { background: #e8f5e9; color: #2e7d32; }
  .plain { background: #fee; color: #c33; }
  .mixed { background: #fff3e0; color: #e65100; }
  .agent { font-size: .65rem; padding: .05rem .25rem; border-radius: 3px; margin-left: .15rem; font-weight: 600; white-space: nowrap; }
  .pi-prompt { background: #bbdefb; color: #0d47a1; }
  .pi-mixed { background: #fff3e0; color: #e65100; }
  .claude-prompt { background: #fff3e0; color: #e65100; }
  .claude-read { background: #fee; color: #c33; }
  .claude-blocked { background: #e8f5e9; color: #2e7d32; }
  .claude-mixed { background: #fff3e0; color: #e65100; }
  .codex-prompt { background: #f3e5f5; color: #4a148c; }
  .codex-read { background: #fee; color: #c33; }
  .codex-blocked { background: #e8f5e9; color: #2e7d32; }
  .codex-mixed { background: #fff3e0; color: #e65100; }
  .legend { font-size: .75rem; color: #666; margin-bottom: 1.5rem; line-height: 1.6; }
</style></head><body>
<h1>Agent Config Provenance</h1>
<div class="summary">
  <div class="stat"><strong>${allFiles.length}</strong> tracked</div>
  <div class="stat"><strong>${encCount}</strong> encrypted</div>
  <div class="stat"><strong>${plainCount}</strong> plaintext</div>
  <div class="stat"><strong>${piImports.length}</strong> pi fragments</div>
  <div class="stat"><strong>${claudeImports.length}</strong> claude fragments</div>
  <div class="stat"><strong>${codexImports.length}</strong> codex fragments</div>
  <div class="stat"><strong>${blockedCount}</strong> agent blocked</div>
</div>
<p class="note">Encryption checked empirically from git blob content.${repoGitGuarded ? " Git guard blocks commit/push for ~/agents repo." : ""}</p>
<div class="legend">
  <strong>Legend:</strong><br>
  Github: encrypted [<span class="badge enc">enc</span>], plain [<span class="badge plain">plain</span>], mixed [<span class="badge mixed">mixed</span>].<br>
  Pi: in prompt [<span class="agent pi-prompt">pi:prompt</span>]. Pi can always read.<br>
  Claude: in prompt [<span class="agent claude-prompt">claude:prompt</span>], can read [<span class="agent claude-read">claude:read</span>], blocked [<span class="agent claude-blocked">claude:blocked</span>]<br>
  Codex: in prompt [<span class="agent codex-prompt">codex:prompt</span>], can read [<span class="agent codex-read">codex:read</span>], blocked [<span class="agent codex-blocked">codex:blocked</span>]
</div>
${tree.map(dirBranch).join("\n")}
</body></html>`;

// ── 8. Write and open ─────────────────────────────────────────────────────
const outPath = join(REPO, ".provenance.html");
writeFileSync(outPath, html);
try {
  execSync(`open ${outPath}`);
  console.log(`Provenance visualization opened in browser.`);
} catch {
  console.log(`Provenance visualization written to ${outPath}`);
}
console.log(
  `  ${allFiles.length} files, ${encCount} encrypted, ${plainCount} plaintext`,
);
console.log(
  `  Pi sees ${piImports.length} fragments, Claude sees ${claudeImports.length}, Codex sees ${codexImports.length}`,
);
console.log(
  `  ${blockedCount} files blocked from agents (information-guard sandbox)`,
);
