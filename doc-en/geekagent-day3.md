---
lang: en
title: Build GeekAgent from Scratch — Day 3 Bash Tool
description: >-
  A 7-day from-scratch tutorial for building an Agent/Harness by hand in TypeScript. Day 3 wires up the model's first tool that touches the real machine: running shell commands locally, with three guardrails — timeout, output truncation, and confirm-before-run — so the Agent can finally take real action.
date: '2026-08-22 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 3: Letting the Model Act for Real — Bash Is All You Need

> Day 2 got the tool-calling loop working, but `get_current_time` was only a zero-risk demo. Day 3 wires up the model's first tool that touches the real machine: running shell commands locally, with three guardrails — timeout, output truncation, and confirm-before-run.

## 0. Where the Title Comes From: Bash Is All You Need

"Bash is all you need" is a popular slogan in the coding-agent community, riffing on "Attention is all you need", the famous line from the original Transformer paper. What it means is plain:

In the world of coding agents, once the model can run a single shell command, it effectively has every capability — reading files via `cat` / `head`, listing directories via `ls`, searching code via `grep` / `rg`, editing files via `echo >` / `sed`, running tests, installing dependencies, driving git, starting services… all of them are just a subcommand of bash. In other words, a working bash tool already **subsumes** every specialized tool coming later: `read`, `glob`, file writing, search. The phrase spread through takes like Andrej Karpathy's "give the model a terminal and that's basically enough", and it's why many early agents (SWE-agent among them) made bash their primary interface.

But the slogan is only half right: **bash being able to do a lot also means it can do a lot of damage**. `cat` and `rm -rf` come in through the same door, so commands the model generates cannot be handed straight to the system. We connect bash through `run_shell`, adding timeout, output truncation, and confirm-before-run, and we make confirmation a swappable function.

## 1. Why the Shell Can't Run Naked

`bash -c <command>` is one line by itself, but a command the model generates can go wrong, and it can reach beyond the workspace. We start with three most basic limits:

1. **Timeout**: if the model asks for `sleep 999` or a hanging command, without a timeout the "request → execute → return" loop blocks forever and the agent freezes.
2. **Output truncation**: ask the model to run `cat` on a multi-gigabyte log or `find /`, and stdout can instantly flood the context window, crowding out the entire conversation before it. Truncating at ~2000 characters is the safety net.
3. **Confirm before run**: the command might be `rm -rf`. For Day 3 a manual `y/N` prompt does the job, and the confirmation logic is **pulled out into its own function** — the permission model later (whitelist / ask / allow / deny) simply replaces it.

Industrial-grade implementations (Claude Code's Bash tool, OpenCode's bash tool) follow the same idea — they just come with more complete guardrails:

| | Production Bash tool | Day 3 demo |
|---|---|---|
| Isolation | sandbox or container | runs directly on the current machine |
| Long tasks | background tasks with resumable output | 10-second timeout |
| Output | streamed, structured stdout/stderr | merged, truncated to 2000 chars |
| Permission | rules, whitelists, or tiered confirmation | `y/N` before every run |

Both share the same core: "the model proposes a command, the program executes it under control". Day 3 gets this chain running with the least possible code, and does not dress it up as a production-ready shell sandbox.

## 2. Goal: Hand "Local Command Execution" to the Model

Day 3 does exactly one thing: **let the model execute a shell command locally through `run_shell` and read back the result**. From this point on, it can list directories, run tests, inspect processes, and change configuration.

Acceptance criteria:

1. When needed, the model calls the `run_shell` tool on its own and supplies the `command` argument
2. Before a command runs, the terminal shows a `y/N` prompt; declining means the command never runs
3. Commands have a timeout cap (10s), so the agent loop never hangs forever
4. Overlong output is truncated (2000 characters), so it can't flood the context

**Lines of code for the day**: 359 lines across 5 source files, with `tools.ts` at about 142 lines covering the shell tool, output truncation, and run confirmation.

## 3. Design: Confirmation Lives Inside the Tool

Day 2's tool loop can already handle any tool's `run`, so this round only adds the shell tool — the loop body stays untouched.

The key design decision: **confirmation happens inside the tool's `run`, not in the loop**.

```
chat.ts loop (unchanged from Day 2):
    for each turn:
        send request → receive stream → if complete tool_calls are present:
            call execTool(name, args) one by one
                ↓
        run_shell.run(args)  ← new in Day 3, invisible to the loop
            1. parse command
            2. await confirm(...)   ← injectable confirmation (the confirm called on this line is injected by setConfirmFn)
            3. run via bash -c (with timeout)
            4. merge stdout/stderr + truncate
            5. return the string
            ↓
        the result goes back with role=tool, and the model continues
```

This way `execTool` neither knows nor cares whether "this tool needs confirmation" — the details are fully encapsulated inside `run_shell.run`, which only calls a `confirm` function variable. When it's time to upgrade permissions, `setConfirmFn` swaps `confirm` for a whitelist/allow/deny implementation, and neither the loop nor any other tool needs to change.

## 4. Implementation: Tool and Confirmation in tools.ts, One Wiring Line in index.ts

Day 3's changes live mainly in `day3/tools.ts`: the new `run_shell` tool, output truncation, and injectable confirmation; `index.ts` injects the main REPL's readline as the confirmation implementation (see 4.3).

Running it produces the following in the terminal (colors reproduced with HTML):

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › List the files in the current directory for me</span>
<span style="color:#00cd00">Sure, let me list them...</span>
<span style="color:#cdcd00">[calling tool run_shell → ls]</span>
<span style="color:#cdcd00">About to run command: ls [y/N]</span>
<span style="color:#00cd00">The directory contains: chat.ts  config.ts  index.ts  tools.ts</span>
<span style="color:#00cdcd">You › </span>
</pre>

The changes cover the tool implementation in `tools.ts` plus one wiring line in `index.ts`.

### 4.1 New Dependencies and Constants

```ts
// day3/tools.ts
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Interface as ReadLine } from 'node:readline';

const execAsync = promisify(exec);

const SHELL_TIMEOUT_MS = 10_000;   // max runtime per command; the process is killed on timeout
const MAX_OUTPUT_CHARS = 2000;     // truncate output beyond this many characters to protect the context
```

### 4.2 `run_shell` Joins the `TOOLS` Array

`run_shell` is still registered in Day 2's `TOOLS`, and the calling loop executes it through the same `Tool` interface:

```ts
// day3/tools.ts
{
  name: 'run_shell',
  description: 'Run a shell command locally (bash -c) and return the combined stdout/stderr. Asks the user for confirmation before running.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The shell command to run' } },
    required: ['command'],
    additionalProperties: false,
  },
  run: async (args) => {
    const command = String(args.command ?? '').trim();
    if (!command) return 'Missing argument: command';

    if (!(await confirm(`About to run command: ${command}`))) {
      return 'Execution cancelled';
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_CHARS * 4,
      });
      return truncate([stdout, stderr].filter(Boolean).join('\n') || '(no output)');
    } catch (err) {
      const e = err as { message: string; stdout?: string; stderr?: string };
      const partial = [e.stdout, e.stderr].filter(Boolean).join('\n');
      return truncate(`Command failed (${e.message})\n${partial}`);
    }
  },
}
```

Only two points bear directly on the day's theme:

- **The timeout is delegated to `exec`**: once `timeout` is reached, the child process is killed, so the tool loop never waits forever.
- **stdout/stderr are merged**: the two streams are joined and sent back, so the model sees exactly what a terminal user would see (errors included).

### 4.3 Two Standalone Little Functions + One Incremental Change to index.ts

In `tools.ts`, the confirmation capability is implemented together with `truncate`:

```ts
// day3/tools.ts
/** Truncate output beyond the threshold, appending a note with the original length. */
function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...(output truncated, ${text.length} chars in total)`;
}

type ConfirmFn = (prompt: string) => Promise<boolean>;

let confirm: ConfirmFn = async () => false;   // default deny: without injection, nothing ever runs unconfirmed

/** Inject the interactive confirmation logic (the permission model can replace this later). */
export function setConfirmFn(fn: ConfirmFn): void {
  confirm = fn;
}

// Build the CLI confirmation on top of "the one" readline interface: attach a temporary line listener to read
// a single answer, remove it once read; the main rl never closes. A tools.ts-internal detail, not exported.
function buildCliConfirm(rl: ReadLine): ConfirmFn {
  return (prompt) =>
    new Promise<boolean>((resolve) => {
      const onLine = (raw: string) => {
        rl.removeListener('line', onLine);
        const ans = raw.trim().toLowerCase();
        resolve(ans === 'y' || ans === 'yes');
      };
      rl.on('line', onLine);
      rl.resume();
      out('tool', `${prompt} [y/N] `);   // confirmation prompt in yellow — a dangerous call you spot at a glance
    });
}

/** Install the CLI confirmation using the main REPL's readline interface (one call in index.ts). */
export function installCliConfirm(rl: ReadLine): void {
  setConfirmFn(buildCliConfirm(rl));
}
```

`truncate` is a pure function, lifting "overlong output" out of the main flow. `confirm` / `setConfirmFn` is Day 3's most important abstraction — called by `run_shell`, yet its signature has nothing to do with any specific tool. When the permission model arrives, its implementation simply changes from "ask every time" to "automatically allow/deny by whitelist", and the call site stays completely untouched.

Compared with Day 2, `index.ts` gains only this one wiring line (the rest of the REPL loop is kept as-is):

```ts
// day3/index.ts
import { installCliConfirm } from './tools.js';

installCliConfirm(rl);   // inject the main REPL's rl as the confirmation implementation
```

The `run` of `run_shell` only calls `confirm(...)` — it never touches `readline` or creates an interface. That is the key to Day 3 making confirmation a swappable abstraction while leaving the main REPL's stdin uncontested.

### 4.4 Terminal Colors: Reusing Day 1's color.ts

Day 3 writes no new coloring logic; it reuses Day 1's `color.ts` (`paint` / `out` / `err` plus the color table `C`), shared as-is by Days 1, 2 and 3. Yellow (`tool`) shows up in two places on Day 3:

1. **Tool-call progress lines**: the `[calling tool run_shell → ...]` line yielded by chat.ts is yellow, set apart from the model's prose (green); index.ts detects it by the leading `\n[calling tool`.
2. **Pre-run confirmation prompt**: in `buildCliConfirm` above, `out('tool', \`${prompt} [y/N] \`)` paints the confirmation prompt yellow — a visual cue that "a dangerous call needs a decision".

See the terminal example at the start of this section: both the tool-call progress line and the confirmation prompt are yellow, set apart from the model's prose (green).

## 5. Verification

- `npm run typecheck`: confirm the type check passes.
- Smoke test: run `npm run dev -- day3/index.ts` and ask "list the files in the current directory for me" (the model should call `run_shell` to run `ls`); the terminal shows a `y/N` prompt first, and after confirming the result comes back
- Guardrail self-tests:
  - run `sleep 11` → times out after about 10s and returns a failure message
  - run `cat <a big file>` → output truncated to 2000 characters
  - enter `n` at the confirmation → returns "Execution cancelled", and the command never ran

## 6. What We Didn't Do

- **Permission model**: confirmation is just "ask y/N every time"; there is no per-tool allow / ask / deny configuration yet.
- **Directory isolation**: the shell can reach any path; nothing confines it to the current workspace.
- **Streaming output**: a command's output comes back in one shot after it finishes.

## 7. Next Step

The shell can read and write files, but its reach is too broad — even read-only operations need confirmation. Next, we split the high-frequency file operations into specialized tools with explicit parameters, making reads smoother and writes easier to inspect.
