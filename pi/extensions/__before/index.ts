/**
 * __before — explicit load order for before_agent_start chain
 *
 * The before_agent_start hook chains across extensions: each handler sees
 * the previous one's output. These three must run in this order:
 *
 *   1. imports    — expands @import directives in context files
 *   2. vscode-hatch — appends VS Code context line to the system prompt
 *   3. prompt-freeze — stores/restores the system prompt (sidecar)
 *
 * prompt-freeze must run AFTER imports (so @import expansion is captured)
 * and AFTER vscode-hatch (so the VS Code line IS captured in the stored
 * prompt — it gets frozen like everything else).
 *
 * Bundling them into a single extension with explicit call order avoids
 * relying on alphabetical filename sorting for correctness.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import importsExtension from "./imports";
import promptFreeze from "./prompt-freeze";
import vscodeHatch from "./vscode-hatch";

export default function (pi: ExtensionAPI) {
  importsExtension(pi);
  vscodeHatch(pi);
  promptFreeze(pi);
}
