Intro
Access to a private, good coding model[FN1] has re-invigorated my creative spirit, kicking off a multi-week-long quest to customize my own coding agent. Something about knowing that everything I share with this agent is mine, ours even, really lends itself to this. In a more practical sense, it’s freeing to be able to put all company docs, other peoples information, and any api keys without worrying about them leaving my control.

I want to explain the agent configuration I have set up around this model, and why, and provide an open source implementation of it all.

OKAY HERE I NEED TO HAVE SOME OF THIS IN A FOOTNOTE

I call this a personal agent because it's something useful for reading, summarizing, doing research, remembering things. Also because it’s personalized at a higher level than I feel comfortable with eg. Claude.

In the limit, private intelligence is necessary. My government-assigned AI representative needs to know everything about me to bargain on my behalf. If I want a user aligned model, I need it to know me intimately. Right now, on my computer I have a section of private memories and preferences. While none of this is yet super valuable, it will increasingly[FN9] be. Companies would love to have it. Authoritarian governments would love to have it. My preferences, perspective, taste, might well become my moat. I might as well start protecting it now.

To start with, I chose the pi coding harness. It’s called a coding harness, and referred to as a coding agent, but this is what a general ‘agent’ should be. Like all coding agents it has file access & bash, which is all you need to basically do what a human on a computer can. [FN2]. 80% of the reason I chose pi is their tagline:

| There are many agent harnesses but this one is yours

Pi also makes it very easy to add extensions and is very minimal, which are both great for our purposes here, and is open source, an absolute requirement.

TOC
This blog will be split into the following sections:
Maintaining privacy - Github, sharing data between models, and more.
Tinfoil Extensions
Search
Images
Voice (external)
Miscellaneous extensions & fixes
Prompt caching fix & system reminders
Vscode integrations
Thinking signature fix

You can follow along with this example repository, that shows all sections. All code references will be to this repository[FN6]

Maintaining Privacy
As I mentioned in the introduction, I try to entirely use GLM 5.2, as it’s a good coding model [FN4] (One small drawback is that it isn’t multi-modal, which I deal with in Tinfoil Extensions > Images)

Even so, I sometimes need another model. My model of choice up until now has been Claude, and I’ve always used it with Claude Code so I wanted to be able to share a selection of data, but not all, with Claude Code.

To do this, we can use this `@import` syntax so that different agents get different prompts, composed of fragments. Claude does this natively but we have to extend Pi to respect it.

```markdown
## Instructions

@~/agents/fragments/instructions.md

## Reminders

@~/agents/fragments/encrypted/pi.md
```

Next, I’ll want this to be stored somewhere. Git / Github is my preferred option, and allows me to see differences, so I can revert and monitor agent changes. No brain surgery without a reset button. That along with the import & sharing instructions led to a central agents folder at my root, with everything inside it (`~/agents/pi, `~/agents/claude`)

I want to prevent Github from taking my data that I so carefully prevented AI labs from getting. Git-crypt comes in handy here! It preserves the git tree, which means it shows diffs locally and works like normal git, but stores encrypted ciphertext on github[FN10]. This is used for prompts and memory files

There’s one more trick – AI can just do things. To prevent this I made a little information-guard extension. This prevents agents from committing or pushing in the `~/agents/` folder. It also prevents specific agents (Claude) from reading private files like memories, using apple sandboxing.

Sandboxing is a big thing, and I didn’t go far here. From what I’ve seen, sandboxes (reasonably) tend to be more worried about preventing unauthorized actions, than about what data is read by whom. In the future I’d like to extend on this and data provenance in general. There’s a lot of options for how to do this, though it’s annoying that apple sandboxing is actively hostile to its users.

I’m a visual person. It’s nice to see things. I have a little script that shows what is shown to which agent, and what is encrypted. `visualize-provenance.js` and `compile-prompt.js` create a color-coded list and a stitched together prompt markdown file, respectively.

The slop visual created by verify-provenance.

Tinfoil Extensions

Websearch
Search is absolutely essential. I’m not going to read docs. Pi comes without this, so we get to add a simple extension that allows pi to search and fetch. I use Tinfoil’s websearch endpoint because it’s accurate, it gives you the full page, it checks for prompt injections, and of course it’s weakly anonymized with a 2 hop system (and ZDR on Exa).

Pictured: Tinfoils websearch, from the blog.

Image
I need image recognition, but GLM isn’t multi-modal. The Tinfoil chat does this. How does it do it? It calls Gemma. We’ll do the same thing here. When an image is pasted, Gemma is automatically called to transcribe it. I tuned it a bit to describe the image, including the color and any text in it, and then made it very clear that this was a description of the image, because originally GLM was getting confused.

Code snippet showing prompt? and/or showing in the terminal what it looks like

Voice
Technically this isn’t an extension, but it’s a core part of my workflow, and actually more useful than a Pi extension would be [FN5]. Tinfoil offers a realtime streaming voice model. I wanted the ability to talk, see the transcription stream in, and then paste it into any text entry.

Luckily, there was already an open source option: Openwhisper. A few PRs later, and they support Tinfoil natively (and have a fun pop-up showing the text stream in, so I know it’s working!) I love open source <3.

Bottom right corner UI.

I use this constantly. Openwhisper also has cool other features like a granola-like popup but I haven't explored this much.

Miscellaneous

Prompt caching fix & system reminders

Prompt caching does xyz. It’s important that data is sent in a certain way. Specifically, new changes need to be appended instead of prefixed to the system prompt. See this explanation from the Claude Code team. Natively, Pi does not do this.

While I was here I also wanted to change how system reminders worked. I did this with multiple variables, all following the same pattern:
Freeze the initial state at system prompt creation & store this with the prompt.
On each human turn, recalculate the state.
If it’s changed from previous, add it as a system_reminder tag.
Save each state update.
Repeat 2-4.

This makes the AI more aware of its surroundings [FN8] as one step towards temporally aware models. And it fixes the cache problem of course, saving both money and time. Currently, the variables tracked by my harness are: current working directory, date/time, git branch, and open vscode window (if it’s in a VSCode integrated terminal).

Vscode integrations
One vscode integration, listed above, is to tell the model if it’s in a vscode terminal.
This is super useful. It also allows the AI to interact with vscode. Right now it can add workspaces, and open/close windows. In the future I’d like to add more things, like looking at what I’ve done recently.

This is enabled by a very simple VSCode extension I have installed locally (vscode-hatch) that just exposes the entire vscode API. [FN7]

Thinking signature fix

A very simple quality of life improvement: the Pi harness drops pure thinking responses returned from the model. GLM loves to think so this is important. I made this as an extension in case I update pi (`pi/agent/extensions/thinking-signature-backfill.ts` & `pi/agent/extensions/aborted-thinking-replay.ts`)

Closing Thoughts
Privacy is important. At an object level building in private is fun. It feels like a kid. It feels like a space to create. Carving out spaces to create, carving out private gardens for thought and play and experience: these are things I think are important to work on as the world transforms.

Footnotes
FN1: GLM-5.2 served by Tinfoil, a private AI provider (that I work at :)).
FN2: With worse interfaces in some cases, and better ones in others
FN4: aka long-context.
FN5: I used to use voice mode in Claude Code. This meant I had to stay at the keyboard, and could only paste into claude code. Now I can paste anywhere, tab between windows while talking, or pace.
FN6: It’s worth looking at this repo if you want to implement any of these things locally, because there are some non-obvious, slightly annoying things that I had to do, for instance using a `__before/` folder to group my pi extensions since the order they run is determined alphabetically. I also didn’t want to include many code snippets.
FN7: Note that this is likely very insecure to run as it just exposes everything to my computer (though I’m not too worried about something breaking my VSCode). The Pi extension limits the agent to only call certain things, though it can get around this easily by just calling the vscode extension api with bash, and I couldn’t figure out how to fix this with apple sandboxing.
FN8: I don’t understand why this isn’t the default but I haven’t looked into this closely. Maybe it’s just become more relevant as model contexts get longer, and the state they are in at different points throughout the context is just statistically more likely to have changed.
FN9: As AI gets more powerful, as it becomes more integrated into my life, etc.
FN10: Git-crypt requires you to provide an encryption key. Remember to store this in some sort of password manager, I like the apple keychain as it’s very private.
