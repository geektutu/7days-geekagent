---
lang: en
title: Build GeekAgent from Scratch — Day 7 Lightweight TUI and Usage Panel
description: >-
  A 7-day tutorial on building an Agent from scratch, writing the simplest possible Agent/Harness in TypeScript. Day 7 gives the terminal a new desk: the program temporarily takes over the whole screen, the message stream lives on the left, and a usage panel stays permanently on the right — per-turn / total tokens and context usage stay visible while you chat, and the original terminal content is restored on exit.
date: '2026-08-26 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 7: Putting Usage on the Desk — a Lightweight TUI and a Persistent Panel

> For six days the terminal did nothing but append logs — you could not see how many tokens this turn used or how much context room was left. Today the program takes over the terminal: the message stream stays on the left, a usage panel resides permanently on the right, continuously showing per-turn / total tokens and context usage. On exit, the original terminal content is restored.

## 0. Why We Need a Place That "Stays on the Screen"

For six days the terminal had nothing "persistent". Each reply scrolls the output down a line, old content shrinks off-screen, and the screen forever shows only "the most recent stretch" — fine for chatting, until two things want to stay in front of our eyes at all times.

**The first is per-turn / total tokens.** The cost was never a secret: OpenAI-compatible APIs return `usage` at the end of a streaming request, as long as you pass `stream_options: { include_usage: true }`. But since Day 1 we never asked the API for that number — what each turn cost, and what it all added up to, ran on pure intuition.

**The second is context usage.** Day 5 compacts automatically once history passes a threshold. If the panel keeps showing the usage percentage, we can also run `/compact` proactively as we approach the window limit.

Both kinds of data need a fixed display, which an ordinary log stream cannot provide. So we use a full-screen TUI that separates the message area, the input area, and the status area; when new display-style state arrives later, it can join the right-side panel too.

## 1. Goals: One Desk + One Panel

Acceptance criteria:

- The left side of the TUI continuously shows user, model, and tool messages, and the right panel stays fixed and visible while messages scroll; a narrow terminal gives priority to the body and the input area;
- The panel shows the current model, session, context estimate, per-turn tokens, and total tokens; during streaming an estimate appears first, replaced by real values once the API returns usage;
- Typing, streaming replies, the tool `[y/N]` confirmation, and the existing session commands all happen in the same interface, and the original terminal is restored on exit.

**Lines of code for the day**: a net gain of 295 source lines over Day 6; new file `tui.ts` (216 lines).

## 2. Design: Why a TUI Library

### 2.1 Why the Project Takes On Its First UI Dependency

This is the first time the project pulls in a "UI" library. TUI stands for Terminal User Interface — an interface drawn directly in the terminal. For six days, whatever Node.js could solve went without extra libraries; this time is an exception, because drawing a usable terminal interface yourself means facing three unavoidable problems:

- **Mixed-width text (CJK vs. Latin)**. Latin letters usually take 1 column; CJK characters and full-width symbols take 2. Get the width wrong, and panel borders and the input cursor misalign.
- **Input and refresh must not fight each other**. Every small chunk the model emits updates the interface once; meanwhile, we may be typing and moving the cursor in the input box. If both sides write to the terminal directly, they easily overwrite each other.
- **Entering and leaving the full-screen interface**. On startup the program temporarily takes over the terminal; on exit it must restore the user's original terminal content, cursor, and input state. Different terminals, window resizes, and redirection all complicate this.

None of the three is core Agent capability — it is just infrastructure for laying output out neatly. Here we pick `@earendil-works/pi-tui`, extracted from the PI project: `TuiAltScreen` handles entering and leaving the temporary full-screen interface, and repaints only what changed; `ScrollView` handles scrolling messages; `Input` handles CJK input, the cursor, and editing keys; `HStack` / `VStack` arrange areas side by side and stacked. All we write is "what each block displays, and where Agent events go".

| | Hand-written ANSI TUI | Using pi-tui |
|---|---|---|
| Screen refresh | Compute the cursor and repaint regions yourself | Components handle differential repaints |
| Input editing | Handle key presses and CJK width yourself | Handled uniformly by `Input` |
| Layout | Compute rows and columns by hand | Composed with `HStack` / `VStack` |
| Dependencies and control | Zero dependencies, fully controllable | One more dependency, much less low-level interface code |

The cost, stated honestly: from here on there is one more dependency, and pi-tui is more than a layout toolkit — it also ships Markdown and other components this day never uses. What we get in return is complete TypeScript types, a module format directly compatible with the project, and continuously maintained terminal handling. It is used only by `tui.ts` and never leaks into the conversation, tool, or session code.

### 2.2 With pi-tui Taking Over, We Do Only Three Things

Layout, routing, data. The `TUI` class in `tui.ts` manages three parts:

- **Layout**: an `HStack` lays the message stream and the 28-column panel side by side, and a `VStack` puts the input row at the bottom; when the terminal is under 60 columns the panel hides automatically, keeping input and body usable.
- **Routing**: `Input` catches text, backspace, arrow keys, and paste; a `[y/N]` confirmation only swaps the prompt, and Enter hands the answer back to the waiting tool call through a promise.
- **Data**: the main area still stores only `{ text, color }`. Updates go to `Text` for wrapping and `ScrollView` for following the bottom; pi-tui can tell color codes apart from actually displayed text, and it knows a CJK character usually takes two columns.

### 2.3 Where the Tokens Come From: API Ground Truth + Character Estimation

The two kinds of numbers on the panel come from different sources:

- **Per-turn / total tokens**: the API-returned `usage` is authoritative. Streaming requests pass `stream_options: { include_usage: true }`, and the last chunk carries `usage`; the non-streaming history-compaction request returns it too. But during the few seconds of "actively streaming" there is no real value to be had, and the panel needs to tick in real time — so `estimateTokens` stands in with a character-based estimate, overwritten the instant the real value arrives.
- **Context usage**: `estimateTokens(JSON.stringify(history)) / CONTEXT_WINDOW`. When history is compacted thinner, the numerator falls — so the panel gives an intuitive view of what Day 5's "compaction" actually does; that is where character estimation earns its keep most.

`estimateTokens` is a single line: one CJK character ≈ 1 token, English ≈ 4 characters per token, and mixed text takes 2 characters per token. Good enough as a panel reference; the numbers that cost real money always come from the API.

## 3. Implementation: Effect First, Then Code

### 3.0 Terminal Demo

The first frame is right after startup: two hint lines in the main area, and the panel showing context `1% used`, per-turn / total 0 (the empty history serializes to the JSON `[]`, estimated at 1 token by the 2-characters-per-token rule, hence 1 / 64000; the percentage is rounded up):

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px;display:grid;grid-template-columns:minmax(0,1fr) 15rem">
<span style="color:#808080"> GeekAgent Day 7 — lightweight TUI + usage display</span><span style="color:#808080">│ Model  deepseek-v4-flash</span>
<span style="color:#808080"> Type /help for commands; the right panel shows usage in real time.</span><span style="color:#808080">│ Session  default</span>
<span style="color:#808080"></span><span style="color:#808080">│ ──── Context ────</span>
<span style="color:#808080"></span><span style="color:#808080">│ 1 / 64000 tokens</span>
<span style="color:#808080"></span><span style="color:#808080">│ 1% used</span>
<span style="color:#808080"></span><span style="color:#808080">│ ──── This turn ────</span>
<span style="color:#808080"></span><span style="color:#808080">│ 0 tokens</span>
<span style="color:#808080"></span><span style="color:#808080">│ ──── Total ────</span>
<span style="color:#808080"></span><span style="color:#808080">│ 0 tokens</span>
<span style="grid-column:1/-1;border-top:1px solid #808080;height:0"></span>
<span style="color:#00cdcd">You › </span><span style="color:#808080"></span>
</pre>

Ask "What time is it now?" — after the model calls the `get_current_time` tool to fetch the time and then answers, the main area gains a full exchange (question in cyan, tool progress in yellow, answer in green), and the panel refreshes in sync — per-turn / total 2329 tokens, context 188 / 64000:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px;display:grid;grid-template-columns:minmax(0,1fr) 15rem">
<span style="color:#808080"> GeekAgent Day 7 — lightweight TUI + usage display</span><span style="color:#808080">│ Model  deepseek-v4-flash</span>
<span style="color:#808080"> Type /help for commands; the right panel shows usage in real time.</span><span style="color:#808080">│ Session  default</span>
<span style="color:#00cdcd"> You › What time is it now?</span><span style="color:#808080">│ ──── Context ────</span>
<span style="color:#808080"></span><span style="color:#808080">│ 188 / 64000 tokens</span>
<span style="color:#808080"></span><span style="color:#808080">│ 1% used</span>
<span style="color:#cdcd00"> [tool call get_current_time → 2026/8/29 20:01:53]</span><span style="color:#808080">│ ──── This turn ────</span>
<span style="color:#00cd00"> It is now **August 29, 2026 20:01:53**</span><span style="color:#808080">│ 2329 tokens</span>
<span style="color:#00cd00"> (Asia/Shanghai local time).</span><span style="color:#808080">│ ──── Total ────</span>
<span style="color:#808080"></span><span style="color:#808080">│ 2329 tokens</span>
<span style="grid-column:1/-1;border-top:1px solid #808080;height:0"></span>
<span style="color:#00cdcd">You › </span><span style="color:#808080"></span>
</pre>

The two frames are just snapshots of two moments; the panel is **persistent**: every streamed character and every tool call refreshes the right side. Context tokens and the percentage grow as the conversation lengthens and fall back after `/compact` — one glance shows how much room compaction freed up (steps in the verification section).

Where the numbers come from: in that real trial run, the API `usage` was the sum of two requests (tool turn 1058, answer turn 1271 = 2329); the serialized history was about 376 characters, estimated to 188 tokens. Real models will naturally give different numbers, but the "API-provided + character-estimated" mechanism stays the same. Note that the `**…**` in the model's answer is markdown it emitted verbatim — we do no rendering (see the "not done" section).

### 3.1 tui.ts: the 216-Line Layout Engine

This version of pi-tui requires Node.js 22.19 or higher. The repo pins the version exactly, so even if the component APIs change later, this day's code stays reproducible:

```bash
npm install --save-exact @earendil-works/pi-tui@0.84.4
```

The only new source file for the day, in full:

```ts
// day7/tui.ts
import {
    HStack,
    Input,
    Key,
    matchesKey,
    ProcessTerminal,
    ScrollView,
    sliceByColumn,
    Text,
    TuiAltScreen,
    truncateToWidth,
    visibleWidth,
    VStack,
    type Component,
    type Focusable,
} from '@earendil-works/pi-tui';
import { paint } from './color.js';

export type Color = 'user' | 'model' | 'tool' | 'sys';

/** Rough token estimation: one CJK character ≈ 1 token, English ≈ 4 characters per token, mixed text takes 2 characters per token. */
export function estimateTokens(text: string): number {
    return Math.ceil([...text].length / 2);
}

interface Line {
    text: string;
    color: Color;
}

const PANEL_WIDTH = 28;
const MAX_LINES = 1000;

/** Fixed-width info panel on the right; hidden automatically by HStack on narrow terminals. */
class Panel implements Component {
    constructor(private getLines: () => string[]) {}

    render(width: number): string[] {
        return this.getLines().map((line) => paint('sys', `│ ${truncateToWidth(line, Math.max(1, width - 2))}`));
    }

    invalidate(): void {}
}

/** The input row joins the prompt with pi-tui's single-line Input and forwards focus to Input so CJK IME input works. */
class InputRow implements Component, Focusable {
    private input = new Input();
    private prompt: Color = 'user';
    private promptText = 'You › ';

    constructor(onSubmit: (value: string) => void) {
        this.input.onSubmit = onSubmit;
    }

    get focused(): boolean {
        return this.input.focused;
    }

    set focused(value: boolean) {
        this.input.focused = value;
    }

    setPrompt(color: Color, text: string): void {
        this.prompt = color;
        this.promptText = text;
    }

    takeValue(): string {
        const value = this.input.getValue().trim();
        this.input.setValue('');
        return value;
    }

    clear(): void {
        this.input.setValue('');
    }

    handleInput(data: string): void {
        this.input.handleInput(data);
    }

    render(width: number): string[] {
        const prompt = paint(this.prompt, this.promptText);
        const inputWidth = Math.max(1, width - visibleWidth(prompt));
        // Input ships with a "> " prefix; slice it off and put the project's own prompt in its place.
        const value = sliceByColumn(this.input.render(inputWidth + 2)[0] ?? '', 2, inputWidth, true);
        return [paint('sys', '─'.repeat(width)), `${prompt}${value}`];
    }

    invalidate(): void {
        this.input.invalidate();
    }
}

/**
 * Lightweight TUI: scrolling message stream on the left, persistent panel on the right, single-line input at the bottom.
 * Full-screen switching, partial repaints, CJK width, input editing, and window resizes are all left to pi-tui.
 */
export class TUI {
    private terminal = new ProcessTerminal();
    private screen = new TuiAltScreen(this.terminal, true, undefined, { mouse: true });
    private log = new Text('', 1, 0);
    private input: InputRow;
    private lines: Line[] = [];
    private panelLines: string[] = [];
    private busy = false;
    private exiting = false;
    private confirmQuestion: string | null = null;
    private confirmResolve: ((ok: boolean) => void) | null = null;

    constructor(
        private onLine: (line: string) => void,
        private onExit: () => void,
    ) {
        this.input = new InputRow(() => this.submit());
        const body = new HStack([
            {
                component: new ScrollView(this.log, { follow: 'end', primary: true, scrollbar: 'auto' }),
                basis: 0,
                grow: 1,
                minSize: 20,
            },
            {
                component: new Panel(() => this.panelLines),
                basis: PANEL_WIDTH,
                shrink: 0,
                visible: ({ width }) => width >= 60,
            },
        ], { gap: 1 });
        this.screen.setLayoutRoot(new VStack([
            { component: body, basis: 0, grow: 1, minSize: 1 },
            { component: this.input, basis: 2, shrink: 0 },
        ]));
        this.screen.addInputListener((data) => {
            if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
                void this.onExit();
                return { consume: true };
            }
        });
    }

    start(): void {
        this.screen.start();
        this.screen.setFocus(this.input);
    }

    stop(): void {
        if (this.exiting) return;
        this.exiting = true;
        this.screen.stop({ preserveScreen: true });
    }

    append(text: string, color: Color): void {
        for (const line of text.replace(/\r\n/g, '\n').split('\n')) this.lines.push({ text: line, color });
        if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
        this.render();
    }

    appendInline(text: string, color: Color): void {
        const last = this.lines[this.lines.length - 1];
        if (last && last.color === color) last.text += text;
        else this.lines.push({ text, color });
        this.render();
    }

    setPanel(lines: string[]): void {
        this.panelLines = lines;
        this.screen.requestRender();
    }

    setBusy(busy: boolean): void {
        this.busy = busy;
    }

    ready(): void {
        if (!this.busy && this.confirmQuestion === null) this.screen.setFocus(this.input);
    }

    confirm(prompt: string): Promise<boolean> {
        const parts = prompt.replace(/\r\n/g, '\n').split('\n').map((s) => s.trimEnd()).filter(Boolean);
        const question = parts.pop() ?? 'Confirm';
        for (const part of parts) this.append(part, 'tool');
        this.append(question, 'tool');
        this.confirmQuestion = question;
        this.input.setPrompt('tool', '[y/N] ');
        this.input.clear();
        this.screen.setFocus(this.input);
        this.screen.requestRender();
        return new Promise((resolve) => {
            this.confirmResolve = resolve;
        });
    }

    private submit(): void {
        const line = this.input.takeValue();
        if (this.confirmQuestion !== null) {
            const ok = line.toLowerCase() === 'y';
            const question = this.confirmQuestion;
            const resolve = this.confirmResolve;
            this.confirmQuestion = null;
            this.confirmResolve = null;
            this.input.setPrompt('user', 'You › ');
            const last = this.lines[this.lines.length - 1];
            if (last?.color === 'tool' && last.text === question) {
                last.text += ` → ${ok ? 'y' : 'n'}`;
                this.render();
            } else {
                this.append(`${question} → ${ok ? 'y' : 'n'}`, 'tool');
            }
            resolve?.(ok);
            return;
        }
        if (!line || this.busy) return;
        this.append(`You › ${line}`, 'user');
        this.onLine(line);
    }

    private render(): void {
        this.log.setText(this.lines.map((line) => paint(line.color, line.text)).join('\n'));
        this.screen.requestRender();
    }
}
```

Taken apart, four blocks:

- **Layout**. The `VStack` splits the screen vertically into "body + a two-row input", and the body's `HStack` splits horizontally into "a growable message area + a fixed 28-column panel". `visible` can read the terminal width every frame; below 60 columns the panel is not drawn, so the body never gets squeezed into a few columns.
- **Storing and drawing**. `append` splits text on `\n` and pushes the pieces into `lines`; `setPanel` only replaces panel data; `render()` wraps colors with the project's existing `paint` and hands the result to `Text` for wrapping. `ScrollView`'s `follow: 'end'` keeps streaming output pinned to the bottom, and `requestRender()` merely schedules the next interface update — no hand-assembled terminal control characters needed.
- **Streaming continuation via `appendInline`**. The model stream arrives as increments of "a word or two at a time"; appending each increment as a new line would shatter the answer into lines of two or three characters. `appendInline` attaches the increment to the end of the previous line when the colors match, so the answer flows into natural paragraphs; when the color changes for user / tool / system, a new line starts, giving natural paragraph breaks.
- **Input and confirmation**. `InputRow` keeps forwarding focus to the inner `Input`, so the IME candidate window can follow the real cursor. When a tool wants `[y/N]`, `confirm()` swaps `You › ` for `[y/N] `; Enter returns the answer through the promise, and "question → answer" is recorded as one yellow log line.

### 3.2 chat.ts: Reporting Usage Out

`Chat` used to work quietly, never asking about costs. Today we add one callback wire: the moment `usage` arrives, it is normalized into `{ prompt, completion, total }` and reported out for accumulation. The additions total 27 lines, in four places:

1. A new `UsageInfo` interface and the `onUsage` callback:

```ts
// day7/chat.ts
/** Usage info for a single request (mirrors OpenAI's usage field). */
export interface UsageInfo {
    prompt: number;
    completion: number;
    total: number;
}

…

  /** Day 7: report usage out as soon as each request receives it, for the TUI panel to accumulate and display. */
  private onUsage?: (u: UsageInfo) => void;
  …
  setUsageListener(fn: (u: UsageInfo) => void): void {
    this.onUsage = fn;
  }
```

2. Streaming requests pass `stream_options: { include_usage: true }`, and the chunk loop picks out the final one (only it carries usage):

```ts
// day7/chat.ts
          stream: true,
          stream_options: { include_usage: true }, // Day 7: the last chunk of the request carries this turn's usage
        });

…

          if (chunk.usage) this.reportUsage(chunk.usage); // only the last chunk carries usage
```

3. The non-streaming history-compaction request also returns usage, so report it while we are there:

```ts
// day7/chat.ts
      ],
    });
    this.reportUsage(res.usage);
    const text = res.choices[0]?.message?.content?.trim();
```

4. `reportUsage` normalizes the API's `prompt_tokens / completion_tokens / total_tokens` into `UsageInfo` and routes everything through the callback:

```ts
// day7/chat.ts
  /** Normalize the usage returned by the API into UsageInfo, and hand it to the external callback for accumulation. */
  private reportUsage(usage: OpenAI.CompletionUsage | null | undefined): void {
    if (!usage) return;
    this.onUsage?.({
      prompt: usage.prompt_tokens,
      completion: usage.completion_tokens,
      total: usage.total_tokens,
    });
  }
```

`reportUsage` only passes the API-returned numbers to the external callback; it changes nothing in the tool loop or the history-compaction flow.

### 3.3 index.ts: Wiring In the Existing Commands and State

The CLI layer changes from "printing with one `out(...)` at a time" to "pushing lines into the TUI"; the session logic does not move a single line. Wiring first:

```ts
// day7/index.ts
/** Usage state: live is the character-estimated increment while streaming; official totals follow the API usage. */
const usage = { cum: 0, round: 0, live: 0 };
/** The TUI accepts no new input while busy; this extra guard prevents async re-entrancy. */
let busy = false;

const tui = new TUI(onLine, onExit);
// Wire the tool layer's execution confirmation to the TUI: the default implementation "always refuses"; replace it with [y/N] on the input row
setConfirmFn((prompt) => tui.confirm(prompt));
chat.setUsageListener((u) => {
    usage.live = 0; // real usage has arrived, clear the streaming estimate to avoid momentary double counting
    usage.cum += u.total;
    usage.round += u.total;
    updatePanel();
});
```

`usage` is the panel's data source: `cum` accumulates the `total` of all requests, `round` tracks the current turn, and `live` is the estimate while streaming. `setConfirmFn` replaces the tool layer's default "always refuse" with the TUI's `[y/N]` — how the confirmation line is drawn is taken over by `tui.confirm`, and the Day 3/4 tool code never notices.

Next, define what the panel looks like and expose the single refresh point `updatePanel`:

```ts
// day7/index.ts
/** Right-side panel: model, session, context usage, and per-turn / total tokens. */
function buildPanel(): string[] {
    const window = CONTEXT_WINDOW;
    const ctx = estimateTokens(JSON.stringify(chat.exportHistory()));
    return [
        `Model  ${config.model}`,
        `Session  ${sessions.currentId()}`,
        '──── Context ────',
        `${ctx} / ${window} tokens`,
        `${Math.ceil((ctx / window) * 100)}% used`,
        '──── This turn ────',
        `${usage.round + usage.live} tokens`,
        '──── Total ────',
        `${usage.cum} tokens`,
    ];
}

function updatePanel(): void {
    tui.setPanel(buildPanel());
}
```

The panel has five sections: model, session, context token count + percentage, this turn (`round + live`), and total. `ctx` is exactly the "numerator of context usage" mentioned earlier. The percentage is rounded up, so even a small amount of context shows `1% used`.

Streaming forwards into the main area: progress lines (`[tool call…]` / `[history compaction…]`) go yellow, reply body is stitched into paragraphs in green with `appendInline`, and `live` is estimated by characters while forwarding:

```ts
// day7/index.ts
async function reply(line: string): Promise<void> {
    usage.round = 0;
    try {
        tui.append('', 'sys'); // a blank line before the reply separates it from the previous exchange
        for await (const delta of chat.streamReply(line)) {
            // progress lines (tool calling / history compaction) use yellow; during streaming, estimate this turn's increment by characters
            if (delta.startsWith('\n[tool call') || delta.startsWith('\n[history compaction')) {
                usage.live = 0;
                tui.append(delta, 'tool');
            } else {
                tui.appendInline(delta, 'model');
                usage.live = estimateTokens(delta);
            }
            updatePanel();
        }
        usage.live = 0;
        tui.append('', 'sys');
    } catch (e) {
        tui.append(`request failed: ${(e as Error).message}`, 'sys');
    }
    updatePanel();
}
```

`onLine` carries Day 6's input loop into the new interface: `busy` stops the next turn from being submitted while the previous one is still running, and then it separates commands from ordinary conversation. `/exit`, Ctrl+C, and Ctrl+D all auto-save first, then leave the temporary full-screen interface, and finally print results back in the original terminal:

```ts
// day7/index.ts
async function onLine(line: string): Promise<void> {
    if (busy) return; // the TUI already blocks once; guard again here against re-entrancy
    busy = true;
    tui.setBusy(true);
    if (line.startsWith('/')) {
        await handleCommand(line);
    } else {
        await reply(line);
    }
    busy = false;
    tui.setBusy(false);
    tui.ready(); // back to the input state, read the next line
}

async function onExit(): Promise<void> {
    tui.stop(); // restore the original terminal content before printing with console
    try {
        const { count, file } = await saveAll();
        console.log(`(saved ${count} sessions to ${file} before exit)`);
    } catch (e) {
        console.error(`failed to save before exit: ${(e as Error).message}`);
    }
    console.log('bye');
    process.exit(0);
}
```

The `switch` for the session commands merely swaps the old `out('sys', …)` for `tui.append(…, 'sys')`; everything else is unchanged, so it is not repeated here. On startup, the interface takes over the terminal first, then two hint lines are added and the panel is refreshed once:

```ts
// day7/index.ts
tui.start();
updatePanel();
tui.append('GeekAgent Day 7 — lightweight TUI + usage display', 'sys');
tui.append('Type /help for commands; the right panel shows usage in real time.', 'sys');
```

## 4. Verification

```bash
npm run typecheck
```

```bash
npm run dev -- day7/index.ts
```

Walk through these one by one in a real terminal (at least 80 columns recommended):

1. Launching drops you straight into the two-column interface: two hint lines on the left, and the right panel showing the model and `Session default`, context `1% used`, per-turn / total 0.
2. Type `What time is it now?`: the main area prints a yellow `[tool call get_current_time → …]`, then a green answer; the panel's per-turn / total start ticking (estimated during streaming, governed by the API `usage` afterward), and the current time the tool obtains matches the panel numbers one-to-one.
3. Type `/help`, `/new work`, `/sessions`: the panel's `Session` row switches to `work`, and the list still lands in the main area as usual.
4. Have the model run a `run_shell`: the confirmation lands on the input row (`[y/N] ` replacing `You › `); type `n` and press Enter, the main area records a line "… → n", the command does not execute; the model reads back "cancelled" and handles it on its own.
5. Chat a few more rounds to lengthen history, then type `/compact`: the context token count and the `used` percentage fall back — you can see at a glance how much room compaction freed up on the panel.
6. Type `/exit` (or Ctrl+C / Ctrl+D): you see the exit notice and `bye`, then return to the main screen — the terminal content from before the takeover is still there, untouched.
7. Run `npm run dev -- day7/index.ts < /dev/null`, and confirm that a non-interactive environment reports a real terminal is required.

## 5. What We Didn't Do

- **Pipe / redirection fallback**: in both cases the program exits directly, with no fallback to Day 6's plain-text mode.
- **History browsing**: the input box cannot yet recall the previous entry with ↑, and the main area keeps only the most recent 1000 lines.
- **Markdown rendering**: model output still carries `**` / backticks verbatim; rendering is left for the polish stage.

## 6. Next Step

The interface can now show state continuously, but whether a tool may execute is still hard-coded, and file paths have no unified boundary. The next step separates these rules from the tool implementations and adds a way to recover from mistaken writes.
