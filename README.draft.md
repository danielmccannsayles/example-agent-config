Example agent config. Companion to [blog here]().

Disclaimer: This is pretty vibe-coded, and only graded on 'does this seem to do what I want'. It also assumes a Mac. Use at your own risk :).

## How it works

One git repo at `~/agents/` holds the config for three agents — pi, Claude, Codex. Each agent's config dir is a symlink into the repo:

```
~/.pi     → ~/agents/pi
~/.claude → ~/agents/claude
~/.codex  → ~/agents/codex
```

Shared instruction fragments live in `fragments/`. Each agent's index file (`CLAUDE.md` / `AGENTS.md`) pulls in the fragments it should see via `@import`:

```markdown
## Preferences

@~/agents/fragments/shared-preferences.md
```

Claude and Codex share `shared-preferences.md`. Pi gets that plus `fragments/encrypted/` (git-crypt encrypted, Claude/Codex can't read). The `@~/agents/...` paths resolve to `$HOME/agents/...`, so the repo must live at `~/agents/`.

Git-crypt encrypts the private stuff so the repo can be backed up on GitHub without leaking anything. Filenames are not encrypted.

To prevent unwanted agents from reading paths we use sandboxing. This is setup with the [information-guard](https://github.com/danielmccannsayles/information-guard)

## Directory structure

```
~/agents/
├── claude/
│   ├── CLAUDE.md              # Claude's system prompt (index, @imports fragments)
│   ├── settings.json          # SessionStart hook: sets AGENT_FLAG=claude
│   └── memory/                # Claude's memories (git-crypt encrypted)
├── codex/
│   ├── AGENTS.md              # Codex's system prompt
│   └── config.toml            # Model + native sandbox deny rules
├── pi/
│   ├── agent/
│   │   ├── AGENTS.md          # Pi's system prompt (index, @imports fragments)
│   │   ├── models.json        # Provider config ($TINFOIL_API_KEY)
│   │   ├── extensions/        # Pi extensions
│   │   │   ├── __before/      # Load-order bundle, necessary for correct system reminders
│   │   │   ├── git-guard.ts   # Tags bash commands with AGENT_FLAG=pi
│   │   │   └── ...
│   │   └── memory/            # Pi's memories (git-crypt encrypted)
│   └── .gitignore
├── fragments/
│   ├── shared-preferences.md  # Shared across all agents (plaintext)
│   └── encrypted/             # Pi-only (git-crypt encrypted)
├── remember/                  # Things to save (git-crypt encrypted)
├── verify-provenance.mjs      # Visualize what's encrypted / what each agent sees
└── checkPrompt.mjs            # Assemble & view an agent's full prompt
```

## Prerequisites

- [pi](https://github.com/earendil-works/pi-coding-agent)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://github.com/openai/codex) (or omit)
- [git-crypt](https://github.com/AGWA/git-crypt)
- Node (for the two scripts)
- [ai-guard](https://github.com/tinfoilsh/ai-guard) (the information-guard: sandboxing + git guard)

## Setup

1. **Clone to `~/agents/`** (the `@~/agents/...` import paths require this location):

   ```bash
   git clone <this-repo> ~/agents
   ```

2. **Symlink the agent config dirs:**

   ```bash
   ln -s ~/agents/pi ~/.pi
   ln -s ~/agents/claude ~/.claude
   ln -s ~/agents/codex ~/.codex
   ```

   (Codex can share Claude's prompt: `ln -s ../claude/CLAUDE.md ~/.codex/AGENTS.md`)

3. **Set up git-crypt** (encrypts memories, private fragments, pi extensions on GitHub):

   ```bash
   cd ~/agents
   git-crypt init
   git-crypt export-key ~/agents/git-crypt-key  # store somewhere safe
   ```

   Then uncomment the rules in `.gitattributes`.

4. **Set your API key** (for pi's Tinfoil provider):

   ```bash
   export TINFOIL_API_KEY="your-key-here"  # in ~/.zshrc
   ```

   If using [Tinfoil Proxy](https://tinfoil.sh), it runs locally on `127.0.0.1:3301` and handles attestation. Point pi at it via `baseUrl` in `pi/agent/models.json`.

5. **Install the information-guard** (ai-guard repo):

   ```bash
   cd ~/Desktop/coding/ai-guard  # or wherever
   ./install.sh
   ```

   This installs git hooks (block agent commits to protected repos) and the sandbox wrapper. Then add aliases to `~/.zshrc`:

   ```bash
   alias claude='information-guard-sandbox claude' # claude needs sandbox, agent flag is in hooks
   alias codex='AGENT_FLAG=codex codex' # codex doesn't need sandbox but does need agent flag
   ```

   Configure protected paths in `~/.config/information-guard/sandbox.json` and protected repos in `~/.config/information-guard/repos.txt`.

6. **Uncomment `.gitattributes`** so git-crypt starts encrypting.

7. **Test it:**

   ```bash
   node verify-provenance.mjs   # opens a browser showing what's encrypted / who sees what
   node checkPrompt.mjs pi      # assembles pi's full prompt to prompt.md
   ```

   Spin up your agents, have them try to read things they shouldn't. Push to GitHub and verify the encrypted paths are ciphertext (filenames are not encrypted).
