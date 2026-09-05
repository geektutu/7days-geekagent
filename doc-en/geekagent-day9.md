---
title: Build GeekAgent from Scratch — Day 9 Task Planning and Subagents
description: >-
  A 7-day tutorial on building an Agent from scratch, writing the simplest possible Agent/Harness in TypeScript. Day 9 makes the Agent list a plan before acting: add a TODO table maintained by the model, plus a subagent that isolates context. The main Agent arranges the order, the subagent handles small tasks with clear boundaries, and current progress always shows in the right-hand panel.
date: '2026-08-28 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 9: Making the Agent List a Plan Before Acting — Task Planning and Subagents

> The GeekAgent of the past eight days can read and write files, run commands, and respects permission boundaries. But faced with a multi-step task, it still focuses only on the next tool call: where it is and what comes next are all buried in the model's context. Today we add a TODO table maintained by the model, plus a subagent with isolated context. The main Agent arranges the order, the subagent handles small tasks with clear boundaries, and current progress always shows in the right-hand panel.

## 0. Why an Agent Needs a Visible Checklist

"Help me check the project and fix the type errors" involves at least five steps: read the config, run the check, locate the causes, modify the code, verify again. The model can write its plan as a paragraph of prose, but plain text doesn't help: the program doesn't know which item is done, and subsequent tool calls have no reliable way to update it; all we can do is watch messages scroll by and guess at progress.

There's a second annoyance: tasks often come with "think about this while you're at it" side questions, like comparing two approaches first. Once that analysis unfolds in the main conversation, large blocks of text crowd out the context that real work needs.

The solution is two new tools: `todo_write` tackles the first problem—letting the model write its plan as a checklist it can tick off, rewriting the whole table with every step, with progress always shown in the right panel; `delegate_task` tackles the second—handing an independent side question to a separate request to think through, bringing back only the conclusion so the process doesn't take up space in the main conversation.

| | Plain-text plan | `todo_write` structured checklist |
|---|---|---|
| Can the program read it | Only displayable as text | Reads each item's content and status |
| How it updates | Model narrates a new plan | Rewrites a single TODO array |
| Where it shows | Mixed into the message stream | Fixed in the right panel |
| Constraints | Format varies with the model | Fixed status values and in-progress count |

Mainstream Agents' planners may maintain dependency graphs, execution DAGs, or dynamic replanning. Here we first use a linear TODO list to express order and status, then use a tool-less subagent to isolate independent analysis tasks.

Let's use one diagram to tell the whole life of the TODO table—how it appears, how it updates, how it wraps up. Today's design and implementation both expand this diagram:

```text
user enters a multi-step task
     │
     ▼
① plan    model calls todo_write, handing over the whole table
     │     todos.ts validates it, stores it in memory, notifies the TUI
     │     the right panel immediately shows:
     │       [ ] read tsconfig
     │       [ ] run type check
     │       [ ] fix each issue and verify
     ▼
② work    for every step the model completes, it rewrites the whole table
     │     ordinary work is done by read / run_shell;
     │     independent analysis work goes to delegate_task,
     │     the subagent runs one request in a clean context and returns only the conclusion
     │     the right panel flips along:
     │       [x] read tsconfig
     │       [>] run type check
     │       [ ] fix each issue and verify
     ▼
③ wrap up the last item is marked completed, the model gives its final answer
            [x] read tsconfig
            [x] run type check
            [x] fix each issue and verify
```

The diagram really only has three roles: **the model decides**—what goes on the checklist and each item's status are handed over live every time it calls `todo_write`; **todos.ts keeps the books**—it checks the submitted table and overwrites what's in memory; **the TUI displays**—the moment memory changes, the right panel refreshes. The checklist itself is not held by the model, which is why it must rewrite the whole thing each time.

So if the model doesn't keep the checklist itself, how does it know what's currently on the table when updating status? The answer is the conversation history:

- **Where's the previous table**: every time the model calls `todo_write`, that call is recorded in the history along with its arguments—so the previous table and each item's status are all in there. The tool's receipt is just a single line "updated 2 TODOs", with no details.
- **How is progress computed**: the history also holds every tool call and result since then; the model reads through it, figures out which work is done, and resubmits the whole updated table.

In other words, `todos.ts` faithfully stores whatever table the model submits and knows nothing about progress; whether the table is right depends entirely on the model's ability to reconstruct its own progress from the history.

## 1. Goals

Today's acceptance criteria:

1. After receiving a multi-step task, the model writes the whole plan with `todo_write`; each item has only three statuses—`pending`, `in_progress`, `completed`—and at most one item may be in progress at a time;
2. The model updates the checklist after every completed step; the right panel and `/todos` read the same state, so current progress stays visible throughout;
3. `delegate_task` handles the subtask with an independent request that carries none of the main history, returning only the conclusion to the main Agent as a tool result, after which the main Agent continues execution.

**Lines of code today**: relative to Day 8, Day 9 adds 123 lines and removes 10, for a net increase of 113 lines, staying under 500.

## 2. Design

### 2.1 A TODO Is an Ordinary function tool, Plus a Refresh Chain

The model has no built-in TODO ability, and neither does the OpenAI SDK provide `todo_write`. Like the time tool from Day 2, it's a function tool we define ourselves: `todos.ts` writes the tool name, usage description, and parameter format, and Day 4's `toOpenAITools()` puts them into the request; the model sees the description and knows how to call it (full definition in 3.1). Two trade-offs in the implementation:

- **Write the whole table, no add/update/delete operations.** Why not split it into "add an item", "change an item's status", "delete an item"? Then the model would have to number each item and remember how the numbering shifts. A checklist is usually just a few lines, so rewriting the whole thing each time costs a few tokens but saves an entire numbering protocol. The gatekeeping sits at the entry: content can't be empty, status must be valid, at most one in-progress task; anything invalid and the whole table is rejected, with the old table left intact—half a plan never reaches the screen.
- **Save means render.** The moment `todos.ts` stores the new table in memory, it calls `onChange`, which the entry point wires to the TUI's `updatePanel()`, and the right panel refreshes instantly. The right panel and `/todos` both read the same `formatTodos()`, so the two can never disagree.

### 2.2 A Subagent Is One History-less Request, Plus One Forced Write-back

`delegate_task` is today's simplest tool: it receives a task description, opens a fresh model request whose `messages` contain exactly two entries—"system + task description"—carrying none of the main Agent's history; when the conclusion comes back, the tool loop wraps it into a tool result message and hands it to the main Agent. It reuses the same model client, so API config and usage tracking work as usual.

The boundary is deliberately narrow: the subagent has no tools and cannot delegate further, nor does it touch the TODO directly—its only job is to think; the hands-on work is still done by the main Agent. Multiple delegations queue up and run one by one, naturally serial.

The "subagent" here is not another long-lived process, nor a multi-agent orchestration framework. It's just one model request with its own messages: use a fresh context to work on a well-bounded question, then hand the conclusion back to the main Agent as a tool result.

One more pitfall: during a delegation the main Agent's checklist sits in its old state, and one lapse from the model means forgetting to update it. So in the turn after a delegation returns, we pin the request to `todo_write` with `tool_choice`, forcing the main Agent to mark the just-finished item `completed` (or adjust the plan if it failed) before moving on. This write-back doesn't rely on the model's own initiative.

### 2.3 When to Write a Checklist Is Decided by the system Instruction

Not every message deserves a checklist—asking "what time is it" and then planning three steps is a wasted call. Day 9 adds a system instruction to the main request for the first time, with just one rule: multi-step tasks plan first, then execute; simple tasks answer directly. This instruction is assembled in front of the history at request time each round; it isn't written into the session history, so saving a session never stores the same paragraph over and over.

An instruction alone isn't bulletproof, so we set two forced points: when the user's words call it out explicitly (the words `todo`, a task list, or step words like "then", "finally", "and summarize"), the first round is pinned to `todo_write`; plus the post-delegation round described in 2.2. The other rounds are left to the model.

## 3. Implementation: The Result First

After starting Day 9, give it a two-step mini task; the main area shows tool progress while the TODO appears on the right at the same time:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › have the subagent compare interface vs type in TypeScript and give a recommendation</span>
<span style="color:#cdcd00">[tool call todo_write → updated 2 TODOs]</span>
<span style="color:#cdcd00">[tool call delegate_task → interface suits extensible object shapes; type is better for union types and type composition.]</span>
<span style="color:#cdcd00">[tool call todo_write → updated 2 TODOs]</span>
<span style="color:#00cd00">Prefer interface for object shapes; use type when you need union types or complex composition.</span>
</pre>

The right-hand panel changes in step with execution:

```text
──── TODO ────
[x] compare interface vs type
[>] give a recommendation
```

First, recall Day 2's loop rhythm: each round sends the system instruction plus the full history to the model; the model either answers directly or names the tools it wants; we execute them, append the "model's calls" and the "tool results" as two messages to the history, then start the next round. `todo_write` gets no special treatment in this loop—it's just one of the ordinary tools.

With that rhythm in mind, spread the run we just watched onto a timeline: the main line is the main Agent's append-only history, and every round's request equals the system instruction + the whole history; the subagent's request happens the moment `delegate_task` executes—two messages, discarded after use:

```json
① user input
   { "role": "user", "content": "have the subagent compare TypeScript's interface vs type and give a recommendation" }

② round 1 returns: plan first. history appends two messages
   { "role": "assistant", "content": null,
     "tool_calls": [{ "id": "call_1", "function": { "name": "todo_write",
       "arguments": { "todos": [
         { "content": "compare interface vs type", "status": "in_progress" },
         { "content": "give a recommendation", "status": "pending" } ] } } }] }
   { "role": "tool", "tool_call_id": "call_1", "content": "updated 2 TODOs" }

③ round 2 returns: delegate the analysis
   { "role": "assistant", "content": null,
     "tool_calls": [{ "id": "call_2", "function": { "name": "delegate_task",
       "arguments": { "task": "compare TypeScript's interface vs type and give a recommendation" } } }] }
   ⤷ execTool runs delegate_task; right now the subagent fires an independent request (not in the main history):
       { "role": "system", "content": "You are a subagent. Complete only the given subtask and return a concise…result; no chit-chat." }
       { "role": "user", "content": "compare TypeScript's interface vs type and give a recommendation" }
     once the conclusion arrives, this request is discarded, and the conclusion returns to the main history as a tool result:
   { "role": "tool", "tool_call_id": "call_2", "content": "interface suits extensible object shapes, type is better for union types…composition." }

④ round 3 (tool_choice pinned to todo_write) returns: write back progress. history appends two more messages
   { "role": "assistant", "content": null,
     "tool_calls": [{ "id": "call_3", "function": { "name": "todo_write",
       "arguments": { "todos": [
         { "content": "compare interface vs type", "status": "completed" },
         { "content": "give a recommendation", "status": "in_progress" } ] } } }] }
   { "role": "tool", "tool_call_id": "call_3", "content": "updated 2 TODOs" }

⑤ round 4 returns: no tool_calls means this is the final answer
   { "role": "assistant", "content": "Prefer interface for object shapes; use type when you need union types…composition." }
```

Two notes: in the protocol, `arguments` is actually a JSON string, expanded into an object above for readability; the `…` inside strings marks omitted middles. The `[x] compare / [>] recommendation` shown in the right panel right now is exactly the state written in ④.

Looking back at the two questions planted in §0, both now have answers:

- **Where's the previous table**: in the `tool_calls` arguments of ②'s assistant message, carried along verbatim by every round's request in ③④⑤
- **How is progress computed**: before ④, the history already holds all of ②③'s calls and the subagent's conclusion; from these the model flips the first item to `completed`

Finally, note that the subagent's conclusion enters the main history as a tool result, so the main Agent sees it; the subagent's own two messages never enter the main conversation and aren't re-sent in the next round's request.

### 3.1 todos.ts: Status, Validation, and Two Tools

Day 9's new `todos.ts` is 77 lines in total, containing the complete TODO state, the two tools, and the display format:

```ts
// day9/todos.ts
import { registerTool, type Tool } from './tools.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
    content: string;
    status: TodoStatus;
}

let items: TodoItem[] = [];
let onChange: () => void = () => {};

/** Registers the planning and delegation tools; status changes sync to the TUI immediately through a listener. */
export function setupPlanning(delegate: (task: string) => Promise<string>, changed: () => void): void {
    onChange = changed;
    const tools: Tool[] = [
        {
            name: 'todo_write',
            description: 'Write the complete TODO list, used for planning and updating task progress. Mark an item in_progress when starting it and completed when done; keep at most one in_progress at a time.',
            parameters: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                content: { type: 'string', description: 'short, actionable task description' },
                                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                            },
                            required: ['content', 'status'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['todos'],
                additionalProperties: false,
            },
            run: (args) => {
                const next = Array.isArray(args.todos) ? args.todos as TodoItem[] : [];
                if (next.some((todo) => !todo.content?.trim() || !['pending', 'in_progress', 'completed'].includes(todo.status))) {
                    return 'invalid TODO format';
                }
                if (next.filter((todo) => todo.status === 'in_progress').length > 1) {
                    return 'only one in-progress TODO allowed at a time';
                }
                items = next.map((todo) => ({ content: todo.content.trim(), status: todo.status }));
                onChange();
                return `updated ${items.length} TODOs`;
            },
        },
        {
            name: 'delegate_task',
            description: 'Hand a well-bounded subtask to a subagent with isolated context, wait for it to finish, and return the result. Suited to analysis, design, and review; multiple subtasks must be called one at a time.',
            parameters: {
                type: 'object',
                properties: { task: { type: 'string', description: 'complete, self-contained subtask description' } },
                required: ['task'],
                additionalProperties: false,
            },
            run: async (args) => {
                const task = String(args.task ?? '').trim();
                return task ? delegate(task) : 'missing argument task';
            },
        },
    ];
    tools.forEach(registerTool);
}

export function listTodos(): readonly TodoItem[] {
    return items;
}

export function formatTodos(): string[] {
    const mark = { pending: '[ ]', in_progress: '[>]', completed: '[x]' };
    return items.map((todo) => `${mark[todo.status]} ${todo.content}`);
}
```

Against the flow diagram from the start, a few key points:

- We reuse Day 4's `Tool` and registry; no new calling protocol was invented for planning
- `delegate_task` doesn't implement the subagent itself; it just calls the injected `delegate` function

### 3.2 chat.ts: The Subagent and Two Forced Write-backs

`Chat` gains one public method. It uses the same model client, so API config and usage tracking are reused directly:

```ts
// day9/chat.ts
  /** The subagent completes one focused task with an isolated context; the result returns to the main Agent before the pipeline continues. */
  async delegate(task: string): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: 'You are a subagent. Complete only the given subtask and return a concise result the main Agent can use directly; no chit-chat.' },
        { role: 'user', content: task },
      ],
    });
    this.reportUsage(res.usage);
    return res.choices[0]?.message?.content?.trim() || 'subagent returned no result';
  }
```

The `messages` array has just two entries—the main Agent's full history is never expanded here; `execTool` wraps the returned text into a `role=tool` message, and the main Agent decides its next step from that.

On the main request side, the system instruction states "when to plan":

```ts
// day9/chat.ts
const AGENT_SYSTEM = `You are a local coding Agent. When a task needs multiple steps, first call todo_write to draft a brief plan, then execute item by item and update statuses; when the user explicitly asks for a TODO or task list, you must call todo_write first. Complete simple tasks directly—don't create TODOs just for ceremony. You may hand well-bounded analysis, design, or review tasks to delegate_task; multiple subtasks must be delegated serially.`;
```

The forced logic in code is just a few lines. `wantsTodo` recognizes "the user called it by name", and `mustUpdateTodo` remembers "the last round delegated, so a write-back is due"; when either hits, this round's `tool_choice` is pinned to `todo_write`; otherwise the model decides freely:

```ts
// day9/chat.ts
    const wantsTodo = /todo|task list|then|finally|after.{0,12}(?:recommend|summarize|wrap up)|and (?:recommend|summarize|wrap up)/i.test(userInput);
    let mustUpdateTodo = false;

// ...

        const forceTodo = (turn === 0 && wantsTodo) || mustUpdateTodo;
        mustUpdateTodo = false;

// ...

          messages: [{ role: 'system', content: AGENT_SYSTEM }, ...this.history],
          tools: toOpenAITools(),
          tool_choice: forceTodo
              ? { type: 'function', function: { name: 'todo_write' } }
              : 'auto',

// after delegate_task finishes
          mustUpdateTodo = toolCalls.some((c) => c.name === 'delegate_task');
```

One small change along the way: the tool-loop cap `MAX_TOOL_TURNS` is raised from 5 to 30. Planning, delegation, and per-item write-backs all consume turns; 5 rounds can't fit a full flow.

### 3.3 Adding the New Tools to the Permission Table

Day 8 rejects any tool not registered in the permission table, so the two new tools must join the default config. They only touch memory or call the model—no files or shell—so they default to `allow`:

```ts
// day9/permissions.ts
const DEFAULT_TOOLS: Record<string, Policy> = {
    get_current_time: 'allow',
    run_shell: 'ask',
    ls: 'allow',
    read: 'allow',
    glob: 'allow',
    write: 'ask',
    patch: 'ask',
    todo_write: 'allow',
    delegate_task: 'allow',
};
```

`loadPermissions` overlays existing config onto this default table, so an old `.geekagent/GeekAgent.json` works directly after upgrading to Day 9 even without these two fields; when restrictions are needed, explicitly change them to `ask` or `deny`.

### 3.4 Wiring State Changes into the Right-hand Panel

The entry point registers the tools after the TUI is created. `delegate_task` gets `Chat.delegate`, and the TODO change callback gets the existing `updatePanel`:

```ts
// day9/index.ts
const tui = new TUI(onLine, onExit);
setupPlanning((task) => chat.delegate(task), updatePanel);
setupPermissions(permissions, (prompt) => tui.confirm(prompt));
```

The panel builder appends the TODOs after the existing usage info. Long text keeps being truncated to column width by Day 7's `Panel`, so the layout never breaks:

```ts
// day9/index.ts
function buildPanel(): string[] {
    const window = CONTEXT_WINDOW;
    const ctx = estimateTokens(JSON.stringify(chat.exportHistory()));
    const root = permissionRoot();
    const shownRoot = visibleWidth(root) <= ROOT_DISPLAY_WIDTH ? root : `…/${basename(root)}`;
    const todos = formatTodos();
    return [
        `Model  ${config.model}`,
        `Session  ${sessions.currentId()}`,
        `Root  ${shownRoot}`,
        '──── Context ────',
        `${ctx} / ${window} tokens`,
        `${Math.ceil((ctx / window) * 100)}% used`,
        '──── This turn ────',
        `${usage.round + usage.live} tokens`,
        '──── Total ────',
        `${usage.cum} tokens`,
        '──── TODO ────',
        ...(todos.length > 0 ? todos : ['(no tasks yet)']),
    ];
}
```

`/todos` doesn't maintain a second copy of the state; it just reads the same `formatTodos()`:

```ts
// day9/index.ts
        case '/todos': {
            const todos = formatTodos();
            tui.append(todos.length > 0 ? `TODO:\n${todos.join('\n')}` : '(no TODOs yet)', 'sys');
            break;
        }
```

## 4. Verification

```bash
npm run typecheck
npm run dev -- day9/index.ts
```

1. Type "have the subagent compare interface vs type in TypeScript and give a recommendation"
2. Confirm the right panel's status changes as execution proceeds, and `/todos` matches the right panel
3. Confirm the `delegate_task` result appears and the final reply completes normally

## 5. What We Didn't Do

- TODOs aren't persisted and don't follow session switches; checklist details live only in the history, and history compression may thin them out
- The subagent can't call tools or delegate further
- No parallel scheduling or failure retry yet

## 6. Next Step

Long tasks now have an observable execution order, but the Agent still doesn't know how the project expects it to work, and important conclusions live only in the current session. Next, we'll bring in both the rules the project writes down explicitly and the experience accumulated while running, keeping stable instructions always visible and letting scattered know-how be recalled on demand.
