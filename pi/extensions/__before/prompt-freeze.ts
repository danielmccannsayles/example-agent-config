/**
 * prompt-freeze pi extension
 *
 * Persists the system prompt across session resume/fork so the cwd, date,
 * and context files from the original session are preserved. Without this,
 * pi rebuilds the system prompt from scratch on every session start, which
 * means forking to a different directory changes the cwd line — breaking
 * prompt caching and confusing the model.
 *
 * Uses a sidecar file (.<session-id>.system-prompt.json) next to the session
 * file. The sidecar is NOT in the session file, so forkFrom/createBranchedSession
 * don't copy it automatically — the extension copies it in session_start by
 * walking parentSession / previousSessionFile.
 *
 * Also enriches "Current date: YYYY-MM-DD" to "Current date and time:
 * YYYY-MM-DD HH:MM TZ", frozen at session start.
 *
 * ## Load order
 *
 * Loaded by __before/index.ts after imports.ts and vscode-hatch.ts, so @import
 * expansion and the VS Code context line are both captured in the stored
 * prompt (frozen like everything else). Order is explicit in the bundle, not
 * alphabetical — see before_bundle.md.
 *
 * ## Hooks
 *
 * - session_start: load stored prompt from sidecar (or copy from parent)
 * - before_agent_start: restore stored prompt, or store the current one
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let sidecarPath: string | null = null;
let storedSystemPrompt: string | null = null;
let shouldStore = false;
let frozenDateTime: string | null = null;
let frozenDate: string | null = null;
let frozenGitBranch: string | null = null;

function getSidecarPath(sessionFile: string, sessionId: string): string {
  return join(dirname(sessionFile), `.${sessionId}.system-prompt.json`);
}

function readSidecar(path: string): string | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (typeof data.systemPrompt === "string") return data.systemPrompt;
  } catch {
    // File doesn't exist or is corrupt
  }
  return null;
}

function writeSidecar(path: string, prompt: string): void {
  try {
    writeFileSync(path, JSON.stringify({ systemPrompt: prompt }));
  } catch {
    // Disk full, permissions, etc. — non-fatal
  }
}

function readSessionId(sessionFile: string): string | null {
  try {
    const firstLine = readFileSync(sessionFile, "utf8").split("\n")[0];
    const header = JSON.parse(firstLine);
    if (typeof header.id === "string") return header.id;
  } catch {
    // File doesn't exist or is corrupt
  }
  return null;
}

function getGitBranch(cwd: string): string | undefined {
  try {
    const branch = execSync("git branch --show-current", {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (branch) return branch;
    const hash = execSync("git rev-parse --short HEAD", {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return hash || undefined;
  } catch {
    return undefined;
  }
}

function formatDateTime(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const tz = d
    .toLocaleTimeString("en-US", { timeZoneName: "short" })
    .split(" ")
    .pop();
  return `${yyyy}-${mm}-${dd} ${hh}:${min} ${tz}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    frozenDateTime = null;
    frozenDate = null;
    frozenGitBranch = null;
    sidecarPath = null;
    storedSystemPrompt = null;
    shouldStore = false;

    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionFile || !sessionId) return;

    sidecarPath = getSidecarPath(sessionFile, sessionId);

    // On reload, rebuild the prompt body (resources may have changed) but
    // preserve the frozen volatile values (date/time, git branch) from the
    // sidecar so the prefix cache stays stable. shouldStore re-stores the
    // rebuilt body with the frozen values re-applied in before_agent_start.
    if (event.reason === "reload") {
      const stored = readSidecar(sidecarPath);
      if (stored) {
        const dtMatch = stored.match(
          /Current date and time: (\d{4}-\d{2}-\d{2} \d{2}:\d{2} \w+)/,
        );
        if (dtMatch) {
          frozenDateTime = dtMatch[1];
          frozenDate = dtMatch[1].slice(0, 10);
        }
        const branchMatch = stored.match(/\nCurrent git branch: ([^\n]+)/);
        if (branchMatch) frozenGitBranch = branchMatch[1].trim();
      }
      shouldStore = true;
      return;
    }

    // Try our own sidecar (resume)
    const own = readSidecar(sidecarPath);
    if (own) {
      storedSystemPrompt = own;
      return;
    }

    // Try parent session (CLI fork: --fork, or in-session fork via /fork)
    const header = ctx.sessionManager.getHeader();
    if (header?.parentSession) {
      const parentId = readSessionId(header.parentSession);
      if (parentId) {
        const parentSidecar = getSidecarPath(header.parentSession, parentId);
        const parentPrompt = readSidecar(parentSidecar);
        if (parentPrompt) {
          storedSystemPrompt = parentPrompt;
          writeSidecar(sidecarPath, parentPrompt);
          return;
        }
      }
    }

    // Try previousSessionFile (in-session fork/resume via ctx.fork/switchSession)
    if (event.previousSessionFile) {
      const prevId = readSessionId(event.previousSessionFile);
      if (prevId) {
        const prevSidecar = getSidecarPath(event.previousSessionFile, prevId);
        const prevPrompt = readSidecar(prevSidecar);
        if (prevPrompt) {
          storedSystemPrompt = prevPrompt;
          writeSidecar(sidecarPath, prevPrompt);
          return;
        }
      }
    }

    // No stored prompt found — will store on first before_agent_start
    shouldStore = true;
  });

  pi.on("before_agent_start", (event, ctx) => {
    let prompt = event.systemPrompt;

    if (storedSystemPrompt) {
      // Restore stored prompt (preserves original cwd, date, imports, etc.)
      prompt = storedSystemPrompt;
      // Parse frozen date/time from the stored prompt
      const dtMatch = prompt.match(
        /Current date and time: (\d{4}-\d{2}-\d{2} \d{2}:\d{2} \w+)/,
      );
      if (dtMatch) {
        frozenDateTime = dtMatch[1];
        frozenDate = dtMatch[1].slice(0, 10);
      }
    } else {
      // New session — enrich the date, add git branch, then store
      const dateMatch = prompt.match(/\nCurrent date: (\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        const promptDate = dateMatch[1];
        if (!frozenDateTime || !frozenDateTime.startsWith(promptDate)) {
          frozenDateTime = formatDateTime(new Date());
          frozenDate = promptDate;
        }
        prompt = prompt.replace(
          /\nCurrent date: [^\n]+/,
          `\nCurrent date and time: ${frozenDateTime}`,
        );
      }
      // Add git branch after the cwd line (frozen like everything else).
      // On reload, frozenGitBranch is preserved from the sidecar so a
      // mid-session branch switch doesn't bust the cache (system-reminder
      // surfaces the change instead).
      const branch = frozenGitBranch ?? getGitBranch(ctx.cwd);
      if (branch && !prompt.includes("\nCurrent git branch:")) {
        prompt = prompt.replace(
          /(\nCurrent working directory: [^\n]+)/,
          `$1\nCurrent git branch: ${branch}`,
        );
      }
      // Store the enriched prompt (includes @imports, date, git branch,
      // and VS Code line from vscode-hatch which ran before us)
      if (shouldStore && sidecarPath) {
        storedSystemPrompt = prompt;
        writeSidecar(sidecarPath, prompt);
        shouldStore = false;
      }
    }

    if (prompt !== event.systemPrompt) {
      return { systemPrompt: prompt };
    }
  });
}
