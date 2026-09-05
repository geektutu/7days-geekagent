---
lang: en
title: Build GeekAgent from Scratch — Day 4 File Tools and Registry
description: >-
  A 7-day from-scratch tutorial for building an Agent/Harness by hand in TypeScript. Day 4 splits both reads and writes out of the shell: reads go through confirmation-free dedicated tools (ls/read/glob), writes go through a dedicated channel that shows a diff before touching disk (write/patch), and the accumulated tools are unified into a single registry — the first time the model completes the full read → modify → verify loop.
date: '2026-08-23 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 4: Splitting Reads and Writes Out of the Shell — File Tools and the Registry

> Day 3 gave the model a single door: `run_shell`. Reading a file meant being asked over and over; editing code meant `echo >` / `sed`, with no way to see what changed and a confirmation that only ruled on the whole command. Day 4 splits out both ends at once: **reads** go through confirmation-free dedicated tools (`ls` / `read` / `glob`), **writes** go through a dedicated channel that shows a diff before touching disk (`write` / `patch`), and, while at it, the seven tools accumulated so far are unified into a single registry. On this day, the model completes a read → modify → verify loop for the first time.

## 0. Why the Same Shell Can't Carry Both Reads and Writes

Put yourself in the model's shoes: to change code, the first step is always **figuring out what the project looks like**. Yet even just to `cat` a file, it has to call `run_shell` first and then wait for a `y/N`. One confirmation per file read, ten for ten files — clicking through confirmations alone is exhausting.

Think one layer deeper: reading itself has zero destructive power — looking at a file can never damage the machine. Yet in order to get work done, reads and writes ended up bundled into the same opening — `run_shell` lets any command through, so it can **never be set confirmation-free**. A harmless operation ends up squeezed in with dangerous commands, and every file read earns a "may I read this?" — that is the rough edge of Day 3.

The writing side is even more awkward. When the model really wants to edit code, what it can still use is `echo >` / `sed`, and that carries three unsolvable knots:

1. **What changed cannot be previewed**. The moment you hit enter on `sed -i 's/foo/bar/' day4/x.ts`, whether the edit landed where intended is unknown until you `read` the file again after writing. At its core it is an invisible act of destruction.
2. **The confirmation granularity is too coarse**. `y/N` rules on the **entire command**; a single `sed` can easily change ten places in one go, while the human can only give one "yes". Seeing exactly which lines the model intends to touch? Not a chance.
3. **Mistakes fail silently**. The model juggles regexes and line numbers over a file hundreds of lines long; one character off and the file quietly breaks, with no way back (rollback comes later).

The problem is now clear: reads and writes share `run_shell`, and the permission granularity is too coarse. We turn reads into dedicated tools with no write capability; writes also get dedicated tools, which show a diff before touching disk.

| | General-purpose `run_shell` | Dedicated file tools |
|---|---|---|
| Capability | one command can do almost anything | each tool does exactly one thing |
| Reading files | the whole command still needs confirmation | `read` passes straight through |
| Writing files | no view of the concrete changes before execution | `write` / `patch` show a diff first |
| Arguments | a string of shell | structured fields like path and content |

Mainstream coding agents typically keep both kinds of tools: dedicated tools handle the high-frequency, controllable file operations, while the shell covers general tasks like testing and building. This is not abandoning the shell — it is carving reads and writes out of its overly broad reach.

## 1. Goal: Five File Tools + One Registry

Acceptance criteria:

1. `ls` lists directories, `glob` finds files by pattern, `read` reads text; large files can continue from an `offset` — none of these three operations needs confirmation;
2. `write` handles whole-file writes, `patch` locates local edits with unique old text; both show a diff first and only touch disk after confirmation;
3. A new tool only needs to call `registerTool`; `toOpenAITools` and `execTool` generate the model-facing list and the execution implementation from the same table.

**Lines of code for the day**: 570 lines across 5 source files (Day 3 was 359, a **net gain of 211 lines**), with most of the growth in `day4/tools.ts` (142 → 353 lines).

## 2. Design: Why Dedicated File Tools

### 2.1 Reads: Freeing the Harmless Operations

Is "confirmation-free" a loosening of control or a tightening? The answer is the latter. What we have worried about all along was never "the model reading a file" but "the model sneaking in some other command" — all of that concern lived inside the shell's `run`. Once reads are split out, these three tools' `run` functions call only `readdir` / `readFile` / `glob` from the moment they are written — **no write path exists** — so the confirmation mechanism only has to watch one opening: `run_shell`. The commands that genuinely need a decision (the shell) actually come under tighter focus.

The second reason for the split is **structured output**. For the same file-hunting job, making the model run `ls -R` and reverse-engineer the directory tree from text versus calling `glob '**/tools.ts'` and getting back a ready-made list of paths — those are two different worlds. Same for `read`: what comes back is a text slice carrying metadata like "N chars in total / read segment a-b", so the model knows exactly which part of the whole file it has read and which part is still missing.

`run_shell` of course stays — no old capability is deleted; its description just gains one line, "prefer ls / read / glob for pure file viewing", nudging the model to pick the better tool.

### 2.2 Writes: See the Diff Before Crossing the Door

For reads the principle was "harmless operations shouldn't be questioned over and over"; for writes it flips — **a destructive operation needs more than a "may I?"; the human has to see exactly what will be touched**. Hence the idea behind the write tools: have the model express "what changes this time" as something visible — a diff, a line-by-line comparison of old vs new content where removed lines and added lines are obvious at a glance. Show it to the user first, then touch disk after confirmation.

Writes are split across two tools: `write` takes `path` + `content` and handles creating a file or replacing it wholesale; `patch` takes a `hunks` array and locates local replacements with `{ old, new }`. Separated this way, a model editing one line does not need to resend the entire file, and the confirmation UI can show only the relevant changes.

The `confirm` line in `run_shell` stays exactly as it was — the two write tools and the shell share the same confirmation abstraction.

### 2.3 What patch Anchors On: Unique Text Snippets, Not Line Numbers, Not Regexes

How does the model tell the code "this is where I want to make my change"? Three candidates:

- **Line numbers**: `read` carries no line numbers at all, so the model has no idea what sits on which line; even with them, miscounting is routine.
- **Regexes**: escaping to worry about, greedy matching to fear — a high chance the model gets it wrong, and painful to debug.
- **Unique text snippets**: the model has just `read` the file, so it can copy a stretch of the original text as the anchor (with enough context) — the closest match to what it actually saw.

So we pick the third: each `old` must appear in the file exactly once. Not found means the file in the model's memory is out of sync with disk; matched in several places means the anchor is too short — ask it for more context. The patch tools of the OpenAI / Claude generation of coding agents follow the same idea; we implement only its simplest form.

### 2.4 Where the Diff Preview Comes From: Prefix/Suffix Trimming, No Algorithm

"Show a diff before writing" sounds like it demands a diff algorithm — the classic LCS or Myers both take dozens of lines plus a fair amount of memory risk. Is it worth it?

Look at the three operations the model will actually perform: create, rewrite wholesale, tweak one spot. For these three cases, the **plainest** possible approach suffices: split old and new text into lines, chop off the fully identical common prefix and the fully identical common suffix, and whatever remains in the middle is the change — old lines marked `-`, new lines marked `+`, with 3 lines of context kept on each side. The cost: if the model makes edits at several distant points in one go, trimming pulls the untouched stretch in between into the "change" as paired `-unchanged line` `+unchanged line` pairs — readability drops, but no information is lost. Rolling out a full algorithm for a rare edge case goes against "less but better". A 100-line display cap is also added, so overwriting an entire large file cannot flood the screen.

### 2.5 Seven Tools, Gathered into One Registry

The tool count grew from 1 on Day 2 to 7 today, yet `TOOLS` is still one flat, public array. Two problems surface:

1. **"Adding a tool" is not an action**: from now on everyone will casually edit the array, and one slip-up with a duplicate name silently overwrites the old tool — what the model sees and what executes diverge.
2. **Too many entrances**: the `TOOLS` array gets referenced all over the place, bypassing the two exits `toOpenAITools` / `execTool`, and the listing and the dispatch drift out of sync.

So the array is folded into a private registry: adding a tool must go through `registerTool(tool)`, and a duplicate name throws immediately; `toOpenAITools` and `execTool` read from the same table. From now on the outside world only knows these two openings, and nobody touches the array directly.

## 3. Implementation: Effect First, Then Code

### 3.0 Read-Only Tools in the Terminal

Here is what the terminal actually shows after a run — the three read-only tools never trigger a single confirmation:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › Use ls on the current directory, then glob for "day4/*.ts", then read the beginning of day4/index.ts</span>
<span style="color:#00cd00">I'll do these three steps in order: list the directory → glob for files → read the file contents.</span>
<span style="color:#cdcd00">[calling tool ls → 20 entries in total:</span>
<span style="color:#cdcd00">.geekagent/</span>
<span style="color:#cdcd00">.git/</span>
<span style="color:#cdcd00">day1/</span>
<span style="color:#cdcd00">day2/</span>
<span style="color:#cdcd00">day3/</span>
<span style="color:#cdcd00">day4/</span>
<span style="color:#cdcd00">day5/</span>
<span style="color:#cdcd00">day6/</span>
<span style="color:#cdcd00">dist/</span>
<span style="color:#cdcd00">doc/</span>
<span style="color:#cdcd00">node_modules/</span>
<span style="color:#cdcd00">scripts/</span>
<span style="color:#cdcd00">.env</span>
<span style="color:#cdcd00">.env.example</span>
<span style="color:#cdcd00">.gitignore</span>
<span style="color:#cdcd00">AGENTS.md</span>
<span style="color:#cdcd00">package-lock.json</span>
<span style="color:#cdcd00">package.json</span>
<span style="color:#cdcd00">README.md</span>
<span style="color:#cdcd00">tsconfig.json]</span>
<span style="color:#cdcd00">[calling tool glob → Matched 5 files:</span>
<span style="color:#cdcd00">day4/chat.ts</span>
<span style="color:#cdcd00">day4/color.ts</span>
<span style="color:#cdcd00">day4/config.ts</span>
<span style="color:#cdcd00">day4/index.ts</span>
<span style="color:#cdcd00">day4/tools.ts]</span>
<span style="color:#cdcd00">[calling tool read → (file is 2182 chars in total, read segment 0-2000)</span>
<span style="color:#cdcd00">import { createInterface } from 'node:readline';</span>
<span style="color:#cdcd00">import 'dotenv/config';</span>
<span style="color:#cdcd00">import { loadConfig } from './config.js';</span>
<span style="color:#cdcd00">import { Chat } from './chat.js';</span>
<span style="color:#cdcd00">...</span>
<span style="color:#cdcd00">rl.on('close', () => {</span>
<span style="color:#cdcd00">    out('sys', 'bye'</span>
<span style="color:#cdcd00">...(truncated, continue reading with offset=2000)]</span>
<span style="color:#00cd00">All three steps are done, and not once did a confirmation pop up along the way. To summarize:</span>
<span style="color:#00cd00"></span>
<span style="color:#00cd00">1. The current directory has 20 entries in total; day1~day6 are the per-day code directories, plus .geekagent/, dist/, doc/, scripts/, node_modules/ and more</span>
<span style="color:#00cd00">2. day4 has 5 .ts source files</span>
<span style="color:#00cd00">3. index.ts is 2182 chars in total; the first 2000 chars are read, and reading can continue from offset=2000</span>
<span style="color:#00cdcd">You › </span>
</pre>

The key effect is confirmation-free all the way through: the three `run` functions touch only `readdir` / `readFile` / `glob` from start to finish — no `confirm()`, no file-writing APIs. "Refuse to write" is baked into the bones.

### 3.1 The Three Read-Only Tools: ls / read / glob

All the changes land in `day4/tools.ts`. Three read-only tools are registered into the registry that `registerTool` fills; full definitions below:

```ts
// day4/tools.ts
    {
        name: 'ls',
        description: 'List the entries of a directory (read-only). Defaults to the current directory; directory entries get a / suffix, directories first.',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Directory path to list; defaults to the current directory.' } },
            additionalProperties: false,
        },
        run: async (args) => {
            const dir = String(args.path ?? '.').trim() || '.';
            try {
                const entries = await readdir(dir, { withFileTypes: true });
                if (entries.length === 0) return '(empty directory)';
                const lines = entries
                    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
                    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
                return `${lines.length} entries in total:\n${lines.join('\n')}`;
            } catch (err) {
                return `Failed to open directory: ${(err as NodeJS.ErrnoException).message}`;
            }
        },
    },
```

```ts
// day4/tools.ts
    {
        name: 'read',
        description: 'Read the contents of a text file (read-only). Large files are truncated automatically; pass offset to continue reading from a given character offset.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path of the file to read.' },
                offset: { type: 'number', description: 'Start reading at this character offset; defaults to 0. For reading large files in segments.' },
            },
            required: ['path'],
            additionalProperties: false,
        },
        run: async (args) => {
            const file = String(args.path ?? '').trim();
            if (!file) return 'Missing argument: path';
            const offset = Math.max(0, Number(args.offset) || 0);
            try {
                const text = await readFile(file, 'utf8');
                if (offset >= text.length) return 'offset is past the end of the file';
                const slice = text.slice(offset, offset + MAX_OUTPUT_CHARS);
                const truncated = offset + slice.length < text.length;
                const meta = `(file is ${text.length} chars in total, read segment ${offset}-${offset + slice.length})\n`;
                const hint = truncated ? `\n...(truncated, continue reading with offset=${offset + slice.length})` : '';
                return meta + slice + hint;
            } catch (err) {
                return `Failed to read file: ${(err as NodeJS.ErrnoException).message}`;
            }
        },
    },
```

```ts
// day4/tools.ts
    {
        name: 'glob',
        description: 'Find file paths by wildcard pattern (read-only, no contents). * matches any string within one level, ? matches a single character, ** matches directories at any depth; searches from the current directory by default, skipping node_modules and hidden paths.',
        parameters: {
            type: 'object',
            properties: { pattern: { type: 'string', description: 'A glob pattern, e.g. "day4/*.ts" or "**/tools.ts".' } },
            required: ['pattern'],
            additionalProperties: false,
        },
        run: async (args) => {
            const pattern = String(args.pattern ?? '').trim();
            if (!pattern) return 'Missing argument: pattern';
            try {
                const files: string[] = [];
                for await (const p of glob(pattern, {
                    cwd: process.cwd(),
                    exclude: (dir) => dir.includes('node_modules'),
                })) {
                    files.push(p.replaceAll('\\', '/'));
                    if (files.length >= MAX_GLOB_RESULTS) break;
                }
                if (files.length === 0) return '(no files matched)';
                const list = files.join('\n');
                const hint = files.length >= MAX_GLOB_RESULTS ? `\n...(hit the limit of ${MAX_GLOB_RESULTS} entries; try a more precise pattern)` : '';
                return `Matched ${files.length} files:\n${list}${hint}`;
            } catch (err) {
                return `glob failed: ${(err as Error).message}`;
            }
        },
    },
```

The accompanying constants and imports are tiny, appended at the top of the file:

```ts
// day4/tools.ts
import { readdir, readFile, glob, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
```

```ts
// day4/tools.ts
/** Max entries glob may return, so the context never floods in one shot. */
const MAX_GLOB_RESULTS = 200;
```

Key points:

- **Where "confirmation-free" comes from**: the three `run` functions touch only `readdir` / `readFile` / `glob`; there is no write path at all, so there is simply nothing to confirm.
- **The truncation semantics of `read`**: the returned header always carries the metadata `(file is N chars in total, read segment a-b)`, so the model knows at a glance "which slice of the whole file I am looking at"; when the read is truncated, the trailing hint tells it exactly what `offset` to pass next — the baton the model uses to organize multi-turn segmented reads.
- **`glob`'s `**`**: `**/tools.ts` fetches the same-named files across `day2`~`day6` in one call — far more reliable than recursively running `ls` and inferring. `exclude` keeps `node_modules` out; hidden paths (like `.git`) are excluded by Node glob's default `dot: false`. It is the glob built into Node's `fs/promises` — zero dependencies.

### 3.2 Nudging the Model Toward the Read-Only Tools

With the read-only tools live, the tool description and the help text still need to tell the model and the user how to use them:

1. A nudge is appended to the end of `run_shell`'s description, so the model prefers the read-only tools when it is "just looking at files":

```ts
// day4/tools.ts
        description: 'Run a shell command locally (bash -c) and return the combined stdout/stderr. Asks the user for confirmation before running. For pure file viewing, prefer ls / read / glob (read-only, confirmation-free).',
```

2. The `/help` text in `index.ts` gains the read-only tool list:

```ts
// day4/index.ts
Connected tools: get_current_time (current time), run_shell (run a shell command, needs confirmation before running), ls (list a directory), read (read a file), glob (find files by wildcard) — the latter three are read-only and confirmation-free; the model calls them automatically when needed.
```

### 3.3 The Write Tools in the Terminal

Below is the real terminal output from a run carrying the two write tools (the diff preview shows up before confirmation; only after entering `y` does the model actually write to disk):

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › Create demo.txt with three lines: line1 hello, line2 world, line3 end, then change the second line to line2 CHANGED.</span>
<span style="color:#cdcd00">+line1 hello</span>
<span style="color:#cdcd00">+line2 world</span>
<span style="color:#cdcd00">+line3 end</span>
<span style="color:#cdcd00">Confirm write to demo.txt? [y/N] y</span>
<span style="color:#cdcd00">[calling tool write → Wrote demo.txt]</span>
<span style="color:#cdcd00"> line1 hello</span>
<span style="color:#cdcd00">-line2 world</span>
<span style="color:#cdcd00">+line2 CHANGED</span>
<span style="color:#cdcd00"> line3 end</span>
<span style="color:#cdcd00">Confirm write to demo.txt? [y/N] y</span>
<span style="color:#cdcd00">[calling tool patch → Applied 1 edit to demo.txt]</span>
<span style="color:#00cd00">**Done:**</span>
<span style="color:#00cd00">1. write created demo.txt with three lines:</span>
<span style="color:#00cd00">line1 hello / line2 world / line3 end</span>
<span style="color:#00cd00">2. patch replaced line2 world with line2 CHANGED — 1 edit applied.</span>
<span style="color:#00cd00">The final contents of demo.txt:</span>
<span style="color:#00cd00">```text</span>
<span style="color:#00cd00">line1 hello</span>
<span style="color:#00cd00">line2 CHANGED</span>
<span style="color:#00cd00">line3 end</span>
<span style="color:#00cd00">```</span>
</pre>

This replay shows three core behaviors:

- When a file is created, `write`'s diff is all `+`; the second call, `patch`, produces the skeleton of a standard diff: context lines → `-` old lines → `+` new lines → trailing context (that last ` line3 end` line).
- The model can call `write` directly, continue with `patch` once the result arrives, and only then give its unified answer.
- The current terminal does not render Markdown, so the model's `**` and code fences are displayed as-is.

All the changes land in `day4/tools.ts` (a net gain of 211 lines), plus a few strings in `index.ts`.

### 3.4 The Tool Registry: 7 Lines That Make "Adding a Tool" an Explicit Action

Below the `Tool` interface, add the registry and its register function; the original `export const TOOLS` array is folded back into a module-internal `BUILTIN_TOOLS`, registered in one go at the end:

```ts
// day4/tools.ts
/** The tool registry. New tools go through registerTool; duplicate names throw immediately. */
const registry: Tool[] = [];

export function registerTool(tool: Tool): void {
    if (registry.some((t) => t.name === tool.name)) throw new Error(`Tool ${tool.name} is already registered`);
    registry.push(tool);
}
```

```ts
// day4/tools.ts
/** The built-in tools: registered one by one into the registry, after which the model can call them automatically. */
const BUILTIN_TOOLS: Tool[] = [
    // ... the three tools from Days 2 and 3 sit inside untouched, not one character changed
    {
        name: 'ls',
        // ... the three read-only tools, see 3.1
    },
    {
        name: 'write',
        // ... the full write tool, see 3.5
    },
    {
        name: 'patch',
        // ... the full patch tool, see 3.6
    },
];

BUILTIN_TOOLS.forEach(registerTool);
```

- **Duplicate-name protection** is new behavior: before, two same-named tools in the array meant the later one silently overwrote the earlier; now `registerTool` throws on the spot, keeping "the listing and the dispatch disagreeing" out at the registration step.
- The old tools are **untouched word for word**; they only downgrade from "public export" to "module-internal list". The only outward change is that the two exits, `toOpenAITools` / `execTool`, now read from the registry — see 3.8.

### 3.5 `write`: Whole-File Writing, Full Code

```ts
// day4/tools.ts
    {
        name: 'write',
        description: 'Write or fully overwrite a text file. Shows a diff of old vs new content and asks for confirmation; creates missing parent directories automatically; best for new files or full rewrites — prefer patch for small edits.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path of the file to write.' },
                content: { type: 'string', description: 'The new, complete contents of the file (the original is replaced wholesale).' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
        },
        run: async (args) => {
            const file = String(args.path ?? '').trim();
            if (!file) return 'Missing argument: path';
            const wrote = await commitWrite(file, String(args.content ?? ''));
            return wrote ? `Wrote ${file}` : 'Write cancelled';
        },
    },
```

Key points:

- **`run` is only four lines**: validate the arguments → hand off to the shared `commitWrite` (covered in 3.7; it handles "read old → compute diff → confirm → write to disk") → return a result depending on whether the write really happened. The confirmation logic does not live here.
- Two possible result strings: a real write returns `Wrote ${file}`, a declined write returns `Write cancelled`. The model can plan its next move from these.

### 3.6 `patch`: Precise Local Edits, Full Code

`hunks` is an array of `old` + `new` objects, applied one by one. First, the accompanying type and constant:

```ts
// day4/tools.ts
/** Max lines shown in the pre-write diff preview, so a whole-file overwrite cannot flood the screen. */
const MAX_DIFF_LINES = 100;

/** A single patch hunk: replace the uniquely occurring old with new in the file. */
interface PatchHunk {
    old: string;
    new: string;
}
```

The full tool definition:

```ts
// day4/tools.ts
    {
        name: 'patch',
        description: 'Make local edits to an existing text file: each { old, new } in hunks replaces the uniquely occurring old snippet with new. Shows a diff and asks for confirmation before applying; old must match exactly once in the file, otherwise that hunk fails.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path of the file to modify.' },
                hunks: {
                    type: 'array',
                    description: 'List of edit hunks: each hunk replaces the uniquely matched old with new.',
                    items: {
                        type: 'object',
                        properties: {
                            old: { type: 'string', description: 'The original snippet to replace, which must match uniquely (include enough context).' },
                            new: { type: 'string', description: 'The replacement text.' },
                        },
                        required: ['old', 'new'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['path', 'hunks'],
            additionalProperties: false,
        },
        run: async (args) => {
            const file = String(args.path ?? '').trim();
            if (!file) return 'Missing argument: path';
            const hunks = (Array.isArray(args.hunks) ? args.hunks : []) as PatchHunk[];
            if (hunks.length === 0) return 'hunks is empty; nothing was changed';
            let original: string;
            try {
                original = await readFile(file, 'utf8');
            } catch (err) {
                return `Failed to read file: ${(err as Error).message}`;
            }
            let patched = original;
            for (const h of hunks) {
                if (!h.old) return 'hunks contains an empty old snippet';
                const i = patched.indexOf(h.old);
                if (i < 0) return `Snippet not found: ${truncate(h.old)}`;
                if (patched.indexOf(h.old, i + 1) >= 0) return `Snippet matched in multiple places; lengthen old to make it unique: ${truncate(h.old)}`;
                patched = patched.slice(0, i) + h.new + patched.slice(i + h.old.length);
            }
            if (patched === original) return 'The resulting content is identical to the original file; nothing was changed';
            const wrote = await commitWrite(file, patched);
            return wrote ? `Applied ${hunks.length} edits to ${file}` : 'Edit cancelled';
        },
    },
```

A few implementation details:

- **Uniqueness is a two-question check**: the first, `indexOf < 0`, tests "not found"; the second, `indexOf(h.old, i + 1)`, tests "a second occurrence exists". Both return explicit error text, with overlong snippets cut down by `truncate` so a huge chunk of the original does not get stuffed back into the context. These errors travel the "result text" channel — the model reads them and corrects itself. This is exactly what the anchor strategy chosen in 2.3 looks like in practice.
- **Edits are cumulative**: `patched` starts out equal to the original file, and each hunk keeps searching and replacing on top of the previous one — so when several hunks cover different spots in the file, each one lands.
- Finally it also hands off to `commitWrite`, which uniformly takes care of the diff, the confirmation, and the disk write.

### 3.7 The Shared Foundation of the Two Write Tools: commitWrite + simpleDiff

`write` and `patch` take different roads to the same place: both end up calling the same function. It does exactly four things: read the old content → compute the diff → show it + confirm → write to disk. Full code:

```ts
// day4/tools.ts
/** Show the diff, confirm, then write to disk; new files go through the same flow. If the content is unchanged, the user is not bothered and success is returned directly. */
async function commitWrite(file: string, next: string): Promise<boolean> {
    let oldtxt = '';
    try {
        oldtxt = await readFile(file, 'utf8');
    } catch {
        /* new file: the old content counts as empty */
    }
    if (oldtxt === next) return true;
    if (!(await confirm(`\n${simpleDiff(oldtxt, next)}\nConfirm write to ${file}?`))) return false;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next);
    return true;
}
```

Key points:

- **New files take the same path**: if reading the old content fails (the file does not exist), the old content is treated as an empty string and the diff naturally comes out all `+` — creating and overwriting are one logic, not two.
- **Confirmation reuses Day 3's `confirm`**: `\n{diff}\nConfirm write to ...` goes in as a single prompt, and `buildCliConfirm` prints it verbatim and waits for `[y/N]`. The function's signature has not changed, and neither has the place where the permission model will replace it.
- **Parent directories are created automatically**: `mkdir(dirname(file), { recursive: true })` — when the model writes `day4/foo/bar.ts`, it does not have to create `day4/foo` first.

Then the diff preview itself — the algorithm without an algorithm:

```ts
// day4/tools.ts
/** Split text into lines: drop the empty string a trailing newline would produce; empty text returns an empty array. */
const splitLines = (s: string): string[] => (s === '' ? [] : s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));

/**
 * Minimal diff: chop off the common prefix and the common suffix; what remains is the change, with 3 lines of
 * context on each side. Covers only the most common scenario (create / overwrite / small local tweaks) — good enough and zero dependencies.
 */
function simpleDiff(oldText: string, newText: string): string {
    const a = splitLines(oldText), b = splitLines(newText);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let q = 0;
    while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
    const ctx = 3, out: string[] = [];
    for (let i = Math.max(0, p - ctx); i < p; i++) out.push(' ' + a[i]);
    for (let i = p; i < a.length - q; i++) out.push('-' + a[i]);
    for (let i = p; i < b.length - q; i++) out.push('+' + b[i]);
    for (let i = Math.max(0, b.length - q); i < Math.min(b.length, b.length - q + ctx); i++) out.push(' ' + b[i]);
    if (out.length > MAX_DIFF_LINES) {
        out.length = MAX_DIFF_LINES;
        out.push(`...(diff too long, showing only the first ${MAX_DIFF_LINES} lines)`);
    }
    return out.join('\n');
}
```

Understanding it takes three steps:

- **`p` is the common prefix length, `q` the common suffix length**: two `while` loops advance from the two ends, skipping lines that are identical on both sides. What lies between them (`p` to `a.length - q`, and `p` to `b.length - q`) is the real change region.
- **Four output sections**: 3 lines of context before the change → `-` old lines → `+` new lines → 3 lines of context after. Look back at the demo: `line1 hello` is the prefix, `-line2 world` the deletion, `+line2 CHANGED` the addition, ` line3 end` the trailing context — exactly four sections, all present.
- **`splitLines` does exactly one thing**: throw away the empty string produced by the trailing newline of `a\nb\n`, so no phantom empty line sneaks into the diff.

### 3.8 Rebinding the Two Exits to the Registry + Two Lines of Copy in index.ts

`toOpenAITools` and `execTool` each change one reference — the array swapped for the registry, behavior unchanged:

```ts
// day4/tools.ts
// inside toOpenAITools():
return registry.map((tool) => ({
    // ... type, name, description, parameters — unchanged
}));

// inside execTool():
const tool = registry.find((t) => t.name === name);
```

The startup banner and `/help` also gain the two write tools, noting that a diff is shown and confirmation awaited before any write.

## 4. Verification

- `npm run typecheck`: confirm the type check passes.
- **Offline self-test** (no API key needed; it drives the tool layer directly, with `setConfirmFn` replacing confirmation with "print the diff preview and auto-approve"):

```bash
# Run from the repo root: glob finds every tools.ts, node_modules excluded
npx tsx -e "import('./day4/tools.js').then(async m => console.log(await m.execTool('glob', JSON.stringify({ pattern: '**/tools.ts' }))))"
# read with offset for segmented reading: returns segment 100-2100, header metadata correct
npx tsx -e "import('./day4/tools.js').then(async m => console.log((await m.execTool('read', JSON.stringify({ path: 'day4/index.ts', offset: 100 }))).split('\n')[0]))"
```

The read command prints only the first line, which should be `(file is 2182 chars in total, read segment 100-2100)`.

The write-tool pipeline (run it in a temp directory so repo files stay untouched; `setConfirmFn` replaces confirmation with "print the diff preview and auto-approve"):

```bash
mkdir -p /tmp/d5 && cd /tmp/d5
npx tsx -e "import('/home/daijie/git/geekagent/day4/tools.js').then(async m => {
  m.setConfirmFn(async (p) => { console.log(p); return true; });
  console.log(await m.execTool('write',  JSON.stringify({ path: 'd5.txt', content: 'line1 hello\nline2 world\nline3 end' })));
  console.log(await m.execTool('patch',  JSON.stringify({ path: 'd5.txt', hunks: [{ old: 'line2 world', new: 'line2 CHANGED' }] })));
  console.log(await m.execTool('patch',  JSON.stringify({ path: 'd5.txt', hunks: [{ old: 'nonexistent', new: 'x' }] })));
  console.log(await m.execTool('patch',  JSON.stringify({ path: 'd5.txt', hunks: [{ old: 'line', new: 'x' }] })));
})"
```

The expected output, in order:

- write: first prints the all-`+` diff preview, then returns `Wrote d5.txt`
- patch: first prints the four-section diff "context / `-` / `+`", then returns `Applied 1 edit to d5.txt`
- the second patch: returns `Snippet not found: nonexistent`
- the third patch: returns `Snippet matched in multiple places; lengthen old to make it unique: line`

- **Real conversation** (API key required): `npm run dev -- day4/index.ts`; first enter the prompt from 3.0 — "list the directory + glob + read the file" — three tools chaining coherently, confirmation-free the whole way; then enter the prompt from 3.3 — "write + patch". The model should call them in order, the diff shown in the terminal both times, and the write landing on disk after you enter `y`.

## 5. What We Didn't Do

- **Permission and directory isolation**: tools come in only two kinds, "read-only / needs confirmation", and they can still reach paths outside the workspace.
- **Undo / rollback**: no automatic backup before writing; a botched edit has to be recovered by hand.
- **Diff capability**: the preview only does prefix / suffix trimming — no line numbers or fine-grained differences like a standard diff.
- **File types**: reads and writes handle UTF-8 text only; binary files are not supported.

## 6. Next Step

The model can now "read, modify, verify" with dedicated tools. As file contents and tool results keep flowing into `history`, the next step is to control the context length while keeping as much of the key information from the early conversation as possible.
