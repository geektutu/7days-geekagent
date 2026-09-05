---
lang: en
title: Build GeekAgent from Scratch — Day 5 History Compaction
description: >-
  A 7-day tutorial on building an Agent from scratch, writing the simplest possible Agent/Harness in TypeScript. Day 5 tackles "chat long without forgetting": when the history array only grows and the conversation keeps getting longer, history compaction keeps the context size under control, so long conversations stay within the model's context window.
date: '2026-08-24 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 5: Chat Longer, Forget Nothing — History Compaction

## 0. Why Compact history

The first four days wired up conversation, tools, and file operations, but all of them depend on the `history` inside `Chat`. This array keeps growing with every user message, model reply, and tool result:

```ts
// day4/chat.ts (other details omitted)
this.history.push({ role: 'user', content: userInput });        // the user message goes in first each turn
this.history.push({ role: 'assistant', content: answer });      // then the reply goes back in
this.history.push({ role: 'tool', tool_call_id: c.id, content: result }); // tool results go back in too
```

Every request ships the entire `history` to the model (that `messages: this.history` line in `chat.ts`). Five exchanges are no problem — but what about fifty? Five files read in, each tool result three thousand characters?

There are three common ways to handle it:

| Approach | Upside | Cost |
|---|---|---|
| Keep everything | The most complete information | Eventually exceeds the context window; cost and latency keep climbing |
| Keep only the last N messages | Simple to build, stable length | Old decisions and key clues are lost outright |
| Summarize old messages | Keeps the essentials in fewer words | The summary itself loses detail, and it costs one extra model call |

Day 5 picks the third option: reuse the existing model to write the summary, adding no new dependency or call path. All that remains is to answer three questions: when to compact, which messages to compact, and how the summary goes back into `history`.

Mature systems also combine sliding windows, summarization, keeping important messages, and external memory retrieval. This demo only does rolling summarization, so that we can first watch the core process clearly: "old messages become one summary, and the summary goes back into the context".

## 1. Goals: Automatic Compaction + a Manual Entry Point

Acceptance criteria:

1. Once the character count of `history` exceeds the threshold, before producing the next real answer the model is called first, replacing the earlier messages with a single "summary of previous conversation";
2. The most recent 6 messages keep their original text; after compaction, keep asking about earlier facts and the model can still recover the key content from the summary;
3. `/compact` runs the same logic manually without waiting for the threshold, and shows how many old messages were merged this time.

**Lines of code for the day**: 646 lines across 5 source files (Day 4 was 570, a **net gain of 76 lines**). The changes live in `day5/chat.ts` (98 → 166) and `day5/index.ts` (74 → 82).

## 2. Design: When to Compact, What to Compact, and How

### 2.1 When: character count over a threshold

Compaction needs a trigger, which means first defining a yardstick for "how long is the history". The most direct one is of course the token — model APIs bill by token and window by token — but **counting tokens precisely requires a tokenizer**, a dictionary that has to be maintained per model. Use one, and you start worrying about "which tokenizer to switch to when the model changes" — not a burden this day should carry.

Step back: `history` is a pile of objects in memory. `JSON.stringify` them, count the characters, and you have a rough measure of context size. Day 5 uses 4000 characters as the default threshold and leaves exact token counting to a later day.

So you don't have to chat for a long time before seeing the effect, the threshold can also be lowered temporarily through `GEEKAGENT_MAX_HISTORY`. The demo in section 3 uses 600.

### 2.2 What: summarize old messages, keep the most recent 6

The last few turns of conversation directly shape the current answer, so they cannot be compacted along with the rest. We therefore treat the messages **outside the most recent `KEEP_RECENT` (set to 6)** as old messages and hand them to the model for one summary; the last 6 keep their original text and, together with the summary, form the new `history`. Six messages roughly cover the last two or three rounds of Q&A and their tool results.

There is a detail worth watching in where the cut falls: the cut point is `split = history.length - KEEP_RECENT`, counted from the front of the array — messages are ordered by time, so the old ones are always at the front. When the cut point is so small there is nothing "older" to compact (fewer than 6 messages so far), it simply returns 0 and does nothing.

### 2.3 How: one summary request, two entry points

Which path should the summary take? Two options:

- **Streaming**: emitted piece by piece like a chat reply, for the user to watch. But a summary is merely an intermediate step — progress is all the user needs to see, not a word-by-word performance.
- **Non-streaming**: one ordinary request, wait for the return, and splice in the complete summary text. Less code, plainer behavior.

We go non-streaming: a single `/chat/completions` request carrying two prompt pieces — a system instruction (`COMPRESS_SYSTEM`: compress the conversation into bullet points, keeping goals, decisions, file paths, and unfinished items) and a user message (the old messages to compact, pasted in as `JSON.stringify` text). The model reads them over and returns a set of bullet points; we wrap the points into a system message and attach it back to `history`.

The summary uses the same model and the same configuration — no new call path required. Once generated, a single system message replaces the old messages and is spliced back in front of the untouched last 6.

All of this logic lives in `compactOldMessages()`, with two entry points around it: before each turn starts, the threshold is checked and compaction fires automatically if exceeded; when the user types `/compact`, it is invoked manually. Both paths share the same splitting and summarization logic.

## 3. Implementation: Effect First, Then Code

Below is a real replay run with `GEEKAGENT_MAX_HISTORY=600`: I have the model "memorize" five facts (each reply is restricted to two characters, so every response stays short and history grows at an even pace). By the sixth question, `history` has grown past 600 characters and compaction triggers automatically:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 5 — history compaction (model: deepseek-v4-flash, type /help for commands)</span>
<span style="color:#00cdcd">You › Remember: the project name is GeekAgent, the language is TypeScript. Please reply with only "OK" and nothing else.</span>
<span style="color:#00cd00">OK</span>
<span style="color:#00cdcd">You › Remember: the author is geektutu. Please reply with only "OK" and nothing else.</span>
<span style="color:#00cd00">OK</span>
<span style="color:#00cdcd">You › Remember: the start command is npm run dev. Please reply with only "OK" and nothing else.</span>
<span style="color:#00cd00">OK</span>
<span style="color:#00cdcd">You › Remember: the goal is to build a minimal, runnable Agent. Please reply with only "OK" and nothing else.</span>
<span style="color:#00cd00">OK</span>
<span style="color:#00cdcd">You › Remember: the code directory is /home/daijie/git/geekagent. Please reply with only "OK" and nothing else.</span>
<span style="color:#00cd00">OK</span>
<span style="color:#00cdcd">You › We just memorized a list of facts one by one. List everything you remember, including the project name, language, author, start command, goal, and code directory. Facts only, separated by semicolons, in one sentence.</span>
<span style="color:#cdcd00">[history compaction: 5 old messages merged into 1 summary]</span>
<span style="color:#00cd00">Project name GeekAgent; language TypeScript; author geektutu; start command npm run dev; goal: build a minimal, runnable Agent; code directory /home/daijie/git/geekagent.</span>
</pre>

This replay verifies two things:

- **Automatic compaction fired**: after the sixth question entered the queue, `history` passed 600 characters, 5 old messages were merged into 1 system summary, and the terminal showed a yellow progress line.
- **Old facts remained retrievable**: the project name, language, author, and start command come from compacted old messages, while the goal and code directory come from the kept recent messages. The model answers both, which shows the summary preserved the key information from the first half.

Two files changed: `day5/chat.ts` gains the compaction logic, and `day5/index.ts` gains the command, hint text, and progress coloring.

### 3.1 Three constants: threshold, keep count, compaction instruction

Three new constants at the top of `day5/chat.ts`:

```ts
// day5/chat.ts
/** Character threshold that triggers history compaction: once the serialized total length of history exceeds it, old messages are compressed into a summary. Lower it with an environment variable to watch the trigger in action. */
const MAX_HISTORY_CHARS = Number(process.env.GEEKAGENT_MAX_HISTORY) || 4000;
/** How many recent messages compaction keeps intact — only earlier ones get summarized; conversation that just happened needs verbatim detail, only the distant past is worth thinning. */
const KEEP_RECENT = 6;

/** The compaction instruction: compress the old conversation into bullet points, distilling key facts, decisions, and unfinished items. */
const COMPRESS_SYSTEM = `You are a conversation compactor. Compress the conversation history the user pastes into concise bullet points, preserving as much as possible of the following:
- The user's goals, requirements, decisions made, and preferences;
- File paths, shell commands, tool calls, and key conclusions that appeared;
- Items that are unfinished or still in progress.
Output only the compressed bullet points — no explanations, no pleasantries, no verbatim dialogue.`;
```

Notes:

- `MAX_HISTORY_CHARS` is the yardstick from section 2.1 — 4000 by default, and it can be lowered temporarily to watch the trigger.
- `COMPRESS_SYSTEM` is the instruction sheet telling the model "how to compact". The three ordered instructions (facts / paths and commands / unfinished items) are written out in full, because what the summary drops and what it keeps depends entirely on these few lines pinning down the direction. It is attached to the compaction request in the system role.

### 3.2 Shared core: measure history, then compact the old messages

The two new methods right after:

```ts
// day5/chat.ts
  /** Rough size of history: estimated by the character count of each serialized message; compaction is needed once it exceeds MAX_HISTORY_CHARS. */
  private historySize(): number {
    return this.history.reduce((n, m) => n + JSON.stringify(m).length, 0);
  }

  /**
   * History compaction: hand every old message except the most recent KEEP_RECENT to the model for summarization,
   * replace them with a single system summary message, and let the context thin out.
   * Returns the number of old messages merged away; returns 0 when the model produces no summary, in which case nothing is replaced.
   */
  private async compactOldMessages(): Promise<number> {
    const split = this.history.length - KEEP_RECENT;
    if (split <= 0) return 0; // history is still short, no old messages to compact
    const old = this.history.slice(0, split);
    const recent = this.history.slice(split);
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: COMPRESS_SYSTEM },
        { role: 'user', content: JSON.stringify(old, null, 2) },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim();
    if (!text) return 0;
    this.history = [{ role: 'system', content: `[Summary of previous conversation]\n${text}` }, ...recent];
    return old.length;
  }
```

The two methods split the work into measuring and compacting:

- **`historySize`**: `JSON.stringify(m).length` serializes each message, counts its characters, and sums them up. Character count approximates the cost, consistent with the reasoning in section 2.1.
- **`compactOldMessages` runs three steps**: make the cut (`split`) that divides the array into `old` and `recent` → make one non-streaming request for the model to read `old` and produce a summary → rebuild `history` from the summary message and the new list. The returned `old.length` is "how many messages were merged away", which the outer progress line reports.

### 3.3 Automatic entry point: check before each turn's request

Automatic compaction hangs off the `streamReply` entry: after the user message enters `history`, measure the latest size first; if it exceeds the threshold, call `compactOldMessages()`, then continue with the existing tool-calling loop.

```ts
// day5/chat.ts
  async *streamReply(userInput: string): AsyncGenerator<string> {
    this.history.push({ role: 'user', content: userInput });
    try {
      // Day 5: when history grows too long, compact the old messages into a summary first to free context for this turn; a failed compaction never interrupts the conversation.
      if (this.historySize() > MAX_HISTORY_CHARS) {
        try {
          const dropped = await this.compactOldMessages();
          yield dropped > 0
              ? `\n[history compaction: ${dropped} old messages merged into 1 summary]\n`
              : '\n[history compaction: the model produced no summary, keeping the original history]\n';
        } catch {
          yield '\n[history compaction failed: keeping the original history]\n';
        }
      }
```

Two orderings here cannot be swapped: the user message is enqueued first, so the threshold includes the latest input; compaction happens before the real request, so the model receives the thinned `history`. The yellow progress line is shown only through `yield` and never written into the conversation history.

### 3.4 Manual entry point: compact()

`compact()` reuses `compactOldMessages()` directly, turning the compaction result into the message the `/compact` command needs:

```ts
// day5/chat.ts
  /**
   * On-demand compaction: summarize the old messages into one summary at any time, without waiting for history to exceed the threshold (invoked by the /compact command).
   * Returns the message shown to the user, without square brackets; a failed compaction does not throw — it returns a failure note instead.
   */
  async compact(): Promise<string> {
    if (this.history.length <= KEEP_RECENT) return 'history compaction: no old messages to compact';
    try {
      const dropped = await this.compactOldMessages();
      return dropped > 0
          ? `history compaction: ${dropped} old messages merged into 1 summary`
          : 'history compaction: the model produced no summary, keeping the original history';
    } catch {
      return 'history compaction failed: keeping the original history';
    }
  }
```

The difference between the automatic and manual entry points is only when they trigger: the former is triggered by the character threshold, the latter by a user command.

### 3.5 CLI wiring: command, hints, and coloring

The `/compact` command is added after `/reset`, calling `chat.compact()` and printing the result directly:

```ts
// day5/index.ts
                case '/compact':
                    out('sys', '\n'); // compaction progress starts on its own line
                    out('tool', `[${await chat.compact()}]`, true);
                    break;
```

It is registered in `/help` too:

```
  /compact compact old messages into a summary right away (don't wait for the automatic trigger)
```

The other three pieces of text and coloring work the same way as before:

```ts
// day5/index.ts
// one line added to /help (progress hint):
 History guard: when history accumulates for too long, it is compacted automatically — the model summarizes the old conversation into a single "summary of previous conversation", keeps the most recent messages verbatim, and frees up context (compaction progress is shown as a yellow line).

// two lines in the render loop (recognize the compaction progress line as "progress" so it doesn't get painted reply-green):
                    // progress lines (tool calling / history compaction) are yellow; real replies are green
                    const isProgress = delta.startsWith('\n[tool call') || delta.startsWith('\n[history compaction');
                    out(isProgress ? 'tool' : 'model', delta);

// banner text:
out('sys', `GeekAgent Day 5 — history compaction (model: ${config.model}, type /help for commands)`, true);
```

- Those two coloring lines extend from "only recognizing `\n[tool call`" to "also recognizing `\n[history compaction`" — both progress lines share the yellow `tool` color while body text keeps the green `model`. Set them against the yellow line in the terminal above, and the colors line up with the source.

The threshold is not written into `.env` — it is a temporary knob for debugging and demos, and carrying it in the command prefix is the least fuss, without polluting the config file. To watch compaction trigger, just lower it for one launch:

```bash
GEEKAGENT_MAX_HISTORY=600 npm run dev -- day5/index.ts
```

## 4. Verification

- `npm run typecheck`: confirm the type check passes.
- **Flood it with chat** (needs an API key, actually runs compaction):

```bash
GEEKAGENT_MAX_HISTORY=600 npm run dev -- day5/index.ts
```

Feed it a few short facts one by one (have it reply with two characters each turn), then ask "what did you just memorize". In the turn where `history` passes 600 characters, you will first see the yellow `[history compaction: N old messages merged into 1 summary]`, followed by an answer that is still complete — compaction firing and memory surviving, both behaviors in one sitting. The default threshold of 4000 works the same way; it just takes considerably more chatting.

- **Manual compaction** (needs an API key): start `day5/index.ts` as usual, chat a few rounds, then type `/compact`. With more than 6 messages in history you will see `[history compaction: N old messages merged into 1 summary]`; with history too short (≤ 6 messages), it shows `[history compaction: no old messages to compact]`.

## 5. What We Didn't Do

- **Summaries can be summarized again**: an old summary is just an ordinary message, so the next compaction may treat it as an old message and compress it a second time, wearing the information down layer by layer — there is no "a summary may only be compacted once" guard.
- **Mid-turn compaction**: the check runs only once before each turn; a long chain of tool calls waits for the next user input before compaction can trigger.
- **Session management**: still a single in-memory session; history is lost on exit.

## 6. Next Step

Even after compaction, history still lives only inside the current process, and different topics still share one array. The next step is to let conversations come apart from each other and keep them alive after the program exits.
