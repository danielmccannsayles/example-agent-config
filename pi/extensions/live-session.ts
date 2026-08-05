/**
 * live-session — PID-keyed live session registry for pi.
 *
 * Mirrors Claude's `~/.claude/sessions/<pid>.json` pattern: writes
 * `~/.pi/agent/sessions/.live/<pid>.json` on session_start so external
 * tools (e.g. `ws`) can resolve a running pi PID to its exact session
 * ID — not the newest-in-cwd heuristic, which breaks when multiple pi
 * processes share a cwd.
 *
 * Writes on every session_start (startup/reload/new/resume/fork — same
 * process, new session, file is overwritten). Deletes on session_shutdown
 * reason "quit" and on process exit. Stale files (crashed pi, SIGKILL)
 * are pruned by readers via PID liveness check.
 */

import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LIVE_DIR = join(homedir(), ".pi/agent/sessions/.live");

function liveFile(): string {
  return join(LIVE_DIR, `${process.pid}.json`);
}

function writeLive(
  sessionId: string,
  sessionFile: string | null,
  cwd: string,
  reason: string,
): void {
  try {
    mkdirSync(LIVE_DIR, { recursive: true });
    writeFileSync(
      liveFile(),
      JSON.stringify(
        {
          pid: process.pid,
          sessionId,
          sessionFile,
          cwd,
          reason,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch {
    // non-fatal
  }
}

function clearLive(): void {
  try {
    if (existsSync(liveFile())) unlinkSync(liveFile());
  } catch {
    // non-fatal
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const cwd = ctx.cwd;
    // Ephemeral sessions (--no-session) have no sessionId — skip tracking.
    if (!sessionId || !sessionFile) return;
    writeLive(sessionId, sessionFile, cwd, _event.reason);
  });

  pi.on("session_shutdown", (event) => {
    // "quit" = process is exiting. Other reasons (reload/new/resume/fork)
    // keep the same process alive — session_start will overwrite the file
    // with the new session, so don't delete.
    if (event.reason === "quit") clearLive();
  });

  // Safety net: SIGINT, normal exit. (SIGKILL/crash can't be caught —
  // readers prune stale files via PID liveness check.)
  process.on("exit", clearLive);
}
