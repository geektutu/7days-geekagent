---
lang: en
title: Build GeekAgent from Scratch — Day 6 Multiple Sessions and Persistence
description: >-
  A 7-day tutorial on building an Agent from scratch, writing the simplest possible Agent/Harness in TypeScript. Day 6 does two things: let one process maintain several mutually independent sessions at once (/new, /sessions, /open), then persist the whole session collection together with the current ID to JSON in one shot (/save, /load, auto-save on exit) — "chat long" is upgraded to "split apart and kept around".
date: '2026-08-25 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 6: Juggle Several Conversations, Keep Them After the Window Closes — Multiple Sessions and Session Persistence

> Day 5 can already compact an overlong `history`, but every topic still crowds into the same array: code in the morning, research in the afternoon — the model sees both contexts every single turn. Day 6 does two things: let one process maintain several mutually independent sessions at the same time (`/new`, `/sessions`, `/open`), then persist **the whole session collection together with the current ID** to JSON in one shot (`/save`, `/load`, auto-save on exit) — "chat long" is upgraded to "split apart and kept around".

## 0. Why Split Sessions and Write to Disk

Start with what memory lacks. What we need is not a bigger `history` but several mutually independent `history` arrays: each session is tagged with an ID, switching tasks switches the corresponding message array, and the model no longer carries unrelated topics every turn; topics stay in their own lanes, so summaries no longer pollute each other.

Then what the process lacks. Even with several sessions, they live only in memory: exit the program, and `default`, `work`, and their messages all vanish. So the thing to persist is not whichever `history` happens to be chatting, but **the entire session collection plus the current session ID** — write that state into one JSON file, restore it wholesale on the next launch, and the in-memory model maps one-to-one onto the disk model.

## 1. Goals: Sessions You Can Switch, and Keep Across Processes

Acceptance criteria:

- `/new work` creates an empty session; after switching back and forth with `/open <id>`, each session still keeps its own messages, and `/sessions` shows the current session and message counts;
- `/save` writes all sessions plus the current ID to `.geekagent/sessions.json`; after `/load` restores them, we still land on the session that was current at save time;
- A normal exit auto-saves; the temporary `default` session gets an ID it can be reopened by, so the conversation can continue after a restart.

**Lines of code for the day**: 835 lines across 7 source files (Day 5 was 646, a **net gain of 189 lines**). New files: `sessions.ts` (91 lines) and `storage.ts` (15 lines); `chat.ts` gains 10 lines (import and export), `index.ts` gains 73 lines (command wiring and save-on-exit).

## 2. Design: One Chat, a Set of Histories, One Disk Snapshot

### 2.1 Why Not Create Multiple Chats

The most obvious approach is one `Chat` object per session. But besides `history`, `Chat` also holds the OpenAI client, the model configuration, and the full tool loop. Cloning the whole object just to hold several arrays carries far too much baggage.

We keep a single `Chat` and add a `Sessions` class managing a `Map<string, Message[]>`. On a switch, we first hand `Chat`'s current messages back to the Map, then place the target array into `Chat`. The model-calling logic never needs to know what a "session" is.

| | One `Chat` per session | One `Chat` + `Sessions` |
|---|---|---|
| OpenAI client | One copy per object | Shared by all sessions |
| Model and tool configuration | Easily duplicated | Maintained once |
| Session differences | The entire object | Only `history` |
| Switching | Swap `Chat` objects | Export and import message arrays |

If different sessions needed different models or tools, multiple `Chat`s would be more natural; here every session shares the same configuration, so we separate only the part that actually varies: `history`.

### 2.2 Why Current Messages Must Be Synced Before Switching

`Chat.streamReply()` keeps appending messages to the array, and history compaction may even swap in a brand-new array. The reference inside the Map is not guaranteed to stay current. That is why `/new`, `/open`, and `/sessions` all pass `chat.exportHistory()` to `Sessions` — sync the current session first, then act.

### 2.3 Why IDs Are Restricted to Certain Characters

Today we start reading and writing files, and IDs become keys in the archive. Constraining them to `/^[a-zA-Z0-9_-]+$/` right away keeps the command format simple, and whatever storage comes later can use them as-is — no need to revisit session rules.

### 2.4 What the Archive Looks Like

The archive has only two layers: `current` records the current ID, and `sessions` maps IDs to message arrays.

```json
{
  "current": "work",
  "sessions": {
    "default": [],
    "work": [
      { "role": "user", "content": "Continue with Day 6" },
      { "role": "assistant", "content": "OK." }
    ]
  }
}
```

A Map cannot become a JSON object directly, so `Sessions.dump()` uses `Object.fromEntries` to build a plain object; on restore, `Object.entries` rebuilds the Map.

### 2.5 Why Sessions Validates and storage Only Reads and Writes

`storage.ts` does not understand session structure; it handles only mkdir, JSON, and file paths. `Sessions.restore()` is the one that knows what a valid ID is, what a message array is, and whether the current ID exists. The division of labor matches section 2.1: `Sessions` owns session rules, the disk module owns files. When storage moves to multiple files or a database later, the session rules do not have to move house.

### 2.6 Why Auto-Save Once More on Exit

Relying only on manual `/save` is easy to forget. Node's readline fires a `close` event on `/exit`, Ctrl+D, or when the input stream closes, so the same save logic hangs off that event: before any normal departure, the latest snapshot always lands on disk.

Manual and automatic saving must not be two separate implementations, so we extract `saveAll()`: it syncs the current history first, then saves the whole collection. `/save` and `close` merely decide when to call it.

### 2.7 Why default Must Get a New ID on Exit

`default` is just a temporary name created at every launch. If we save under it directly, the `default` session written on the first exit gets overwritten by the same-named session freshly created on the next launch. The terminal says "saved", but the user has no stable ID to find it again.

So on a normal exit, check the current session first: if it is still called `default`, take the first 8 characters of a UUID as the ID, rename the Map key from `default` to that ID, then save. Eight characters are friendlier to type by hand than a full UUID; after generating, we also check the Map for a name collision and regenerate on one. Sessions already named through `/new work` need no renaming and are saved under the user-given ID.

## 3. Implementation: Effect First, Then Code

### 3.0 Terminal Demo

We chat one round in `default` first (so it has 2 messages), create `work`, which starts from an empty array, and switch back and forth without the conversations ever bleeding into each other; `/save` the whole collection and exit, restart the process, then `/load`, and both `work` and the asterisk come back:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 6 — multiple sessions and persistence (model: deepseek-v4-flash, current session: default)</span>
<span style="color:#00cdcd">You › Help me remember: the project name is GeekAgent and the author is geektutu. Reply with only "OK".</span>
<span style="color:#00cd00">OK</span>
<span style="color:#00cdcd">You › /new work</span>
<span style="color:#808080">(created and switched to session work)</span>
<span style="color:#00cdcd">You › /sessions</span>
<span style="color:#808080">Sessions:</span>
<span style="color:#808080">  default (2 messages)</span>
<span style="color:#808080">* work (0 messages)</span>
<span style="color:#00cdcd">You › My TODO for the afternoon: add backup to the write tool, then write a demo doc. Reply with only "OK".</span>
<span style="color:#00cd00">OK</span>
<span style="color:#00cdcd">You › /sessions</span>
<span style="color:#808080">Sessions:</span>
<span style="color:#808080">  default (2 messages)</span>
<span style="color:#808080">* work (2 messages)</span>
<span style="color:#00cdcd">You › /save</span>
<span style="color:#808080">(saved 2 sessions to /home/daijie/git/geekagent/.geekagent/sessions.json)</span>
<span style="color:#00cdcd">You › /exit</span>
<span style="color:#808080">(saved 2 sessions to /home/daijie/git/geekagent/.geekagent/sessions.json before exit)</span>
<span style="color:#808080">bye</span>
<span style="color:#808080">── process restarted ──</span>
<span style="color:#808080">GeekAgent Day 6 — multiple sessions and persistence (model: deepseek-v4-flash, current session: default)</span>
<span style="color:#00cdcd">You › /load</span>
<span style="color:#808080">(restored 2 sessions from /home/daijie/git/geekagent/.geekagent/sessions.json, current: work)</span>
<span style="color:#00cdcd">You › /sessions</span>
<span style="color:#808080">Sessions:</span>
<span style="color:#808080">  default (2 messages)</span>
<span style="color:#808080">* work (2 messages)</span>
</pre>

What comes back is more than two message arrays — after the restart, the asterisk sits on `work` again, showing that the current ID crossed the process boundary along with everything else.

If you never named a session with `/new` beforehand, a short ID is generated and printed on exit:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › /exit</span>
<span style="color:#808080">(saved 1 session to /home/daijie/git/geekagent/.geekagent/sessions.json before exit)</span>
<span style="color:#808080">(session ID: 97f61f19 — after restarting, use /load and then /open 97f61f19 to reopen it)</span>
<span style="color:#808080">bye</span>
</pre>

That ID has already been written into the archive. After restarting, `/load` restores the disk snapshot, then `/open 97f61f19` reopens the session under the ID printed at exit.

### 3.1 Sessions: the Complete Multi-Session Collection + Snapshot and Restore

The complete new file for the day (including both ends of serialization):

```ts
// day6/sessions.ts
import type OpenAI from 'openai';
import { randomUUID } from 'node:crypto';

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer', 'function']);

export interface SessionData {
    current: string;
    sessions: Record<string, Message[]>;
}
/** Collection of sessions; Day 6 adds serialization and restore for the whole collection. */
export class Sessions {
    private items = new Map<string, Message[]>([['default', []]]);
    private current = 'default';

    currentId(): string {
        return this.current;
    }

    nameDefault(currentMessages: Message[]): string | undefined {
        if (this.current !== 'default') return undefined;
        let id: string;
        do id = randomUUID().slice(0, 8); while (this.items.has(id));
        this.items.delete('default');
        this.items.set(id, currentMessages);
        this.current = id;
        return id;
    }

    create(id: string, currentMessages: Message[]): Message[] {
        checkId(id);
        if (this.items.has(id)) throw new Error(`session ${id} already exists`);
        this.items.set(this.current, currentMessages);
        this.items.set(id, []);
        this.current = id;
        return [];
    }

    open(id: string, currentMessages: Message[]): Message[] {
        checkId(id);
        if (id === this.current) {
            this.items.set(id, currentMessages);
            return currentMessages;
        }
        const messages = this.items.get(id);
        if (!messages) throw new Error(`session ${id} does not exist`);
        this.items.set(this.current, currentMessages);
        this.current = id;
        return messages;
    }

    list(currentMessages: Message[]): { id: string; count: number; current: boolean }[] {
        this.items.set(this.current, currentMessages);
        return [...this.items]
            .map(([id, messages]) => ({ id, count: messages.length, current: id === this.current }))
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    dump(currentMessages: Message[]): SessionData {
        this.items.set(this.current, currentMessages);
        return { current: this.current, sessions: Object.fromEntries(this.items) };
    }

    restore(data: unknown): Message[] {
        if (!isSessionData(data)) throw new Error('the archive is not valid multi-session data');
        this.items = new Map(Object.entries(data.sessions));
        this.current = data.current;
        return this.items.get(this.current)!;
    }
}

function checkId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new Error('session IDs may contain only letters, digits, hyphens, and underscores');
}

function isSessionData(value: unknown): value is SessionData {
    if (!value || typeof value !== 'object') return false;
    const data = value as Partial<SessionData>;
    if (typeof data.current !== 'string' || !data.sessions || typeof data.sessions !== 'object') return false;
    return Object.entries(data.sessions).every(([id, messages]) =>
        ID_PATTERN.test(id) && Array.isArray(messages) && messages.every(isMessage)
    ) && Object.hasOwn(data.sessions, data.current);
}

function isMessage(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const role = (value as { role?: unknown }).role;
    return typeof role === 'string' && ROLES.has(role);
}
```

- `nameDefault` handles only the temporary `default`: it generates a non-colliding 8-character ID, keeps the current messages, and updates `current`. A session that already has a name returns `undefined`, so the exit notice prints no extra ID.
- `create` and `open` both return the target message array, which the CLI hands straight to `Chat`. `list` returns the minimum information needed for display and never exposes the internal Map.
- **`dump` / `restore` are the heart of this serialization day**: `dump` syncs the current history into the Map first, then builds a plain object with `Object.fromEntries`; `restore` completes all validation first and replaces `items` and `current` only after success — a bad archive never leaves behind a "half-restored" state. `isMessage` only checks that `role` is one of the legal roles; full OpenAI schema validation is left for later (see section 5).

### 3.2 Chat: Opening history for Import and Export

Two new methods in `day6/chat.ts`, doing nothing but handing over message arrays:

```ts
// day6/chat.ts
  exportHistory(): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return this.history;
  }

  importHistory(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): void {
    this.history = messages;
  }
```

### 3.3 storage.ts: the Complete Disk Layer

Only 15 lines are given to disk — it never touches session structure, only files:

```ts
// day6/storage.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { SessionData } from './sessions.js';

const SESSION_FILE = resolve('.geekagent/sessions.json');

export async function saveSessions(data: SessionData): Promise<string> {
    await mkdir(dirname(SESSION_FILE), { recursive: true });
    await writeFile(SESSION_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return SESSION_FILE;
}

export async function loadSessions(): Promise<{ data: unknown; file: string }> {
    return { data: JSON.parse(await readFile(SESSION_FILE, 'utf8')), file: SESSION_FILE };
}
```

The read result is deliberately kept as `unknown`; only after passing through `Sessions.restore()` does it become trusted session data — if `JSON.parse` fails (say the file was hand-edited into nonsense), the error is caught in the `/load` branch and the current in-memory state is not replaced.

### 3.4 CLI: create, list, and switch

First, create the single session collection:

```ts
// day6/index.ts
const config = loadConfig();
const chat = new Chat(config.baseURL, config.apiKey, config.model);
const sessions = new Sessions();
```

```ts
// day6/index.ts
async function saveAll(): Promise<{ count: number; file: string }> {
    const data = sessions.dump(chat.exportHistory());
    const file = await saveSessions(data);
    return { count: Object.keys(data.sessions).length, file };
}
```

The three switching commands all sync the current history to `Sessions` first:

```ts
// day6/index.ts
                case '/new':
                    if (!id) {
                        err('sys', 'usage: /new <id>');
                        break;
                    }
                    try {
                        chat.importHistory(sessions.create(id, chat.exportHistory()));
                        out('sys', `(created and switched to session ${id})`, true);
                    } catch (e) {
                        err('sys', `failed to create: ${(e as Error).message}`);
                    }
                    break;
                case '/sessions': {
                    const list = sessions.list(chat.exportHistory());
                    const lines = list.map((item) => `${item.current ? '*' : ' '} ${item.id} (${item.count} messages)`);
                    out('sys', `Sessions:\n${lines.join('\n')}`, true);
                    break;
                }
                case '/open':
                    if (!id) {
                        err('sys', 'usage: /open <id>');
                        break;
                    }
                    try {
                        const messages = sessions.open(id, chat.exportHistory());
                        chat.importHistory(messages);
                        out('sys', `(switched to session ${id}, ${messages.length} messages)`, true);
                    } catch (e) {
                        err('sys', `failed to open: ${(e as Error).message}`);
                    }
                    break;
```

### 3.5 CLI: manual save and load

The complete `/save` and `/load` branches:

```ts
// day6/index.ts
                case '/save':
                    try {
                        const { count, file } = await saveAll();
                        out('sys', `(saved ${count} sessions to ${file})`, true);
                    } catch (e) {
                        err('sys', `failed to save: ${(e as Error).message}`);
                    }
                    break;
                case '/load':
                    try {
                        const { data, file } = await loadSessions();
                        const messages = sessions.restore(data);
                        chat.importHistory(messages);
                        out('sys', `(restored ${sessions.list(messages).length} sessions from ${file}, current: ${sessions.currentId()})`, true);
                    } catch (e) {
                        err('sys', `failed to load: ${(e as Error).message}`);
                    }
                    break;
```

`/save` first has Sessions sync the current history and produce a snapshot; `/load` restores Sessions first, then hands the current session's messages to Chat.

### 3.6 close: auto-save before exit

Every normal close runs through the same `close` listener. After saving, it no longer calls `process.exit()` to force termination, letting the async file write finish naturally:

```ts
// day6/index.ts
rl.on('close', async () => {
    try {
        const generatedId = sessions.nameDefault(chat.exportHistory());
        const { count, file } = await saveAll();
        out('sys', `(saved ${count} sessions to ${file} before exit)`, true);
        if (generatedId) {
            out('sys', `(session ID: ${generatedId} — after restarting, use /load and then /open ${generatedId} to reopen)`, true);
        }
    } catch (e) {
        err('sys', `failed to save before exit: ${(e as Error).message}`);
    }
    out('sys', 'bye', true);
});
```

`nameDefault()` must be called before `saveAll()` so the generated ID makes it into the disk snapshot. Only when an ID was actually generated for `default` does the extra recovery line get printed. If saving fails, `bye` still prints and the program exits — exit behavior must not hang because the disk happens to be unwritable.

`/help` and the startup banner register the new commands as well; the `current session: …` in the banner comes from `sessions.currentId()`.

## 4. Verification

```bash
npm run dev -- day6/index.ts
```

1. Chat one round in `default`, type `/new work`, chat another round; switch back and forth with `/sessions` and `/open` — the messages on the two sides should never interfere.
2. While `work` is current, `/exit` directly: it should auto-save and generate no new ID; after restarting, `/load` should leave session count, message counts, and the current session exactly as before exit.
3. Back up and move the test archive away, restart, chat one round in `default` only and `/exit`; the exit message should print an 8-character session ID. Start again, run `/load` and `/open <id>`, and the previous conversation should be found again.

```bash
npm run typecheck
```

## 5. What We Didn't Do

- **Save on abnormal termination**: `SIGKILL`, power loss, or a crash never triggers `close`, so the last stretch of changes can still be lost.
- **Session management**: sessions cannot be deleted or renamed yet.
- **Concurrent write protection**: when several processes save, the last writer overwrites the earlier ones.

## 6. Next Step

Multiple contexts can now be switched and persisted together, but the running state still hides inside the program. The next step makes that state visible, helping us judge how many resources one conversation consumed and how far we are from the model's context limit.
