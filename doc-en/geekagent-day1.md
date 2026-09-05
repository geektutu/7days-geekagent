---
lang: en
title: Build GeekAgent from Scratch — Day 1 REPL Foundation
description: >-
  A 7-day build-an-Agent-from-scratch tutorial: hand-write the simplest possible Agent/Harness in TypeScript/Node.js, implementing a REPL loop and streaming multi-turn conversation from zero. This post covers what a REPL is, why it makes the right foundation for an Agent, and how readline plus an OpenAI-compatible API gets the first step, "being able to chat," running in under 160 lines of code.
date: '2026-08-20 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 1: The REPL Foundation of a "Simplest Possible" Agent

## 0. Where the Title Comes From: What Is a REPL

The **REPL** in the title is jargon, so let's pin it down first; everything else builds on it.

REPL stands for Read-Eval-Print-Loop, which reads out as "read → eval → print → loop". The command lines we use every day, the Python interactive interpreter, and typing `node` with no filename are all REPLs: type a line, get a reply, and the cursor lights up again waiting for the next line.

Why is a REPL the right foundation for an Agent? Because a conversation between human and model is at its core a "back-and-forth loop": we type, the model answers, we type again... A loop that keeps collecting input is exactly what a REPL is for. So Day 1 doesn't chase a fancy interface; it gets this "chat again and again" loop working first. Adding tools and file read/write later all amounts to teaching this loop new tricks.

## 1. Why Build This Project

Agents on the market today (OpenCode, Claude Code, Cursor and the like) are capable, but they increasingly feel like black boxes. I wanted to get hands-on and write an Agent from scratch, to see how little code an Agent that can actually "chat" needs.

So I set three ground rules:

1. **Simplest possible**: no Agent/CLI frameworks; the core dependencies are just two — "call the model" and "read environment variables".
2. **One feature per day**: each day delivers exactly one feature, runnable the same day.
3. **Additive, non-invasive**: every later day's feature builds on the previous day, never a rewrite from scratch.

## 2. Goal: REPL + Streaming Multi-turn Conversation

Day 1 lays the foundation and does exactly one thing: **make the model able to chat**. Here are the three acceptance criteria:

1. Run `npm run dev -- day1/index.ts` to enter the REPL; when an answer finishes, `You ›` reappears and we can keep asking;
2. As soon as the model generates a chunk, the terminal displays it immediately — no waiting for the complete answer to come back;
3. Say "remember my name is Zhang San" first, then ask "what's my name" and get the right answer; after running `/reset`, the same question no longer depends on the earlier conversation.

While we're here, two possibly unfamiliar terms:

- **Streaming**: the model doesn't hold its breath to produce the complete answer before releasing it — it sends pieces back while it generates. Seen the effect of characters popping out one by one in an input method while typing? A model's answer is the same: each chunk is displayed the moment it arrives, turning the experience from "staring at a spinner for ages" into "watching it think and talk at the same time".
- **Multi-turn memory**: the model is stateless by itself — it doesn't remember the previous turn. The so-called "memory" is us resending the conversation history along with every request. Day 1 lays this mechanism down; every later day leans on it.

**Lines of code for the day**: 4 source files, about 157 lines in total.

## 3. Design: Choices and a Few Decisions

### 3.1 Why This Tech Stack

- **Language**: TypeScript + Node.js 22. Our benchmark, OpenCode, is itself in the TS ecosystem; Node 22 was already on this machine, and file I/O and starting a REPL are both extremely fast.
- **Runtime**: `tsx` runs TS source directly — no compiling, no bundling; the lightest possible developer experience.
- **Model API**: the OpenAI-compatible API (the `baseURL` + `apiKey` + `model` trio). That means DeepSeek, Kimi, Ollama, and practically every model on the market plug right in; `deepseek-v4-flash` is only the default.
- **Zero frameworks**: not even `commander`/`inquirer`. The REPL uses Node's built-in `readline` — a hundred extra lines of code in exchange for a codebase where every line is understandable.

The final dependency list is just 5 packages:

```json
{
  "dependencies": {
    "dotenv": "^17.4.2",
    "openai": "^7.5.0"
  },
  "devDependencies": {
    "@types/node": "^26.3.0",
    "tsx": "^4.23.12",
    "typescript": "^7.0.2"
  }
}
```

### 3.2 Two Key Decisions

1. **history is exactly OpenAI's `messages` array, zero conversion**. This is Day 1's most important design decision, and every later day collects the dividends: multi-turn memory, tool calling, system prompts — all just entries with different `role`s appended to the same array.
2. **All colors live in one file**: every bit of terminal coloring stays inside `color.ts` alone; adding a color means editing one table, never polluting business code.

### 3.3 Why Not Just Use `curl`

One might think: isn't calling the model just firing an HTTP request? One `curl` line does the job — why write 157 lines?

Let's compare with the bare-bones way and spell out why each piece is necessary:

| | One-off `curl` | Day 1 REPL |
|---|---|---|
| Continuous conversation | Manually re-request every time | Automatically enters the next round after each input |
| Multi-turn memory | Manually stitch history together | `history` accumulates and is resent automatically |
| Streaming output | The response stream needs extra handling | Print each chunk the moment it arrives |
| Distinguishing messages | Input and output mixed together | User, model, and system each in their own color |

`curl` is perfect for checking the API is reachable, but repeated conversation needs an extra layer of state plus an interaction loop. `readline` keeps reading input, `history` keeps the context, and streaming iteration prints while receiving.

So we're not re-implementing an HTTP client; we're adding continuous interaction, history state, and streaming display around the model API.

## 4. Implementation: The Effect First, Then the Code

Running it shows the following in the terminal (colors reproduced with HTML):

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 1 — The Simplest Agent</span>
<span style="color:#00cdcd">You › Hello, remember my name is Zhang San.</span>
<span style="color:#00cd00">Hello Zhang San, I'll remember that.</span>
<span style="color:#00cdcd">You › What's my name?</span>
<span style="color:#00cd00">Your name is Zhang San.</span>
<span style="color:#00cdcd">You › /reset</span>
<span style="color:#808080">(Conversation memory cleared)</span>
<span style="color:#00cdcd">You › /exit</span>
<span style="color:#808080">bye</span>
</pre>

Day 1 contains 4 source files:

```
day1/                  # Day 1's project directory; one directory per day from here on
├── index.ts        # Entry point: the readline REPL loop
├── chat.ts         # The Chat class: streaming calls + context memory
├── config.ts       # Reads .env; exits with an error if the key is missing
└── color.ts        # Terminal coloring
```

### 4.1 chat.ts — One Class Governs Conversation and Memory

This maps to necessity points 1 and 2: it holds `history` (solving memory) and exposes the streaming method `streamReply` (solving streaming). Full contents:

```ts
// day1/chat.ts
async *streamReply(userInput: string): AsyncGenerator<string> {
  this.history.push({ role: 'user', content: userInput });
  try {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: this.history,   // full history sent on every turn
      stream: true,
    });

    let answer = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) { answer += delta; yield delta; }  // emit as chunks arrive
    }
    this.history.push({ role: 'assistant', content: answer });
  } catch (err) {
    this.history.pop();   // roll back on error, so history only ever holds paired exchanges
    throw err;
  }
}
```

The key here is `AsyncGenerator`:

- **AsyncGenerator**: `async function*` paired with `yield`; the caller's `for await` writes out one increment the moment it gets it — that's streaming. Each chunk the model emits is `yield`ed out for printing immediately.

### 4.2 The Shape of history: How a New Question Enters

`history` is just a plain array whose element format is **exactly identical** to the `messages` of the OpenAI Chat Completions API — which is why `messages: this.history` can be passed straight through as-is:

```ts
// day1/chat.ts (history data example)
[
  { role: 'user',      content: 'Remember my name is Zhang San' },
  { role: 'assistant', content: 'Got it, Zhang San.' },
  { role: 'user',      content: 'What is my name?' },
]
```

A new question follows the standard "one in, one out" flow:

1. The user's input is appended to `history` as `{ role: 'user', content }`;
2. The entire `history` is sent to the model in full (`messages: this.history` in code), and the model uses it to grasp the context;
3. When the streaming answer ends, the complete answer is appended back as `{ role: 'assistant', content }`.

So "multi-turn memory" involves no magic at all: the longer the conversation, the more context `history` carries. And because the format needs zero conversion against the API, adding a system prompt or tool call messages later is just appending entries with different `role`s to the same array.

### 4.3 config.ts — Three Lines of Configuration

`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` are read from environment variables; a missing key exits right away and suggests copying `.env.example`:

```ts
// day1/config.ts
import 'dotenv/config';

export interface Config {
    baseURL: string;
    apiKey: string;
    model: string;
}

/** Read model config from environment variables; exit with a hint if the API key is missing. */
export function loadConfig(): Config {
    const baseURL = process.env.OPENAI_BASE_URL?.trim() || 'https://api.deepseek.com';
    const apiKey = process.env.OPENAI_API_KEY?.trim() || '';
    const model = process.env.OPENAI_MODEL?.trim() || 'deepseek-v4-flash';

    if (!apiKey) {
        console.error('Missing OPENAI_API_KEY: copy .env.example to .env and fill it in.');
        process.exit(1);
    }

    return { baseURL, apiKey, model };
}
```

### 4.4 color.ts — Terminal Coloring, Input/Output Told Apart at a Glance

This maps to necessity point 4. Conversation alone isn't intuitive enough: if the user's typing and the model's reply share one color, you have to mentally reconstruct who said what when reading a sample. Coloring the terminal is the plainest and most effective readability upgrade, and it costs zero dependencies — terminal color is just the trio "escape sequence + text + reset sequence"; no library needed.

Full contents:

```ts
// day1/color.ts
/** Terminal coloring: auto-disabled when not a TTY (pipe / redirect) so logs stay clean. */
export const useColor = process.stdout.isTTY;

export const C = {
    reset: '\x1b[0m',
    user: '\x1b[36m', // cyan: user input
    model: '\x1b[32m', // green: model reply
    tool: '\x1b[33m', // yellow: tool calling progress
    sys: '\x1b[90m', // gray: system messages
};

/** Wrap a string in the given color and reset at the end. */
export function paint(color: keyof typeof C, s: string): string {
    return useColor ? `${C[color]}${s}${C.reset}` : s;
}

/** Write a chunk to stdout in the given color; append a newline when nl is true (used for whole messages). */
export function out(color: keyof typeof C, s = '', nl = false): void {
    process.stdout.write(paint(color, s) + (nl ? '\n' : ''));
}

/** Write one line (newline included) to stderr in the given color; used for errors. */
export function err(color: keyof typeof C, s: string): void {
    process.stderr.write(paint(color, s) + '\n');
}
```

A few points:

- **A color is just an escape code**: `\x1b[36m` means "cyan on", `\x1b[0m` means "reset"; whatever sits in between comes out colored. `paint` includes the reset, so what it writes is self-contained — "color on → content → reset" — with no worry that a forgotten reset will stain everything printed afterward.
- **One `out` covers all stdout output**: the `nl` parameter decides whether to append a newline — streaming increments use `out('model', delta)` (no newline, glued together piece by piece), whole messages use `out('sys', '...', true)` (newline appended). `err` goes to stderr and is reserved for errors.

Every output in `index.ts` goes through `out` / `err`: model replies in green, system messages in gray, and errors through `err` too:

```ts
// day1/index.ts
out('sys', '\n');                              // start a new line before the model reply
for await (const delta of chat.streamReply(line)) {
    out('model', delta);                       // model reply: green, glued together piece by piece
}
out('sys', '(Conversation memory cleared)', true);          // system message: gray, whole line
```

Colors are centralized in that one table `C` plus the three functions `paint` / `out` / `err`; adding a new color only requires touching `C`.

### 4.5 index.ts — The REPL Loop

This maps to necessity point 3: Node's built-in `readline` builds the REPL (solving the loop). A colored `You › ` prompt marks the input side, commands are dispatched (`/help` `/reset` `/exit`), and a `busy` flag keeps rapid-fire input from interleaving with streaming output. All output goes through `out` / `err` (coloring details in §4.4), and the model's reply is streamed out piece by piece with `out('model', delta)`. Full contents:

```ts
// day1/index.ts
import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { Chat } from './chat.js';
import { err, out, paint } from './color.js';

const config = loadConfig();
const chat = new Chat(config.baseURL, config.apiKey, config.model);

const rl = createInterface({ input: process.stdin, output: process.stdout });

// Mark the "user input" side with a colored prompt.
rl.setPrompt(paint('user', 'You › '));

let busy = false;

function printHelp(): void {
    out('sys', `Available commands:
  /help   Show help
  /reset  Clear this session's conversation memory
  /exit   Quit (same as Ctrl+C / Ctrl+D)
Type anything to chat with the model.`, true);
}

rl.on('line', async (raw) => {
    if (busy) return; // the previous turn is still streaming; ignore rapid-fire input
    busy = true;

    const line = raw.trim();
    if (line) {
        if (line.startsWith('/')) {
            switch (line) {
                case '/help':
                    printHelp();
                    break;
                case '/reset':
                    chat.reset();
                    out('sys', '(Conversation memory cleared)', true);
                    break;
                case '/exit':
                    rl.close();
                    return;
                default:
                    out('sys', `Unknown command: ${line} (type /help for help)`, true);
            }
        } else {
            try {
                out('sys', '\n'); // new line before the model reply
                for await (const delta of chat.streamReply(line)) {
                    out('model', delta);
                }
                out('sys', '\n');
            } catch (e) {
                err('sys', `\nRequest failed: ${(e as Error).message}`);
            }
        }
    }

    busy = false;
    rl.prompt();
});

rl.on('close', () => {
    out('sys', 'bye', true);
    process.exit(0);
});

out('sys', `GeekAgent Day 1 — The Simplest Agent (model: ${config.model}, type /help for commands)`, true);
rl.prompt();
```

## 5. Verification

- `npm run typecheck`: confirms the TypeScript type check passes.
- Start it and type `/help` and `/exit`: you see the help text and then `bye`.
- Ask "remember my name is Zhang San" and then "what's my name": confirm the second turn can use the first turn's history.

Just two commands to run (dependencies and config live at the repo root, one shared copy for the whole repo):

```bash
cp .env.example .env        # fill in the key once, at the repo root
npm run dev -- day1/index.ts
```

## 6. What We Didn't Do

No tool calling, no file read/write, no session persistence yet. Day 1 does exactly one thing: **chat**.

## 7. What's Next

For now the model can only answer from its training knowledge. Next, we let it request outside information from the program, then continue answering based on the real result.
