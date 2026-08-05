Example agent config. Companion to [blog here]().

Disclaimer: This is pretty vibe-coded, and only graded on 'does this seem to do what I want'. It also assumes a Mac. Use at your own risk :).

## Guide

To set this up you'll want to:

1. Install the information guard

```
alias clod="information-guard-sandbox claude"
alias codex="AGENT_FLAG=codex codex"
```

2. Install pi, claude, etc. into this centralized agents folder. (do users have to symlink or something?). Is it simple & easy to install? I don't know..

3. If you're using Tinfoil, install the tinfoilproxy, this will do all the attestation etc. for you & you can just point Pi at `http://127.0.0.1:3301/v1`.
4. Uncomment `gitattributes` so that gitcrypt starts working.
5. Test it out - spin up your agents, have them try and open things. Go to Github, and make sure that it's being encrypted correctly. Note that filenames are not encrypted.

## About

pi/
codex/
claude/

Git-crypt: Generate a key, store it in apple password manager, etc.

Check prompt & provenance with the scripts.

Notes (remove!):

Hmm.. I really don't love the code snippets. I'm not sure how much they actually add. Instead I probably will just point to the reference at the end, and maybe use one or two small diagrams here and there if we really need this..
