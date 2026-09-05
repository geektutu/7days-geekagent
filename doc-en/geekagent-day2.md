---
lang: en
title: Build GeekAgent from Scratch — Day 2 Tool Calling Loop
description: >-
  A 7-day build-an-Agent-from-scratch tutorial: hand-write the simplest possible Agent/Harness in TypeScript. Day 2 builds the tool calling loop: the model can request get_current_time, the program executes it and hands the real time back to the model, laying the groundwork for the command and file tools to come.
date: '2026-08-21 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 2: The Model Acts for the First Time — The Tool Calling Loop

> Day 1 got multi-turn conversation working; today we add tool calling: the model requests `get_current_time`, the program executes it and returns the real time, and the model continues answering.

## 0. Where the Title Comes From: What Is the Tool Calling Loop

Two terms in the title need clearing up first, or nothing that follows will land.

**Tool calling (also called function calling)**: by itself the model can only generate text. The OpenAI-compatible API lets us attach a "tool list" to the request: each tool spells out its name, purpose, and parameter format. When a question like "look up the current time" comes along, the model doesn't have to answer directly; it can output the agreed JSON saying "call `get_current_time` with arguments `{}`". That is tool calling.

**The loop**: is the model done in one shot? No. It places an order; we actually have to execute it, bring the result back, and feed it to the model before it can compose the final answer. So the full chain is "request → the model calls a tool → we execute → the result goes back → the model continues"; if one round isn't enough, run another, until it produces a plain text answer with no tool call. Writing this chain as one `for` loop is all of Day 2's work.

In one sentence: **the tool calling loop = the model proposes a call → the program executes → the result goes back → the model continues**. Everything later — Shell, file read/write, search, web fetching — reuses this same loop.

## 1. Why Let the Model Act

Day 1's model could only chat. Ask it "what time is it" and it can only blind-guess from its training data — it simply has no ability to "look at a clock". However articulate a chat-only model is, it still isn't an Agent; it's a chatbot.

One important difference between an Agent and a chatbot is whether it can call on external capabilities to fetch new information or perform actions. Checking the time, running commands, reading files, calling APIs — the program has to actually do all of these. Day 2 uses the simplest possible time tool to get "the model proposes a call → the program executes → the result goes back" running end to end.

## 2. Goal: Get the Tool Calling Loop Working

Day 2 does exactly one thing: **the model returns a `tool_call` → we execute → the result goes back → the model continues**, until it gives its final answer. Two acceptance criteria:

1. When asked "what time is it now", the model returns a `tool_call` for `get_current_time`, the program executes the tool, and the real time is placed back into history under the same `tool_call_id`;
2. After reading the `tool` message, the model keeps going and finally answers using the tool result; if it requests a tool again, the loop continues until plain text comes back.

**Lines of code for the day**: 5 source files, 268 lines in total; about 56 new lines in `tools.ts` and about 30 lines refactored in `chat.ts`.

## 3. Design: Agree on Tools, Messages, and Results First

### 3.1 Three Conventions

1. **A tool = one object**. A name + a description + a JSON Schema for the parameters + one `run` function. The model only ever sees the tools declared in the list; `run` is the real world on our side.
2. **history is still that same array**. Tool calling is just a new kind of message role: the `tool_calls` initiated by the assistant, and the `tool` messages sent back.
3. **Results are strings only**. Whatever a tool's `run` returns is converted to a string and handed back to the model. The real world (time, command output, file contents) always ends up folded into one line of text; no structured protocol is needed at the model layer.

### 3.2 Why the Program Doesn't Match "Question → Tool"

One might wonder: why would the model call a tool of its own accord? Did we write keyword matching like "the question contains 'what time' → call `get_current_time`" in our code?

**No. Quite the opposite — there is not one line of "question keyword → tool" mapping in the entire chain**, and that is the essence of tool calling's design. Let's spell out why:

1. On every request, we hand each tool's "manual" to the model through the `tools` parameter (`toOpenAITools()`) — just a name + a one-line description + a parameter Schema; there is no branch logic anywhere in the code.
2. While generating, the model judges for itself: what it can answer from knowledge ("what is 1+1?") comes out as ordinary text; for real-time information it doesn't know ("what time is it now?"), it sees that the description of `get_current_time` matches the need, so it decides not to write an answer but to issue a tool call instead — the behavior it learned in training: answer from what it knows, reach for a tool for what it doesn't.
3. The call is not natural language but a fixed protocol: the model outputs JSON (`name` + `arguments`), and the OpenAI-compatible API puts it into the response's `tool_calls` field (fragmented `delta.tool_calls` when streaming). Our loop only claims, executes, and returns results; it understands no semantics at all.
4. So how well the `description` is written and how precisely the `parameters` Schema is defined directly determine how correctly the model calls — which is also why "description" is a required field in the `Tool` abstraction.

The only corresponding fork on the code side is in chat.ts: if, after this round's stream ends, there are **no** `tool_calls`, we take the "final answer" branch. The model is always free to ignore the tools and just speak.

If we insisted on writing keyword matching in our code, two fatal problems would follow: first, incomplete coverage (any different phrasing from the user misses the match); second, forcing the model down our rigid rules when it could judge perfectly well by itself. Handing "whether to call a tool" to the model is the right way to write less code and cover more.

| | App code matches keywords | Model function calling |
|---|---|---|
| Who picks the tool | We write `if/else` | The model chooses based on tool descriptions |
| Supporting new phrasings | Keep adding rules | The model understands natural language |
| Argument generation | The app parses them itself | The model generates per the JSON Schema |
| The program's job | Understand the question and execute tools | Declare tools, execute, return results |

function calling here is only a **calling protocol**: the model never actually executes a function; it returns a tool name and arguments. What really touches time, files, or the network is still our program — which is exactly why the tool calling loop can't be skipped.

## 4. Implementation: The Effect First, Then the Code

Running it shows the following in the terminal (colors reproduced with HTML):

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › What time is it now</span>
<span style="color:#00cd00">Hang on, let me check...</span>
<span style="color:#cdcd00">[Calling tool get_current_time → 2026/8/26 20:42:11]</span>
<span style="color:#00cd00">It's 8:42 PM now.</span>
<span style="color:#00cdcd">You › </span>
</pre>

### 4.1 tools.ts — The Tool's "Smallest Common Denominator"

Day 2 adds `tools.ts`; full contents:

```ts
// day2/tools.ts
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

/**
 * The minimal abstraction of a tool: a name + a description + a JSON Schema for the parameters + one run function.
 * Day 2 has exactly one member, the time tool; later days just append to the TOOLS array (Day 4 folds it into a registry).
 */
export interface Tool {
    name: string;
    description: string;
    /** The parameters layer of the OpenAI function (e.g. { type: 'object', properties, additionalProperties }) */
    parameters: Record<string, unknown>;
    run(args: Record<string, unknown>): Promise<string> | string;
}

/** Every integrated tool. The model only ever receives the functions declared in this list. */
export const TOOLS: Tool[] = [
    {
        name: 'get_current_time',
        description: 'Get the current local time (Asia/Shanghai).',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    },
];

/** Convert the internal Tool into the OpenAI Chat Completions tools parameter format. */
export function toOpenAITools(): ChatCompletionTool[] {
    return TOOLS.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}

/**
 * Execute a tool by name. The arguments are a JSON string generated by the model.
 * Any error is returned to the model as "result text" — let the model read the error itself (failure self-checking will be implemented later; this plants the seed for it).
 */
export async function execTool(name: string, argsJson: string): Promise<string> {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return `Unknown tool: ${name}`;

    let args: Record<string, unknown> = {};
    try {
        args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
        return `Arguments are not valid JSON: ${argsJson}`;
    }

    try {
        return await tool.run(args);
    } catch (err) {
        return `Tool execution failed: ${(err as Error).message}`;
    }
}
```

Adding a new tool just means registering one object into the `TOOLS` array; the calling loop keeps executing through the unified interface. Two companion functions handle format conversion and lookup/execution:

- `toOpenAITools()`: converts the internal `Tool` into OpenAI's `tools` parameter format (a wrapper with `type: 'function'`); what we hand the model is the "manual", not `run`.

### 4.2 chat.ts — The Tool Calling Loop

Day 1's `streamReply` was "request once → stream the output → done". Day 2 wraps it in a loop that spins at most 5 turns (`MAX_TOOL_TURNS`). The full method:

```ts
// day2/chat.ts
async *streamReply(userInput: string): AsyncGenerator<string> {
  this.history.push({ role: 'user', content: userInput });
  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: this.history,
        tools: toOpenAITools(),
        stream: true,
      });

      // Stream: accumulate content while reassembling tool calls (deltas arrive as index-keyed fragments)
      let answer = '';
      const calls = new Map<number, { id: string; name: string; args: string }>();
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          answer += delta.content;
          yield delta.content;
        }
        for (const tc of delta?.tool_calls ?? []) {
          let call = calls.get(tc.index);
          if (!call) {
            call = { id: '', name: '', args: '' };
            calls.set(tc.index, call);
          }
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name += tc.function.name;
          if (tc.function?.arguments) call.args += tc.function.arguments;
        }
      }

      const toolCalls = [...calls.values()];
      if (toolCalls.length > 0 && toolCalls.every((c) => c.name)) {
        // The model wants to act: first record this assistant message (with tool_calls) into history
        toolCalls.forEach((c, i) => {
          if (!c.id) c.id = `call_${i}`; // some models omit the id; fill in a stable value
        });
        this.history.push({
          role: 'assistant',
          content: answer || null,
          tool_calls: toolCalls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: c.args },
          })),
        });
        // Execute one by one and return each result as a role=tool message, then enter the next turn
        for (const c of toolCalls) {
          const result = await execTool(c.name, c.args);
          yield `\n[Calling tool ${c.name} → ${result}]\n`;
          this.history.push({ role: 'tool', tool_call_id: c.id, content: result });
        }
        continue;
      }

      // No tool calls: this is the final answer
      this.history.push({ role: 'assistant', content: answer });
      return;
    }
    // Turns exhausted without settling: wrap up as a fallback so history stays ask-and-answer balanced
    yield '\n[Too many tool calling turns, stopped]';
    this.history.push({ role: 'assistant', content: '[Too many tool calling turns, stopped]' });
  } catch (err) {
    // On error, roll back the user message just enqueued, so history only ever holds paired exchanges.
    this.history.pop();
    throw err;
  }
}
```

The skeleton is a single `for` loop: each turn sends a request (carrying `history` + `tools`) → receives the stream → if complete `tool_calls` came back, execute them and `continue` into the next turn; otherwise treat it as the final answer and `return`.

Two implementation details worth attention, both covered in the code:

**Detail one: when streaming, `tool_calls` arrive as fragments (normal streaming handling).** The same call's `id`, `function.name`, and `function.arguments` are split across multiple chunks and reassembled by `index`; `name`/`arguments` are built by **string concatenation** (see the block that gathers `calls` in the loop above).

**Detail two: some models don't return a `tool_call_id`.** When replaying history, a `tool` message must match the assistant's `tool_call_id`, and a missing one makes the request fail with 400. So we fill it in before pushing to history: `if (!c.id) c.id = \`call_${i}\`;` (see the `toolCalls.forEach` block above).

### 4.3 What history Looks Like After One Tool Call

Ask "what time is it now"; once the whole loop finishes, these 4 entries were appended to the tail of history (who wrote each one is crystal clear):

```ts
// day2/chat.ts (history fragment example)
// (1) Our input: the user's words verbatim (pushed when Chat receives input)
{ role: 'user', content: 'What time is it now?' },

// (2) Model returns: decides not to answer directly and calls a tool instead (note content is null)
{ role: 'assistant', content: null,
  tool_calls: [{ id: 'call_0', type: 'function',
                 function: { name: 'get_current_time', arguments: '{}' } }] },

// (3) We send back: the tool's real output (the result of execTool, not model-generated)
{ role: 'tool', tool_call_id: 'call_0', content: '2026/8/26 15:42:11' },

// (4) Model returns: the final answer composed from the tool result
{ role: 'assistant', content: 'It is 3:42 PM on August 26, 2026.' },
```

### 4.4 role: The Identity of Every Entry in history

Every message in `messages` carries a `role` field. OpenAI Chat Completions defines four in all, and Day 2 already uses three:

| role | Who writes it | Meaning | When it appears in this project |
|---|---|---|---|
| `system` | Us | Instructions that set the model's behavior and rules; highest priority | Not used yet; will be used when project instructions are injected |
| `user` | Us | The caller's input verbatim | Enqueued on every user question (that's (1) above) |
| `assistant` | The model | The model's output: plain text, or an "I want to use a tool" declaration carrying `tool_calls` | (2) (with tool calls), (4) (the final answer) |
| `tool` | The tool (relayed by us) | The execution result of a tool call; must match the assistant-initiated call via `tool_call_id` | (3) (the tool's real output) |

Two roles are easy to confuse:

- `system` provides high-priority instructions; it hasn't been used on this day.
- `tool` messages aren't shown to the user; they are the "question and answer" between the model and a tool: the assistant initiates (with an `id`), and the `tool` message answers (bringing back the same `tool_call_id`). If the ids don't line up, the API returns 400 outright — which is why detail two fills in the id.

### 4.5 color.ts — Reusing Day 1's Terminal Coloring

Day 2 reuses Day 1's `color.ts` (`paint` / `out` / `err` + the color table `C`) directly, without writing a second copy. The only new coloring need is that **tool calling progress lines must stand out**: when the model calls a tool, chat.ts yields a `[Calling tool ...]` segment, and that line is colored yellow (`tool`) rather than the green (`model`) used for the model's text.

In index.ts, judging by the start of each line is enough — still the same `out`:

```ts
// day2/index.ts
for await (const delta of chat.streamReply(line)) {
    out(delta.startsWith('\n[Calling tool') ? 'tool' : 'model', delta);
}
```

The effect is the snippet shown at the start of this section: tool calling progress lines in yellow, the model's text in green.

## 5. Verification

- `npm run typecheck`: confirms the type check passes.
- `npm run dev -- day2/index.ts`: start it and ask "what time is it now".
- Confirm the terminal first shows the real result of `get_current_time`, and then the model's answer based on that result.

## 6. What We Didn't Do

`get_current_time` never touches local data, so this day doesn't handle execution permissions yet. It only validates the tool calling loop; for now the model can't operate the local machine.

## 7. What's Next

The tool loop already connects the model with external functions. Next, we plug in tools that can operate the local environment, and start thinking about confirmation before execution and resource limits.
