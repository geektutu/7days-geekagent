---
title: Build GeekAgent from Scratch — Day 10 Project Instructions and Long-term Memory
description: >-
  A 7-day tutorial on building an Agent from scratch, writing the simplest possible Agent/Harness in TypeScript. Day 10 adds two kinds of cross-session information: AGENTS.md stores project rules, and memory stores know-how accumulated while running, so a freshly created session's model knows the project rules and remembers previously confirmed preferences.
date: '2026-08-29 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 10: Knowing the Project's Rules and Remembering User Preferences — Project Instructions and Long-term Memory

> GeekAgent can already save sessions, but after creating a new session, the model doesn't know the project rules and can't recall previously confirmed preferences. Today we add two kinds of cross-session information: `AGENTS.md` stores project rules, and memory stores know-how accumulated while running.

## 0. Two Kinds of "Remembering" Are Not the Same Thing

Say we want the Agent to write blog posts in the first person. This can go into `AGENTS.md`, or be told to the Agent during a chat with "please remember this". Both look like making the model remember one sentence, but they serve different purposes.

`AGENTS.md` is like the project's manual: we write it by hand and commit it alongside the code. The model reads it before every answer.

memory is more like the Agent's sticky notes. While working, the model writes down user preferences, project facts, and important decisions, then searches them later when needed. It's local runtime data and stays out of the repository.

| Aspect | `AGENTS.md` | memory |
|---|---|---|
| Who writes it | We write it by hand | The model calls `memory_write` |
| What it stores | Project rules, coding conventions, workflows | User preferences, project facts, important decisions |
| Enters the repository | Yes | No—`.geekagent/` is already ignored |
| When it updates | After editing the file, on next startup | Updated dynamically at runtime, searchable immediately after writing |
| How the model reads it | Carried in full with every request | Calls `memory_search` to fetch on demand |
| Context cost | As long as the file is, that's what's carried | At most 10 search results returned |
| Cross-session | Yes | Yes |

If we stuffed all of memory into every request too, it would barely differ from `AGENTS.md`. Today we keep project rules always visible, and long-term memory appears only when needed.

## 1. Goals

Today's acceptance criteria:

1. At startup, `AGENTS.md` from the working root is read, and every request places the full project rules in the system prompt in front of the history;
2. The model can use `memory_write` to save user preferences, project facts, and important decisions, then use `memory_search` to fetch them by keyword when recall is needed—instead of carrying all memories every round;
3. Long-term memory is written to `.geekagent/memory.json`, survives session switches and restarts, and `/memory` can view the current entries.

**Lines of code today**: relative to Day 9, Day 10 adds 128 lines and removes 13, for a net increase of 115 lines, staying under 500.

## 2. AGENTS.md: The Project's Manual Written for the Agent

### 2.1 The Result First

The project root `AGENTS.md` says "use fewer 'you' and more 'I/we' throughout". This rule is delivered to the model every round, so it applies from the very first conversation:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › write an opening line, no need to read the project</span>
<span style="color:#00cd00">We often say Agents are complicated, but I want to try building one from scratch with the dumbest methods and the least code.</span>
</pre>

### 2.2 Which File to Read

Day 8 already configured the working root in `.geekagent/GeekAgent.json`. We simply read the `AGENTS.md` under that directory, without adding any new path configuration.

The file is read once at startup, and after that every request places the full content in front of the chat history. A missing file just means an empty string. Project instructions don't belong to any particular session, so saving a session never saves them again.

### 2.3 instructions.ts: Reading the Full Project Instructions

Reading project instructions takes only 13 lines; here's the complete code:

```ts
// day10/instructions.ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Reads AGENTS.md from the project root; returns empty text when there are no project instructions. */
export async function loadInstructions(root: string): Promise<string> {
    try {
        return (await readFile(resolve(root, 'AGENTS.md'), 'utf8')).trim();
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw err;
    }
}
```

We read just this one file from the working root: return the full text if present, an empty string otherwise.

### 2.4 chat.ts: Delivered to the Model Every Round

`Chat` receives the contents of `AGENTS.md` at construction. Every request places it in front of the current session's history:

```ts
// day10/chat.ts
        const stream = await this.client.chat.completions.create({
          model: this.model,
          messages: [{ role: 'system', content: `${AGENT_SYSTEM}\n\nProject instructions (AGENTS.md):\n${this.instructions || 'none'}` }, ...this.history],
          tools: toOpenAITools(),
          tool_choice: forceTodo
              ? { type: 'function', function: { name: 'todo_write' } }
              : 'auto',
          stream: true,
          stream_options: { include_usage: true }, // Day 7: the final chunk carries this turn's usage
        });
```

No memory here. Project instructions appear directly; long-term memory appears only after a search.

## 3. memory: The Agent's Sticky Notes

### 3.1 The Result First

First have the Agent remember a preference, then switch to a new session:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › please remember: the user wants conclusions first in answers</span>
<span style="color:#cdcd00">[tool call memory_write → remembered: the user wants conclusions first in answers]</span>
<span style="color:#00cd00">Noted.</span>
<span style="color:#00cdcd">You › /new review</span>
<span style="color:#808080">(created and switched to session review)</span>
<span style="color:#00cdcd">You › recall what preferences the user has about answer style</span>
<span style="color:#cdcd00">[tool call memory_search → found 1 memory:</span>
<span style="color:#cdcd00">1. the user wants conclusions first in answers]</span>
<span style="color:#00cd00">The user wants conclusions first in answers.</span>
</pre>

The new session has none of the original chat history, and memory wasn't handed to the model up front either. The model searches first, then answers based on the results.

### 3.2 Memories Are Written to a Local JSON

Long-term memory uses the most direct structure possible—a string array:

```json
[
  "blog body text uses first person 'I/we'",
  "the user wants conclusions first in answers"
]
```

The file lives at `.geekagent/memory.json`. `.gitignore` already ignores this directory, so local memories never leak into code commits.

`memory_write` writes one complete fact at a time. The model decides what to remember; the program only handles deduplication and disk writes.

### 3.3 The Mainstream Approach Is Embeddings; Today We Start with Keywords

Memory search in the mainstream today uses embeddings: first a model converts text into a string of numbers, then you compare how close two number strings are. That way, searching for "reply style" might also find "the user wants conclusions first in answers".

| | Keyword search | Embedding search |
|---|---|---|
| Matching basis | Whether the same words appear | Semantic distance between vectors |
| Good at | Names, code, exact phrases | Synonymous expressions, paraphrases |
| Extra components | None | Embedding model; at scale also a vector database |
| Current choice | Adopted—runs in a few dozen lines | Not yet |

```text
write:   memory text ──embedding──> vector, saved along with the memory
search:  user question ──embedding──> query vector
                                      │
                                      └─ compute similarity with memory vectors ──> topN
```

With only a few hundred memories, vectors can live in JSON and be compared one by one in memory—no vector database needed. Only when memories grow more numerous does a database become necessary to speed up lookups. A memory's embedding is computed once at write time and saved; at search time only the question's embedding is computed.

However, embeddings require an extra model and configuration, and the service we're using may not support them. So today we substitute keywords: the model provides a few keywords, the program counts how many each memory hits, sorts by hit count, and returns at most 10.

```text
query: "blog person"

memory A: blog body text uses first person "I/we"   hits 2 words
memory B: the user wants conclusions first          hits 0 words
memory C: blog examples use real terminal output    hits 1 word

return order: A → C
```

When keywords don't match, relevant memories may be missed—that's the boundary we accept today. Swapping in embeddings later can keep both tools and the outer tool loop unchanged.

### 3.4 memory.ts: Writing and Searching

`memory.ts` is 78 lines in total: it reads the file at startup, registers the write and search tools, and exposes the memory list to the UI. Here's the complete code:

```ts
// day10/memory.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { registerTool, type Tool } from './tools.js';

const MEMORY_FILE = resolve('.geekagent/memory.json');
let items: string[] = [];

/** Restores long-term memory from disk at startup; a missing file means no memories yet. */
export async function loadMemory(): Promise<void> {
    try {
        const value = JSON.parse(await readFile(MEMORY_FILE, 'utf8')) as unknown;
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
            throw new Error('memory.json must be an array of strings');
        }
        items = value.map((item) => item.trim()).filter(Boolean);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            items = [];
            return;
        }
        throw err;
    }
}

/** Registers the memory-write tool; the model calls it when it judges some information worth keeping across sessions. */
export function setupMemory(changed: () => void): void {
    const tools: Tool[] = [
        {
            name: 'memory_write',
            description: 'Write user preferences, project facts, or important decisions worth keeping across sessions into long-term memory. Do not record temporary task progress or anything readable from files at any time.',
            parameters: {
                type: 'object',
                properties: { content: { type: 'string', description: 'a single, concise fact understandable even outside the current conversation' } },
                required: ['content'],
                additionalProperties: false,
            },
            run: async (args) => {
                const content = String(args.content ?? '').trim();
                if (!content) return 'missing argument content';
                if (items.includes(content)) return 'this memory already exists';
                const next = [...items, content];
                await mkdir(dirname(MEMORY_FILE), { recursive: true });
                await writeFile(MEMORY_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
                items = next;
                changed();
                return `remembered: ${content}`;
            },
        },
        {
            name: 'memory_search',
            description: 'Search long-term memory by keywords. Call it when you need to recall user preferences, project facts, or past decisions; the query uses one or more space-separated keywords.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'search keywords, multiple words separated by spaces, e.g. "blog person"' } },
                required: ['query'],
                additionalProperties: false,
            },
            run: (args) => {
                const keywords = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
                if (keywords.length === 0) return 'missing argument query';
                const matches = items
                    .map((content) => ({ content, score: keywords.filter((word) => content.toLowerCase().includes(word)).length }))
                    .filter((item) => item.score > 0)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 10);
                return matches.length > 0
                    ? `found ${matches.length} memories:\n${matches.map((item, i) => `${i + 1}. ${item.content}`).join('\n')}`
                    : 'no relevant memories found';
            },
        },
    ];
    tools.forEach(registerTool);
}

export function listMemories(): readonly string[] {
    return items;
}
```

Search does just three things: split keywords, count hits, take the top 10.

The built-in instruction tells the model when to write and when to search:

```ts
// day10/chat.ts
const AGENT_SYSTEM = `You are a local coding Agent. When a task needs multiple steps, first call todo_write to draft a brief plan, then execute item by item and update statuses; when the user explicitly asks for a TODO or task list, you must call todo_write first. Complete simple tasks directly—don't create TODOs just for ceremony. You may hand well-bounded analysis, design, or review tasks to delegate_task; multiple subtasks must be delegated serially. When a user preference, project fact, or important decision is worth keeping across sessions, call memory_write; when you need to recall such information, call memory_search and don't assume memory contents. Do not record temporary task progress or anything readable from files at any time.`;
```

After `memory_search` is called, the search results enter the current session just like any other tool result.

## 4. Loading Both Kinds of Information at Startup

The entry point loads permissions first to determine the project root; then it reads memory and `AGENTS.md`:

```ts
// day10/index.ts
const config = loadConfig();
let permissions;
try {
    permissions = await loadPermissions();
} catch (e) {
    console.error(`failed to read .geekagent/GeekAgent.json: ${(e as Error).message}`);
    process.exit(1);
}
let instructions = '';
try {
    await loadMemory();
    instructions = await loadInstructions(permissions.root);
} catch (e) {
    console.error(`failed to read project context: ${(e as Error).message}`);
    process.exit(1);
}
const chat = new Chat(config.baseURL, config.apiKey, config.model, instructions);
const sessions = new Sessions();
```

The two memory tools also join the permission table:

```ts
// day10/permissions.ts
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
    memory_write: 'allow',
    memory_search: 'allow',
};
```

The right panel shows "Instructions loaded/none" and "Memories N". `/memory` is for us to view local memories; it never sends the full contents to the model.

## 5. Verification

```bash
npm run typecheck
npm run dev -- day10/index.ts
```

1. Confirm the right panel shows "Instructions loaded", then have the Agent restate a rule from the root `AGENTS.md`
2. Type "please remember: the user wants conclusions first in answers" and confirm the `memory_write` result appears
3. Type `/new review`, then ask "recall the user's preferences about answer style", and confirm `memory_search` appears before the answer
4. Type `/memory` and restart Day 10, confirming the local memories still exist
5. Check `git status` and confirm `.geekagent/memory.json` never entered the repository

## 6. What We Didn't Do

- `AGENTS.md` reads only the one at the project root; multi-level instructions aren't merged
- memory is append-only; entries can't be edited or deleted
- Search matches keywords only; it doesn't understand semantics

## 7. Next Step

Project rules now always take effect, and know-how accumulated while running can be recalled on demand. Next, we'll group related instructions and tools into selectable capability packs, loaded only when needed.
