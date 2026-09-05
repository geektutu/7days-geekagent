---
lang: en
title: Build GeekAgent from Scratch — Day 8 Permissions and Rollback
description: >-
  A 7-day tutorial on building an Agent from scratch, writing the simplest possible Agent/Harness in TypeScript. Day 8 draws boundaries for tools and leaves an escape hatch for writes: use .geekagent/GeekAgent.json to define permissions and directory boundaries, and save the most recent state before every file write—operations that shouldn't happen are blocked up front, and mistakes can be reverted with /undo.
date: '2026-08-27 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 8: Drawing Boundaries for Tools, Leaving an Escape Hatch for Writes — Permissions and Rollback

> Day 7 already lets the Agent work continuously in the terminal, but "can call" is nearly the same as "has permission to call": read tools are always allowed, shell and write tools always ask, and file paths can point anywhere on the machine. Today we first use `.geekagent/GeekAgent.json` to draw permission and directory boundaries, then save the most recent state before every file write: operations that shouldn't happen are blocked up front, and content that was confirmed but written incorrectly can still be restored with `/undo`.

## 0. Why a Confirmation Dialog Is Not Yet a Permission System

The confirmation dialog from Day 3 solved "ask once before running this command", but it never answered three longer-term questions:

1. Can a read-only tool be allowed through every time?
2. Can a tool we don't want the Agent to use be rejected at the entry point?
3. Even if file tools skip confirmation, can we guarantee they only see the current project?

Baking the answers into the tools means editing TypeScript every time we switch projects. Worse, `read ../../.env` still counts as "read-only", yet it has already crossed the project boundary. What we need is not more confirmation dialogs, but a permission table independent of tool implementations, plus a boundary line that every file path must pass through.

That said, confirmation only means "allowed to write right now"; it can't guarantee every line written is correct. Since `write` and `patch` already share the same disk-write entry point, we can also remember "what things looked like before the write" there: permissions handle ex-ante control, undo handles ex-post recovery.

| Capability | Question it answers | Current implementation |
|---|---|---|
| Confirmation | Should this one action run? | TUI `[y/N]` |
| Permission policy | Can this tool usually run? | `allow` / `ask` / `deny` |
| Directory isolation | Where can tools reach at most? | `root` + `safePath` |
| Rollback | What if something was written wrong? | Save the most recent old state, restore with `/undo` |

Production-grade Agents often go further with OS sandboxes, containers, or finer-grained command rules. Day 8 implements the four most observable boundaries at the application layer; it reduces mistakes but is not equivalent to OS-level isolation.

## 1. Goals

Today's acceptance criteria:

1. `.geekagent/GeekAgent.json` configures `allow`, `ask`, or `deny` for each tool: run directly, ask first, or reject before the tool ever runs;
2. `ls` / `read` / `glob` / `write` / `patch` can only access the configured `root`; relative escapes, absolute paths, and symlink-based escapes are all rejected; secret values in tool results get replaced;
3. Before `write` and `patch` actually write, the old content is saved to `.geekagent/undo.json`; `/undo` can restore the overwritten file or delete a just-created file.

**Lines of code today**: Day 8 adds 155 net lines of source, including the new `day8/permissions.ts` at 111 lines and `day8/undo.ts` at 49 lines; after removing the hardcoded confirmation logic left by Day 7, the total increase still stays under 500 lines.

## 2. Design

### 2.1 Three Policies Answer Exactly One Question

The permission table doesn't judge whether a command "looks dangerous"; it gives every tool exactly three outcomes:

- `allow`: run directly
- `ask`: hand it to the TUI to show `[y/N]`
- `deny`: never enter the tool implementation, return a rejection immediately

This separates policy from tool code. `run_shell` can be `ask` in one project and `deny` in another used only for code reading. Unknown tools are denied by default, so a tool added later without configuration doesn't silently gain permissions.

### 2.2 Directory Isolation Can't Just Check for `..`

A path like `../secret` is easy to spot, but there's another route: the project can contain a symlink pointing outside the project. When comparing strings only, `root/link/secret` looks like it's still inside the root, yet the OS actually accesses an external directory.

So `safePath` checks twice: first `resolve` / `relative` blocks literal escapes, then `realpath` finds the true location on disk. When a new file doesn't exist yet, we walk up level by level to the first existing parent directory and confirm it hasn't escaped via a symlink.

`glob` doesn't receive ordinary file paths—its arguments contain `*` and `**`, so it can't go straight to `realpath`. It uses a narrower rule: only accept relative patterns without `..`, and pin the search `cwd` to the configured root directory.

### 2.3 Redaction Lives at the Tool's Single Exit Point

Running `env` in the shell, file tools reading configs, error messages echoing commands—any of these can carry secrets back to the model. Patching in replacements tool by tool is easy to get wrong, so `execTool` calls `redact` uniformly before results leave the registry. Confirmation prompts go through the same function, so neither the terminal nor the model ever sees the real value.

### 2.4 Keep Only One Most-Recent Snapshot

A full undo stack would need multiple records, capacity limits, and history cleanup. Here we solve the most direct problem: I just wrote a file wrong, take me back. So `.geekagent/undo.json` always holds a single record; the next write overwrites the previous one.

The record contains `path` relative to the permission root and the `content` before the write. Existing files store their original content as a string; a newly created file didn't exist before, so that's `null`. An empty file's content is `""`, which differs from `null`, so the two states never get confused.

During restore, the path in the record goes through `safePath` again. Even if someone hand-edits the undo file, `/undo` cannot write outside the configured root.

### 2.5 Back Up Only for Writes That Actually Happen

If the content didn't change, or the user picked `n` in the confirmation dialog, the disk doesn't change, and the previous undo record shouldn't be overwritten either. So the write sequence is fixed:

```text
generate new content -> show diff -> user confirms -> save old state -> write new content
```

Both `write` and `patch` end up in `commitWrite`, so the backup only needs to hook into that shared exit point once.

## 3. Implementation: The Result First

After changing `run_shell` to `deny`, asking the model to run a command gets rejected at the tool entry point:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › run echo hello</span>
<span style="color:#cdcd00">[tool call run_shell → permission denied: tool run_shell is not allowed]</span>
<span style="color:#00cd00">run_shell is currently denied by the permission config, so the command was not executed.</span>
</pre>

Switch it back to `ask` and the TUI confirmation appears; `allow` runs directly. Path escapes and sensitive values are blocked at the same exit point:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › read ../outside.txt</span>
<span style="color:#cdcd00">[tool call read → tool failed: path outside root: ../outside.txt]</span>
<span style="color:#00cd00">This path is outside the root configured in GeekAgent.json, so it cannot be read.</span>
</pre>

File writes automatically leave a snapshot after confirmation. When the content turns out wrong, there's no need to call the model again—just type `/undo`:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › change hello.txt to hello world</span>
<span style="color:#cdcd00">Confirm write to /home/me/project/hello.txt? → y</span>
<span style="color:#cdcd00">[tool call patch → applied 1 change to hello.txt]</span>
<span style="color:#00cd00">hello.txt has been changed to hello world.</span>
<span style="color:#00cdcd">You › /undo</span>
<span style="color:#808080">(undid the most recent write to hello.txt)</span>
</pre>

### 3.1 The First .geekagent/GeekAgent.json

The config is just a root directory and a tool table. `root` is resolved relative to the config file's directory:

```json
{
  "root": "..",
  "tools": {
    "get_current_time": "allow",
    "run_shell": "ask",
    "ls": "allow",
    "read": "allow",
    "glob": "allow",
    "write": "ask",
    "patch": "ask"
  }
}
```

On first launch, if the file doesn't exist, the program creates the `.geekagent` directory and writes this config automatically. `root` is resolved relative to the config file, so `..` points exactly at the project root. The defaults carry over the Day 7 experience: the time tool and read-only file tools run directly, shell and file writes ask first.

### 3.2 Permissions, Paths, and Redaction in One File

The permission logic lives in one new TypeScript file:

```ts
// day8/permissions.ts
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type Policy = 'ask' | 'allow' | 'deny';

export interface PermissionConfig {
    root: string;
    tools: Record<string, Policy>;
}

const DEFAULT_TOOLS: Record<string, Policy> = {
    get_current_time: 'allow',
    run_shell: 'ask',
    ls: 'allow',
    read: 'allow',
    glob: 'allow',
    write: 'ask',
    patch: 'ask',
};

let config: PermissionConfig = { root: process.cwd(), tools: DEFAULT_TOOLS };
let confirmFn: (prompt: string) => Promise<boolean> = async () => false;

/** Writes Day 7's default permissions when the config is missing; throws on a malformed config instead of silently loosening it. */
export async function loadPermissions(file = '.geekagent/GeekAgent.json'): Promise<PermissionConfig> {
    let raw: string;
    try {
        raw = await readFile(file, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const defaults = { root: '..', tools: { ...DEFAULT_TOOLS } };
        await mkdir(dirname(resolve(file)), { recursive: true });
        await writeFile(file, `${JSON.stringify(defaults, null, 2)}\n`);
        raw = JSON.stringify(defaults);
    }
    const value = JSON.parse(raw) as { root?: unknown; tools?: unknown };
    if (typeof value.root !== 'string' || !value.root.trim()) throw new Error('root in GeekAgent.json must be a non-empty string');
    if (!value.tools || typeof value.tools !== 'object' || Array.isArray(value.tools)) {
        throw new Error('tools in GeekAgent.json must be an object');
    }
    const tools = { ...DEFAULT_TOOLS };
    for (const [name, policy] of Object.entries(value.tools)) {
        if (policy !== 'ask' && policy !== 'allow' && policy !== 'deny') {
            throw new Error(`policy for tool ${name} must be ask / allow / deny`);
        }
        tools[name] = policy;
    }
    return { root: resolve(dirname(resolve(file)), value.root), tools };
}

export function setupPermissions(next: PermissionConfig, fn: (prompt: string) => Promise<boolean>): void {
    config = next;
    confirmFn = fn;
}

export function permissionRoot(): string {
    return config.root;
}

export function policyFor(tool: string): Policy {
    return config.tools[tool] ?? 'deny';
}

export async function authorize(tool: string, prompt = `tool ${tool} requests execution`): Promise<boolean> {
    const policy = policyFor(tool);
    if (policy === 'allow') return true;
    if (policy === 'deny') return false;
    return confirmFn(redact(prompt));
}

/** Returns an absolute path inside the root, using realpath to block symlink-based escapes. */
export async function safePath(input: string): Promise<string> {
    const root = resolve(config.root);
    const target = resolve(root, input);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`path outside root: ${input}`);

    let existing = target;
    while (true) {
        try {
            existing = await realpath(existing);
            break;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            const parent = dirname(existing);
            if (parent === existing) throw err;
            existing = parent;
        }
    }
    const realRoot = await realpath(root);
    const realRel = relative(realRoot, existing);
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error(`path outside root: ${input}`);
    return target;
}

/** glob is pinned to root as cwd; the pattern itself only allows relative forms inside the root. */
export function safeGlob(pattern: string): string {
    if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) throw new Error(`path outside root: ${pattern}`);
    return pattern;
}

/** Only masks the real values of sensitive environment variables; ordinary output passes through unchanged. */
export function redact(text: string): string {
    let result = text;
    for (const [name, value] of Object.entries(process.env)) {
        if (!/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) || !value) continue;
        result = result.replaceAll(value, `[REDACTED:${name}]`);
    }
    return result;
}
```

Three functions guard different spots:

- `policyFor` returns `deny` for unknown tools
- `safePath` checks both the path string and the real disk location
- `redact` identifies sensitive values by variable name, then replaces any occurrence of the real value in the output

### 3.3 The Tool Registry Enforces Policy Uniformly

Ordinary tools get authorized in `execTool`; shell, write, and patch need to show the command or diff first, so they build a detailed prompt and then call the same `authorize`. The shared exit point also redacts results and errors:

```ts
// day8/tools.ts
export async function execTool(name: string, argsJson: string): Promise<string> {
    const tool = registry.find((t) => t.name === name);
    if (!tool) return `unknown tool: ${name}`;

    let args: Record<string, unknown> = {};
    try {
        args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
        return redact(`arguments are not valid JSON: ${argsJson}`);
    }

    try {
        if (policyFor(name) === 'deny') return `permission denied: tool ${name} is not allowed`;
        if (!tool.authorizes && !(await authorize(name))) return `permission denied: tool ${name} is not allowed`;
        return redact(await tool.run(args));
    } catch (err) {
        return redact(`tool failed: ${(err as Error).message}`);
    }
}
```

The file tools call `safePath` first on any path the model passes in; `glob` always searches from `permissionRoot()`. The underlying Node file APIs don't need to know about the permission config—their job remains reading and writing.

### 3.4 Wiring the TUI Confirmation into the Permission Layer

At startup we load the permission config, then inject the confirmation component that Day 7 already has into the permission layer:

```ts
// day8/index.ts
const config = loadConfig();
let permissions;
try {
    permissions = await loadPermissions();
} catch (e) {
    console.error(`failed to read .geekagent/GeekAgent.json: ${(e as Error).message}`);
    process.exit(1);
}
const chat = new Chat(config.baseURL, config.apiKey, config.model);
const sessions = new Sessions();
```

```ts
// day8/index.ts
const tui = new TUI(onLine, onExit);
setupPermissions(permissions, (prompt) => tui.confirm(prompt));
```

The TUI doesn't need to understand `allow` or `deny`. Only when the permission layer decides on `ask` does it collect one `y/N`.

The confirmation question is first written into the main area, then the input line switches to `[y/N]`. After answering, the question isn't printed again; instead `→ y` or `→ n` is appended on the original line, so shell commands and write targets stay visible.

The root directory can be a long absolute path; handing it straight to the panel gets it truncated from the right, hiding the most recognizable project directory name. When the panel lacks space, we shrink it into something like a zsh prompt, `…/geekagent`:

```ts
// day8/index.ts
const root = permissionRoot();
const shownRoot = visibleWidth(root) <= ROOT_DISPLAY_WIDTH ? root : `…/${basename(root)}`;
```

### 3.5 Saving and Restoring the Most Recent State

The second new module handles writing the snapshot and consuming it:

```ts
// day8/undo.ts
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { permissionRoot, safePath } from './permissions.js';

const UNDO_FILE = resolve('.geekagent/undo.json');

interface UndoRecord {
    path: string;
    content: string | null;
}

/** Saves the most recent file state before hitting the disk; null means the file didn't exist before. */
export async function backup(file: string, content: string | null): Promise<void> {
    const record: UndoRecord = {
        path: relative(permissionRoot(), file).replaceAll('\\', '/'),
        content,
    };
    await mkdir(dirname(UNDO_FILE), { recursive: true });
    await writeFile(UNDO_FILE, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** Restores the state from before the most recent write, then deletes the snapshot to avoid double undo. */
export async function undo(): Promise<string> {
    let record: UndoRecord;
    try {
        record = JSON.parse(await readFile(UNDO_FILE, 'utf8')) as UndoRecord;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'nothing to undo';
        throw new Error(`failed to read undo record: ${(err as Error).message}`);
    }
    if (typeof record.path !== 'string' || (record.content !== null && typeof record.content !== 'string')) {
        throw new Error('invalid undo record format');
    }

    const file = await safePath(record.path);
    if (record.content === null) {
        try {
            await unlink(file);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
    } else {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, record.content, 'utf8');
    }
    await unlink(UNDO_FILE);
    return `undid the most recent write to ${record.path}`;
}
```

`undo.json` is deleted only after the restore succeeds. If the path check or file write fails, the snapshot remains, so you can retry after investigating.

### 3.6 Backing Up at the Shared Write Exit Point

`commitWrite` was already the shared exit point for `write` and `patch`. The old content now serves both diff generation and the undo snapshot:

```ts
// day8/tools.ts
async function commitWrite(tool: 'write' | 'patch', file: string, next: string): Promise<boolean> {
    let oldtxt: string | null = null;
    try {
        oldtxt = await readFile(file, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (oldtxt === next) return true;
    if (!(await authorize(tool, `\n${simpleDiff(oldtxt ?? '', next)}\nConfirm write to ${file}?`))) return false;
    await backup(file, oldtxt);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next);
    return true;
}
```

`/undo` is a local command explicitly issued by the user; it never goes through the model and never adds to the conversation history:

```ts
// day8/index.ts
case '/undo':
    try {
        tui.append(`(${await undo()})`, 'sys');
    } catch (e) {
        tui.append(`undo failed: ${(e as Error).message}`, 'sys');
    }
    break;
```

## 4. Verification

First run a full type check:

```bash
npm run typecheck
```

Then start Day 8:

```bash
npm run dev -- day8/index.ts
```

Verify in this order:

1. Delete `.geekagent/GeekAgent.json` and start up—confirm the program generates the default config: read-only tools run directly, shell and write tools ask first
2. Change `run_shell` to `deny` and confirm commands get rejected; then read `../package.json` and confirm the file tool returns "path outside root"
3. Run `env` and confirm the value of `OPENAI_API_KEY` shows as `[REDACTED:OPENAI_API_KEY]`
4. Undo one newly created file and one overwrite—confirm the file is deleted or restored; modify a file, restart, then run `/undo` and confirm the snapshot still works

## 5. What We Didn't Do

- Directory isolation doesn't cover `run_shell`, and file changes made through the shell can't be undone
- The config is project-level only; no global config or hot reload
- Only the most recent file write is kept; no multi-step undo or redo

## 6. Next Step

Permissions and rollback let the Agent act more safely, but faced with a large task it still tends to think and act at the same time and lose track of progress. Next, we'll have it list checkable steps first, then work through them in order, keeping the current progress always visible.
