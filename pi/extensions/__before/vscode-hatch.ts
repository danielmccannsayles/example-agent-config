/**
 * vscode-hatch pi extension
 *
 * Connects to the vscode-hatch VS Code extension (Unix socket bridge) and
 * exposes tools for VS Code awareness: which terminal/window am I in, what
 * files are open, what workspaces are open, and add-to-workspace.
 *
 * Requires the vscode-hatch VS Code extension to be installed and running.
 * See: https://github.com/danielmccannsayles/vscode-hatch
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// --- Types ---

interface HatchSession {
  pid: number;
  socketPath: string;
  workspaceFolders: string[];
  workspaceFile: string | null;
  workspaceName: string;
  startedAt: string;
}

interface TerminalInfo {
  name: string;
  processId: number;
}

// --- Hatch socket client ---

const SESSIONS_DIR = path.join(os.homedir(), ".vscode-hatch", "sessions");
const SOCKET_TIMEOUT_MS = 5000;

function readSessions(): HatchSession[] {
  let files: string[];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      try {
        const s = JSON.parse(
          fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"),
        ) as HatchSession;
        return s.socketPath ? s : null;
      } catch {
        return null;
      }
    })
    .filter((s): s is HatchSession => s !== null);
}

function hatchCall(
  socketPath: string,
  code: string,
  payload?: unknown,
  timeoutMs = SOCKET_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`hatch call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    conn.on("connect", () => {
      conn.write(
        JSON.stringify({ id: "1", code, payload: payload ?? {} }) + "\n",
      );
    });
    conn.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i !== -1) {
        clearTimeout(timer);
        conn.end();
        try {
          const res = JSON.parse(buf.slice(0, i));
          if (res.ok) resolve(res.result);
          else reject(new Error(res.error || "hatch call failed"));
        } catch (e) {
          reject(e);
        }
      }
    });
    conn.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function probeLive(
  sessions: HatchSession[],
): Promise<{ session: HatchSession; alive: boolean }[]> {
  return Promise.all(
    sessions.map(async (s) => {
      try {
        await hatchCall(s.socketPath, "return vscode.version", {}, 2000);
        return { session: s, alive: true };
      } catch {
        return { session: s, alive: false };
      }
    }),
  );
}

// --- Workspace folder mutation helpers ---
//
// Adding/removing workspace folders has two failure modes that the naive
// implementation (trust updateWorkspaceFolders' return value) misses:
//
// 1. Parallel calls: updateWorkspaceFolders returns false if a previous
//    change is still pending. Two concurrent add/remove calls trip over
//    each other.
// 2. Ext-host restart: adding a folder to a SINGLE-FOLDER workspace triggers
//    enterWorkspace(), which restarts the extension host. The old socket
//    dies; a new session file (new PID, new socket) appears. The optimistic
//    return value lies — the change may or may not have landed.
//
// Fix: serialize all mutations (mutex), retry on socket failure with session
// re-resolution, and poll workspaceFolders afterwards to confirm the actual
// state.

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Promise-chain mutex: serializes all add/remove workspace folder operations.
let workspaceMutex: Promise<unknown> = Promise.resolve();
function withWorkspaceMutex<T>(fn: () => Promise<T>): Promise<T> {
  const next = workspaceMutex.then(fn, fn);
  // Swallow the result so a rejection doesn't poison the chain for the next
  // caller.
  workspaceMutex = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// Re-resolve a session after a socket failure (e.g. ext-host restart).
// Finds a session with the same PID but a new socket path first (multi-root
// case — no restart, just a session file update), then falls back to
// workspace-folder overlap (single-folder restart — new PID, new socket).
function reResolveSession(
  oldSession: HatchSession,
  sessions: HatchSession[],
): HatchSession | null {
  const byPid = sessions.find((s) => s.pid === oldSession.pid);
  if (byPid && byPid.socketPath !== oldSession.socketPath) return byPid;
  const oldFolders = new Set(oldSession.workspaceFolders);
  return (
    sessions.find(
      (s) =>
        s.socketPath !== oldSession.socketPath &&
        s.workspaceFolders?.some((f) => oldFolders.has(f)),
    ) ?? null
  );
}

// Wraps hatchCall with one retry on socket-level failure. If the socket is
// dead (ext-host restarting), re-reads sessions, reconnects to the new
// socket, and retries once after a delay.
async function hatchCallRobust(
  session: HatchSession,
  code: string,
  payload?: unknown,
  timeoutMs: number = SOCKET_TIMEOUT_MS,
): Promise<unknown> {
  try {
    return await hatchCall(session.socketPath, code, payload, timeoutMs);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    const isSocketError =
      msg.includes("ECONNREFUSED") ||
      msg.includes("EPIPE") ||
      msg.includes("ENOENT") ||
      msg.includes("timed out") ||
      msg.includes("connect E");
    if (!isSocketError) throw e;
    await sleep(1500);
    const fresh = readSessions();
    const next = reResolveSession(session, fresh);
    if (!next) throw e;
    return await hatchCall(next.socketPath, code, payload, timeoutMs);
  }
}

// Poll workspaceFolders until a predicate is satisfied or timeout. Re-reads
// sessions and reconnects on socket failure (ext-host restart). Returns the
// final folder list and whether the predicate matched.
async function pollWorkspaceFolders(
  session: HatchSession,
  predicate: (folders: string[]) => boolean,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<{ folders: string[]; matched: boolean }> {
  const intervalMs = opts.intervalMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const deadline = Date.now() + timeoutMs;
  let current = session;
  let lastFolders: string[] = [];
  while (Date.now() < deadline) {
    try {
      lastFolders = (await hatchCall(
        current.socketPath,
        "return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)",
      )) as string[];
      if (predicate(lastFolders))
        return { folders: lastFolders, matched: true };
    } catch {
      // Socket likely dead (ext-host restarting). Re-resolve and continue.
      const fresh = readSessions();
      const next = reResolveSession(current, fresh);
      if (next) current = next;
    }
    await sleep(intervalMs);
  }
  return { folders: lastFolders, matched: false };
}

// --- Session discovery ---

function findSessionByCwd(
  cwd: string,
  sessions: HatchSession[],
): HatchSession | null {
  // When multiple windows contain the cwd (e.g. a single-folder window AND
  // a multi-root workspace that includes the same folder), prefer the more
  // specific match: single-folder exact, then multi-folder exact, then
  // single-folder ancestor, then multi-folder ancestor.
  const exact = sessions.filter((s) =>
    s.workspaceFolders?.some((f) => f === cwd),
  );
  if (exact.length > 0) {
    return exact.find((s) => s.workspaceFolders.length === 1) ?? exact[0];
  }
  const ancestor = sessions.filter((s) =>
    s.workspaceFolders?.some((f) => cwd.startsWith(f + "/")),
  );
  if (ancestor.length > 0) {
    return ancestor.find((s) => s.workspaceFolders.length === 1) ?? ancestor[0];
  }
  return null;
}

function findSessionByWindow(
  w: string,
  sessions: HatchSession[],
): HatchSession | null {
  const needle = w.toLowerCase();
  // Prefer workspace name match over folder-path substring: a window named
  // "tf-test" should win over a multi-root workspace whose folder path
  // happens to contain "tf-test".
  const nameExact = sessions.find(
    (s) => s.workspaceName?.toLowerCase() === needle,
  );
  if (nameExact) return nameExact;
  const nameSub = sessions.find((s) =>
    s.workspaceName?.toLowerCase().includes(needle),
  );
  if (nameSub) return nameSub;
  const folderSub = sessions.find((s) =>
    s.workspaceFolders?.some((f) => f.toLowerCase().includes(needle)),
  );
  return folderSub ?? null;
}

// Resolve which session a tool should target. When running inside a VS Code
// terminal, the PID-chain match is unambiguous (it identifies the exact window
// the shell was spawned in). Fall back to cwd matching (improved to prefer
// single-folder windows) for non-VS-Code terminals (e.g. Ghostty).
async function resolveSession(
  params: { window?: string },
  ctx: { cwd: string },
  sessions: HatchSession[],
  inVscode: boolean,
): Promise<HatchSession | null> {
  if (params.window) {
    return findSessionByWindow(params.window, sessions);
  }
  if (inVscode) {
    const ancestors = getAncestorPids();
    const terminalMatch = await findMyTerminal(sessions, ancestors);
    if (terminalMatch) return terminalMatch.session;
  }
  return findSessionByCwd(ctx.cwd, sessions);
}

// --- PID chain (terminal self-ID) ---

function getAncestorPids(): number[] {
  const pids: number[] = [];
  let pid = process.pid;
  while (pid > 1) {
    pids.push(pid);
    try {
      const out = execSync(`ps -o ppid= -p ${pid}`, {
        encoding: "utf8",
        timeout: 2000,
      });
      const ppid = parseInt(out.trim(), 10);
      if (isNaN(ppid) || ppid === 0 || ppid === pid) break;
      pid = ppid;
    } catch {
      break;
    }
  }
  return pids;
}

async function findMyTerminal(
  sessions: HatchSession[],
  ancestorPids: number[],
): Promise<{ session: HatchSession; terminal: TerminalInfo } | null> {
  const pidSet = new Set(ancestorPids);
  const results = await Promise.allSettled(
    sessions.map(async (s) => {
      const terminals = (await hatchCall(
        s.socketPath,
        "return await Promise.all(vscode.window.terminals.map(async t => ({ name: t.name, processId: await t.processId })))",
      )) as TerminalInfo[];
      return { session: s, terminals };
    }),
  );
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { session, terminals } = r.value;
    if (!Array.isArray(terminals)) continue;
    for (const t of terminals) {
      if (t.processId && pidSet.has(t.processId)) {
        return { session, terminal: t };
      }
    }
  }
  return null;
}

// --- Display helpers ---

function formatWindow(s: HatchSession, markers: string[] = []): string {
  const tag = markers.length ? ` (${markers.join(", ")})` : "";
  const file = s.workspaceFile
    ? s.workspaceFile.match(/^\d+$/)
      ? "unsaved workspace"
      : s.workspaceFile
    : "single folder";
  const folders = s.workspaceFolders.map((f) => `      ${f}`).join("\n");
  return `  - ${s.workspaceName} (pid ${s.pid})${tag}\n      ${file}\n${folders}`;
}

// --- System prompt context injection ---

// Module-level so it can be shared with system-reminder.ts (which imports
// getVscodeContextLine). Computed once at module load — env vars don't change
// mid-session.
const inVscode =
  process.env.TERM_PROGRAM === "vscode" || !!process.env.VSCODE_IPC_HOOK_CLI;

// Cache keyed by cwd. The terminal→window match (PID chain) is stable for the
// session; we only recompute when cwd changes. A promise is cached so that a
// pre-warm kicked off in session_start is shared with before_agent_start and
// message_end (system-reminder.ts).
let vscodeContextCache: { cwd: string; promise: Promise<string> } | null = null;

async function computeVscodeContextLine(cwd: string): Promise<string> {
  if (!inVscode) return "";
  try {
    const sessions = readSessions();
    if (sessions.length === 0) return "";
    let win: HatchSession | null = null;
    const ancestors = getAncestorPids();
    const match = await findMyTerminal(sessions, ancestors);
    if (match) win = match.session;
    if (!win) win = findSessionByCwd(cwd, sessions);
    if (!win) return "";
    const isWorkspace =
      win.workspaceFile !== null || (win.workspaceFolders?.length ?? 0) > 1;
    let line = `In VS Code terminal "${win.workspaceName}"`;
    if (isWorkspace) {
      const basenames = win.workspaceFolders.map((f) => path.basename(f));
      line += `, folders: [${basenames.join(", ")}]`;
    }
    return line;
  } catch {
    return "";
  }
}

export function getVscodeContextLine(cwd: string): Promise<string> {
  if (vscodeContextCache && vscodeContextCache.cwd === cwd) {
    return vscodeContextCache.promise;
  }
  const promise = computeVscodeContextLine(cwd);
  vscodeContextCache = { cwd, promise };
  return promise;
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // Pre-warm VS Code context cache on session start.
  pi.on("session_start", (_event, ctx) => {
    getVscodeContextLine(ctx.cwd);
  });

  // Append VS Code context to the system prompt. Runs BEFORE prompt-freeze
  // (via __before/index.ts load order) so the line is captured in the stored
  // prompt. On restore, prompt-freeze returns the stored prompt (with the
  // frozen line), discarding this fresh one. Changes to VS Code context
  // mid-session are surfaced via system-reminder.ts instead.
  pi.on("before_agent_start", async (event, ctx) => {
    const line = await getVscodeContextLine(ctx.cwd);
    if (line) {
      return { systemPrompt: event.systemPrompt + `\n\n${line}` };
    }
  });

  pi.registerTool({
    name: "vscode_status",
    label: "VS Code Status",
    description:
      "Check VS Code state: whether you're running inside a VS Code integrated terminal, which terminal tab and window you're in, and all open VS Code windows with their workspace folders.",
    promptSnippet:
      "Check which VS Code terminal/window you're in and what windows are open",
    promptGuidelines: [
      "Use vscode_status when the user asks which VS Code terminal or window they're in, or what VS Code windows are open.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessions = readSessions();
      if (sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No VS Code windows with vscode-hatch running. Install the vscode-hatch extension and reload VS Code.",
            },
          ],
          details: { inVscodeTerminal: false, windows: [] },
        };
      }

      const cwd = ctx.cwd;
      const cwdSession = findSessionByCwd(cwd, sessions);

      let terminalMatch: {
        session: HatchSession;
        terminal: TerminalInfo;
      } | null = null;
      if (inVscode) {
        const ancestors = getAncestorPids();
        terminalMatch = await findMyTerminal(sessions, ancestors);
      }

      const live = await probeLive(sessions);
      const liveWindows = live.filter((l) => l.alive).map((l) => l.session);

      const lines: string[] = [];

      if (inVscode && terminalMatch) {
        lines.push(
          `Running in VS Code terminal "${terminalMatch.terminal.name}" (shell pid ${terminalMatch.terminal.processId}).`,
        );
        lines.push(`Window: ${terminalMatch.session.workspaceName}`);
      } else if (inVscode) {
        lines.push(
          "Running in a VS Code integrated terminal, but could not match to a specific terminal tab.",
        );
      } else {
        lines.push("Not running in a VS Code integrated terminal.");
      }

      if (cwdSession && cwdSession !== terminalMatch?.session) {
        lines.push(
          `\nCurrent working directory matches window: ${cwdSession.workspaceName}`,
        );
      }

      lines.push(`\nOpen VS Code windows (${liveWindows.length}):`);
      for (const w of liveWindows) {
        const markers: string[] = [];
        if (terminalMatch && w.pid === terminalMatch.session.pid)
          markers.push("you are here");
        if (cwdSession && w.pid === cwdSession.pid) markers.push("matches cwd");
        lines.push(formatWindow(w, markers));
      }

      const dead = live.filter((l) => !l.alive);
      if (dead.length > 0) {
        lines.push(
          `\n(${dead.length} stale session file(s) from closed windows, ignored.)`,
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          inVscodeTerminal: inVscode && !!terminalMatch,
          terminal: terminalMatch?.terminal ?? null,
          window: terminalMatch?.session ?? cwdSession ?? null,
          cwdWindow: cwdSession,
          allWindows: liveWindows,
        },
      };
    },
  });

  pi.registerTool({
    name: "vscode_open_tabs",
    label: "VS Code Open Tabs",
    description:
      "List open editor tabs in a VS Code window. Defaults to the window matching the current working directory, or the window you're running in if inside a VS Code terminal.",
    promptSnippet: "List open files/tabs in a VS Code window",
    promptGuidelines: [
      "Use vscode_open_tabs when the user asks what files or tabs are open in VS Code.",
    ],
    parameters: Type.Object({
      window: Type.Optional(
        Type.String({
          description:
            "Target a specific window by workspace name or folder path substring. Omit to auto-detect from cwd.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessions = readSessions();
      if (sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No VS Code windows with vscode-hatch running.",
            },
          ],
          details: { tabs: [] },
        };
      }

      const session = await resolveSession(params, ctx, sessions, inVscode);

      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: params.window
                ? `No VS Code window matching "${params.window}". Use vscode_workspaces to see open windows.`
                : `No VS Code window matching cwd ${ctx.cwd}. Use vscode_workspaces to see open windows.`,
            },
          ],
          details: { tabs: [] },
        };
      }

      const tabs = (await hatchCall(
        session.socketPath,
        "return vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => { if (t.input instanceof vscode.TabInputText) { return { label: t.label, path: t.input.uri.fsPath, dirty: t.isDirty, preview: t.isPreview }; } return { label: t.label, type: t.input && t.input.constructor ? t.input.constructor.name : 'unknown' }; }))",
      )) as Array<{
        label: string;
        path?: string;
        dirty?: boolean;
        preview?: boolean;
        type?: string;
      }>;

      const lines: string[] = [`Open tabs in ${session.workspaceName}:`];
      for (const t of tabs) {
        if (t.path) {
          const flags = [
            t.dirty ? "dirty" : "",
            t.preview ? "preview" : "",
          ].filter(Boolean);
          const tag = flags.length ? ` [${flags.join(", ")}]` : "";
          lines.push(`  ${t.path}${tag}`);
        } else {
          lines.push(`  ${t.label} (${t.type})`);
        }
      }
      if (tabs.length === 0) lines.push("  (no tabs open)");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { window: session.workspaceName, tabs },
      };
    },
  });

  pi.registerTool({
    name: "vscode_workspaces",
    label: "VS Code Workspaces",
    description:
      "List all open VS Code windows and their workspace folders, including unsaved multi-root workspaces.",
    promptSnippet: "List all open VS Code windows and their workspace folders",
    promptGuidelines: [
      "Use vscode_workspaces to list all open VS Code windows and their workspace folders, including unsaved workspaces.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const sessions = readSessions();
      if (sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No VS Code windows with vscode-hatch running.",
            },
          ],
          details: { windows: [] },
        };
      }

      const live = await probeLive(sessions);
      const liveWindows = live.filter((l) => l.alive).map((l) => l.session);

      const lines: string[] = [`Open VS Code windows (${liveWindows.length}):`];
      for (const w of liveWindows) {
        lines.push(formatWindow(w));
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { windows: liveWindows },
      };
    },
  });

  pi.registerTool({
    name: "vscode_add_folder",
    label: "VS Code Add Folder",
    description:
      "Add a folder to a VS Code workspace via vscode.workspace.updateWorkspaceFolders. Targets the window matching the current working directory by default.",
    promptSnippet: "Add a folder to the VS Code workspace",
    promptGuidelines: [
      "Use vscode_add_folder when the user asks to add a folder to their VS Code workspace.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Folder path to add (absolute or relative to cwd).",
      }),
      window: Type.Optional(
        Type.String({
          description:
            "Target a specific window by workspace name or folder path substring. Omit to auto-detect from cwd.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessions = readSessions();
      if (sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No VS Code windows with vscode-hatch running. You can also use `code --add <folder>` from a VS Code terminal.",
            },
          ],
          details: { added: false },
        };
      }

      const session = await resolveSession(params, ctx, sessions, inVscode);

      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: params.window
                ? `No VS Code window matching "${params.window}". Use vscode_workspaces to see open windows.`
                : `No VS Code window matching cwd ${ctx.cwd}. Use vscode_workspaces to see open windows.`,
            },
          ],
          details: { added: false },
        };
      }

      const folderPath = path.resolve(params.path);
      const result = await withWorkspaceMutex(async () => {
        // Send the add command. The JS retries updateWorkspaceFolders a few
        // times (it returns false while a previous change is pending).
        const res = (await hatchCallRobust(
          session,
          "const uri = vscode.Uri.file(payload.path); const sleep = (ms) => new Promise(r => setTimeout(r, ms)); let ok = false; for (let i = 0; i < 5; i++) { ok = vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri }); if (ok) break; await sleep(100); } return { ok }",
          { path: folderPath },
        )) as { ok: boolean };

        if (!res.ok) {
          return {
            ok: false as const,
            verified: false as const,
            reason: "rejected" as const,
            folders: [] as string[],
          };
        }

        // updateWorkspaceFolders returned true, but on single-folder windows
        // this triggers enterWorkspace() which restarts the ext host. Poll
        // to confirm the folder actually landed (socket may die and
        // reconnect).
        const poll = await pollWorkspaceFolders(session, (folders) =>
          folders.some((f) => f === folderPath),
        );
        return {
          ok: true as const,
          verified: poll.matched,
          reason: null,
          folders: poll.folders,
        };
      });

      return {
        content: [
          {
            type: "text",
            text: result.verified
              ? `Added ${folderPath} to ${session.workspaceName}. Workspace now has ${result.folders.length} folder(s): ${result.folders.join(", ")}.`
              : result.reason === "rejected"
                ? `VS Code rejected the folder add after retries (updateWorkspaceFolders kept returning false). The folder may already be in the workspace, or a previous change is still pending.`
                : `Sent the add command to ${session.workspaceName}, but could not confirm the folder landed after polling. The ext host may still be restarting. Current folders: ${result.folders.join(", ") || "(none)"}.`,
          },
        ],
        details: {
          added: result.verified,
          folderPath,
          window: session.workspaceName,
          folderCount: result.folders.length,
        },
      };
    },
  });

  pi.registerTool({
    name: "vscode_remove_folder",
    label: "VS Code Remove Folder",
    description:
      "Remove a folder from a VS Code workspace via vscode.workspace.updateWorkspaceFolders. Targets the window matching the current working directory by default.",
    promptSnippet: "Remove a folder from the VS Code workspace",
    promptGuidelines: [
      "Use vscode_remove_folder when the user asks to remove a folder from their VS Code workspace.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "Folder path to remove (absolute or relative to cwd). Can also be a folder name (last path segment). If omitted, lists the folders in the target window for you to pick from.",
        }),
      ),
      window: Type.Optional(
        Type.String({
          description:
            "Target a specific window by workspace name or folder path substring. Omit to auto-detect from cwd.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessions = readSessions();
      if (sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No VS Code windows with vscode-hatch running. You can also use `code --remove <folder>` from a VS Code terminal.",
            },
          ],
          details: { removed: false },
        };
      }

      const session = await resolveSession(params, ctx, sessions, inVscode);

      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: params.window
                ? `No VS Code window matching "${params.window}". Use vscode_workspaces to see open windows.`
                : `No VS Code window matching cwd ${ctx.cwd}. Use vscode_workspaces to see open windows.`,
            },
          ],
          details: { removed: false },
        };
      }

      // Fetch the live workspace folders from the window (read-only, for
      // listing and match resolution).
      const folders = (await hatchCallRobust(
        session,
        "return (vscode.workspace.workspaceFolders ?? []).map(f => ({ name: f.name, path: f.uri.fsPath }))",
      )) as Array<{ name: string; path: string }>;

      if (folders.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `${session.workspaceName} has no workspace folders to remove.`,
            },
          ],
          details: { removed: false, window: session.workspaceName },
        };
      }

      // No path provided — list folders so the user can pick.
      if (!params.path) {
        const lines = [
          `Folders in ${session.workspaceName}:`,
          ...folders.map((f, i) => `  [${i}] ${f.path}`),
          "\nPass the path or folder name to --path to remove it.",
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { removed: false, folders, window: session.workspaceName },
        };
      }

      const target = params.path;
      const resolved = path.isAbsolute(target)
        ? target
        : path.resolve(ctx.cwd, target);

      // Match by: exact fsPath → case-insensitive fsPath → exact name → case-insensitive name.
      const matchFolder = (
        list: Array<{ name: string; path: string }>,
      ): { name: string; path: string } | undefined =>
        list.find((f) => f.path === resolved) ??
        list.find((f) => f.path.toLowerCase() === resolved.toLowerCase()) ??
        list.find((f) => f.name === target) ??
        list.find((f) => f.name.toLowerCase() === target.toLowerCase());

      const matched = matchFolder(folders);
      if (!matched) {
        const lines = [
          `No folder matching "${target}" in ${session.workspaceName}.`,
          "Folders:",
          ...folders.map((f, i) => `  [${i}] ${f.path}`),
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { removed: false, reason: "not found", folders, target },
        };
      }

      // Perform the removal under the mutex — re-fetch the folder list first
      // because the index may have shifted since a previous operation.
      const result = await withWorkspaceMutex(async () => {
        const liveFolders = (await hatchCallRobust(
          session,
          "return (vscode.workspace.workspaceFolders ?? []).map(f => ({ name: f.name, path: f.uri.fsPath }))",
        )) as Array<{ name: string; path: string }>;

        const live = matchFolder(liveFolders);
        if (!live) {
          return {
            removed: false as const,
            verified: false as const,
            reason: "vanished" as const,
            folders: liveFolders.map((f) => f.path),
            folderName: matched.name,
            folderPath: matched.path,
          };
        }
        const idx = liveFolders.indexOf(live);

        const res = (await hatchCallRobust(
          session,
          "const sleep = (ms) => new Promise(r => setTimeout(r, ms)); let removed = false; for (let i = 0; i < 5; i++) { removed = vscode.workspace.updateWorkspaceFolders(payload.index, 1); if (removed) break; await sleep(100); } return { removed }",
          { index: idx },
        )) as { removed: boolean };

        if (!res.removed) {
          return {
            removed: false as const,
            verified: false as const,
            reason: "rejected" as const,
            folders: liveFolders.map((f) => f.path),
            folderName: live.name,
            folderPath: live.path,
          };
        }

        // Poll to confirm the folder is gone (ext host may restart).
        const poll = await pollWorkspaceFolders(
          session,
          (list) => !list.some((f) => f === live.path),
        );
        return {
          removed: true as const,
          verified: poll.matched,
          reason: null,
          folders: poll.folders,
          folderName: live.name,
          folderPath: live.path,
        };
      });

      return {
        content: [
          {
            type: "text",
            text: result.verified
              ? `Removed ${result.folderPath} from ${session.workspaceName}. Workspace now has ${result.folders.length} folder(s): ${result.folders.join(", ") || "(none)"}.`
              : result.reason === "rejected"
                ? `VS Code rejected the folder removal (updateWorkspaceFolders returned false).`
                : result.reason === "vanished"
                  ? `Folder "${target}" was found initially but vanished before removal — it may have been removed by a concurrent operation. Current folders: ${result.folders.join(", ") || "(none)"}.`
                  : `Sent the remove command to ${session.workspaceName}, but could not confirm the folder was removed after polling. The ext host may still be restarting. Current folders: ${result.folders.join(", ") || "(none)"}.`,
          },
        ],
        details: {
          removed: result.verified,
          folderPath: result.folderPath,
          folderName: result.folderName,
          window: session.workspaceName,
          folderCount: result.folders.length,
        },
      };
    },
  });

  pi.registerTool({
    name: "vscode_open_window",
    label: "VS Code Open Window",
    description:
      "Open a folder in a new VS Code window. Uses the vscode-hatch socket bridge (runs inside the already-running VS Code instance, no new process). Do NOT use `code` from bash for this — it disrupts the extension host and git operations.",
    promptSnippet: "Open a folder in a new VS Code window",
    promptGuidelines: [
      "Use vscode_open_window when the user asks to open a folder or repo in a new VS Code window. Never use `code` from bash for this.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Folder path to open (absolute or relative to cwd).",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessions = readSessions();
      if (sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No VS Code windows with vscode-hatch running. Start VS Code with the vscode-hatch extension installed and try again.",
            },
          ],
          details: { opened: false },
        };
      }

      const folderPath = path.resolve(ctx.cwd, params.path);
      if (!fs.existsSync(folderPath)) {
        return {
          content: [
            { type: "text", text: `Path does not exist: ${folderPath}` },
          ],
          details: { opened: false, reason: "not found" },
        };
      }

      // Use the first live session to execute the command. vscode.openFolder
      // with forceNewWindow opens a new window regardless of which session
      // we call from.
      const live = await probeLive(sessions);
      const liveSession = live.find((l) => l.alive)?.session;
      if (!liveSession) {
        return {
          content: [
            {
              type: "text",
              text: "No live VS Code windows found. VS Code may need to be restarted.",
            },
          ],
          details: { opened: false, reason: "no live session" },
        };
      }

      await hatchCall(
        liveSession.socketPath,
        "await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(payload.path), { forceNewWindow: true }); return true;",
        { path: folderPath },
      );

      return {
        content: [
          {
            type: "text",
            text: `Opened ${folderPath} in a new VS Code window.`,
          },
        ],
        details: { opened: true, folderPath },
      };
    },
  });

  pi.registerTool({
    name: "vscode_close_window",
    label: "VS Code Close Window",
    description:
      "Close a VS Code window. Targets the window matching the current working directory by default, or a specific window by name/path. Uses the vscode-hatch socket bridge.",
    promptSnippet: "Close a VS Code window",
    promptGuidelines: [
      "Use vscode_close_window when the user asks to close a VS Code window.",
    ],
    parameters: Type.Object({
      window: Type.Optional(
        Type.String({
          description:
            "Target a specific window by workspace name or folder path substring. Omit to close the window matching the current working directory.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessions = readSessions();
      if (sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No VS Code windows with vscode-hatch running.",
            },
          ],
          details: { closed: false },
        };
      }

      const session = await resolveSession(params, ctx, sessions, inVscode);

      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: params.window
                ? `No VS Code window matching "${params.window}". Use vscode_workspaces to see open windows.`
                : `No VS Code window matching cwd ${ctx.cwd}. Use vscode_workspaces to see open windows.`,
            },
          ],
          details: { closed: false, reason: "not found" },
        };
      }

      await hatchCall(
        session.socketPath,
        "await vscode.commands.executeCommand('workbench.action.closeWindow'); return true;",
        {},
      );

      return {
        content: [
          {
            type: "text",
            text: `Closed ${session.workspaceName}.`,
          },
        ],
        details: { closed: true, window: session.workspaceName },
      };
    },
  });
}
