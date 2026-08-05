// AI agent guard — tags bash commands with an env var so git hooks can detect agent activity.
//
// This extension prepends AGENT_FLAG=pi to every bash command. The env var
// travels through the process tree (bash → git → hook). Global git hooks
// (~/.config/git/hooks/pre-commit, pre-push) check for AGENT_FLAG and block
// commit/push in protected repos (~/.config/information-guard/repos.txt).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_FLAG = "AGENT_FLAG";
const AGENT_NAME = "pi";

export default function gitGuard(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;

    const command = event.input.command as string;
    if (!command || !command.trim()) return;

    // Tag every bash command with agent identity (for git hooks to detect).
    // This travels through the process tree: bash → git → hook.
    // Prepending "export VAR=val; " is safe — export is a no-op for command behavior.
    event.input.command = `export ${AGENT_FLAG}=${AGENT_NAME}; ${command}`;
  });
}
