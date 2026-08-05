/**
 * system-reminder pi extension
 *
 * Gives the model awareness of what's changed since the last user message,
 * without polluting the session text or UI.
 *
 * - message_end: stores a `system_reminder` field on user messages with
 *   what's changed since the last message (date/time, git branch, cwd).
 *   Only stores changed values. Persists to the session file; UI doesn't
 *   render it (not in `content`).
 * - context: prepends a <system-reminder> tag to user messages that have
 *   the field. Works on a structuredClone — not persisted in text.
 *
 * The `system_reminder` field is an object ({ dateTime?, gitBranch?, cwd? })
 * so it can grow to carry more context in the future.
 *
 * System prompt persistence (cwd/date frozen across fork/resume) is handled
 * by prompt-freeze.ts, which loads before this extension and before
 * vscode-hatch.ts.
 */

import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getVscodeContextLine } from "./__before/vscode-hatch";

interface SystemReminder {
  dateTime?: string;
  gitBranch?: string;
  cwd?: string;
  vscode?: string;
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

function formatReminder(reminder: SystemReminder): string {
  const parts: string[] = [];
  if (reminder.dateTime) parts.push(`date/time: ${reminder.dateTime}`);
  if (reminder.gitBranch)
    parts.push(`${reminder.cwd ?? ""} branch: ${reminder.gitBranch}`.trim());
  if (reminder.cwd && !reminder.gitBranch) parts.push(`cwd: ${reminder.cwd}`);
  if (reminder.vscode) parts.push(`vscode: ${reminder.vscode}`);
  return `<system-reminder>${parts.join("; ")}</system-reminder>`;
}

interface LastState {
  dateTime: string;
  gitBranch: string | undefined;
  cwd: string;
  vscode: string;
}

export default function (pi: ExtensionAPI) {
  let lastState: LastState | null = null;

  pi.on("session_start", () => {
    lastState = null;
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "user") return;

    const message = event.message as any;
    if (message.system_reminder) return;

    const currentDateTime = formatDateTime(new Date());
    const currentBranch = getGitBranch(ctx.cwd);
    const currentCwd = ctx.cwd;
    const currentVscode = await getVscodeContextLine(ctx.cwd);

    const reminder: SystemReminder = {};

    if (!lastState || currentDateTime !== lastState.dateTime) {
      reminder.dateTime = currentDateTime;
    }
    if (
      currentBranch &&
      (!lastState || currentBranch !== lastState.gitBranch)
    ) {
      reminder.gitBranch = currentBranch;
      if (lastState && currentCwd !== lastState.cwd) {
        reminder.cwd = currentCwd;
      }
    } else if (lastState && currentCwd !== lastState.cwd) {
      reminder.cwd = currentCwd;
    }
    if (currentVscode && (!lastState || currentVscode !== lastState.vscode)) {
      reminder.vscode = currentVscode;
    }

    lastState = {
      dateTime: currentDateTime,
      gitBranch: currentBranch,
      cwd: currentCwd,
      vscode: currentVscode,
    };

    if (
      reminder.dateTime ||
      reminder.gitBranch ||
      reminder.cwd ||
      reminder.vscode
    ) {
      return { message: { ...message, system_reminder: reminder } };
    }
  });

  pi.on("context", (event) => {
    let modified = false;
    for (const msg of event.messages as any[]) {
      if (msg.role !== "user") continue;
      const reminder = msg.system_reminder as SystemReminder | undefined;
      if (!reminder) continue;

      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (let i = 0; i < content.length; i++) {
        if (content[i]?.type !== "text") continue;
        if (content[i].text.startsWith("<system-reminder>")) break;
        content[i] = {
          ...content[i],
          text: `${formatReminder(reminder)}\n\n${content[i].text}`,
        };
        modified = true;
        break;
      }
    }
    if (modified) {
      return { messages: event.messages };
    }
  });
}
