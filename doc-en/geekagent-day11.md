---
lang: en
title: Build GeekAgent from Scratch — Day 11 Skills
description: >-
  A 7-day tutorial on building an Agent from scratch, writing the simplest possible Agent/Harness in TypeScript. Day 11 packages task instructions and tools into skills that can be loaded and unloaded on demand, controlling which tools the model can see at any moment.
date: '2026-08-30 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 11: Switching Instructions and Tools per Task — The Skills System

> Day 10 could already load project instructions. Today we put one set of task instructions and a group of tools into the same directory, making a skill that can be loaded and unloaded at any time.

## 0. Are Skills Just an Enhanced Prompt?

Hearing the word "skill", it's natural to wonder: isn't this just a longer prompt? The project already has `AGENTS.md` — why build skills on top of it?

Both give the model instructions, but they solve different problems:

| | `AGENTS.md` | skills |
|---|---|---|
| Scope | The whole project | The current task |
| When it takes effect | Loaded on every request | Loaded with `/use`, unloaded with `/unuse` |
| What it contains | Project instructions | Task instructions and tools |
| Tool control | Doesn't change the tool list | Can add or filter tools |

For example, if `AGENTS.md` says "read code only, don't modify anything", the model still sees `write` and `patch`. That's a behavioral requirement.

If we load the `explore` skill, the program only sends `ls`, `glob`, and `read` to the model. The modification tools are simply not visible. On the other side, the `code-review` skill can bring along a `git_diff` tool that doesn't exist by default.

So `AGENTS.md` handles the project's long-term rules, while skills handle the instructions and capabilities of the current task. With that distinction clear, let's look at why skills are needed.

## 1. Why: Different Tasks Need Different Tools

Concrete tasks call for different approaches. A code review needs the diff first; a read-only browse only needs to look at directories and files. If we cram all of these requirements into `AGENTS.md`, the project instructions grow longer and longer, and the model reads content unrelated to the current task on every request.

A better approach is to split by task: loading the code-review skill adds `git_diff`; loading the read-only skill exposes only three read-only tools to the model.

So one skill solves two things: it tells the model how to complete the current task, and it decides which tools the model can use while doing so.

## 2. Goals

1. Each subdirectory under `skills/` is one skill; `SKILL.md` holds the description, the built-in tool whitelist, and the task instructions, and an optional `tools.ts` exports the skill's own tools;
2. After `/use code-review`, the skill's instructions enter the system prompt and `git_diff` joins the tool list; after switching to `explore`, the model sees only `ls` / `glob` / `read`;
3. `/skills` shows the available skills and their current state, and `/unuse` removes the skill's tools, clears its instructions, and restores the default tool list.

**Lines of code today**: relative to Day 10, 254 lines added, 15 removed, 239 net.

## 3. Design: Skill Directories, Tools, and State

### 3.1 One Skill Is One Directory

Each subdirectory represents one skill:

```
day11/skills/
├── code-review/
│   ├── SKILL.md        # description + tool whitelist + system prompt
│   └── tools.ts        # the skill's own tools (optional)
└── explore/
    └── SKILL.md        # an instructions-only skill, no bundled tools
```

`SKILL.md` has two parts: the top records the description and the built-in tool whitelist; the bottom holds the task instructions for the model:

```md
<!-- day11/skills/example/SKILL.md -->
---
description: Review code changes from a senior engineer's perspective
tools:
- read
- glob
---
You are a senior code review expert. ...
```

`description` shows up in the `/skills` list; `tools` names the built-in tools that remain usable once the skill is loaded.

Mature skill systems usually also adopt **progressive disclosure**: the model first sees skill names and one-line summaries, the full instructions load only after one is chosen, and scripts, templates, or reference material are read only when needed. That way, even many skills never fill the context all at once.

This version implements the smallest flow: scan the local directory at startup, let the user pick a skill with `/use`, and load one `SKILL.md` plus an optional `tools.ts`.

| | Common skill systems | This demo |
|---|---|---|
| Selection | The model picks automatically by description | The user runs `/use` |
| Loading | Loaded layer by layer on demand | Instructions and tools loaded at once |
| What it can carry | Instructions, tools, scripts, references | Instructions and tools |
| Scale | Many skills, long-term growth | A few local skills, principles first |

The core idea is the same in both: put the context and capabilities a class of tasks needs in one place. The demo skips automatic selection and multi-layer resources, and gets loading, tool filtering, and unloading working first.

### 3.2 Tools Come from Two Sources

A skill can use two kinds of tools at once:

- `tools.ts` exports the skill's own tools, such as `git_diff` for `code-review`;
- the `tools` list in `SKILL.md` picks which built-in tools stay visible.

`setVisibleTools` stores the current list, and `toOpenAITools()` filters tools before sending them to the model. With no skill loaded, all built-in tools stay visible as usual.

### 3.3 Only One Skill at a Time

To keep two sets of instructions and tool lists from conflicting, only one skill is kept at a time:

- `useSkill` unloads the previous skill first, then registers the new tools and sets the visible list;
- `unuseSkill` removes the skill's tools and restores every built-in tool.

A skill's bundled tools also pass through Day 8's permission layer, defaulting to `ask`.

## 4. Implementation: Effect First, Then Code

### 4.1 The Effect First

What you see in the TUI after startup (colors reproduced in HTML):

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 11 — Skills</span>
<span style="color:#808080">You'll see code-review and explore under day11/skills/. Curious what a skill looks like? /skills lists them, /use &lt;name&gt; loads one, /unuse unloads.</span>
<span style="color:#00cdcd">You › /skills</span>
<span style="color:#808080">Available skills (from the skills/ directory, load with /use):</span>
<span style="color:#808080">  code-review — Review code changes from a senior engineer's perspective: read the diff first, then comment item by item</span>
<span style="color:#808080">  explore — Read-only helper: browse code and directories only, never modify files or run commands</span>
<span style="color:#00cdcd">You › /use code-review</span>
<span style="color:#cdcd00">Loaded skill code-review (bundled: git_diff; built-in: read, glob)</span>
<span style="color:#00cdcd">You › I haven't committed today's changes yet. Take a look and tell me what's most worth changing</span>
<span style="color:#cdcd00">tool git_diff requests execution [y/N] → y</span>
<span style="color:#cdcd00">[tool call git_diff → 1 file changed: day11/skills.ts</span>
<span style="color:#cdcd00">diff --git a/day11/skills.ts b/day11/skills.ts</span>
<span style="color:#cdcd00">new file mode 100644</span>
<span style="color:#cdcd00">+import { readdir, readFile } from 'node:fs/promises';</span>
<span style="color:#cdcd00">…]</span>
<span style="color:#00cd00">This change centralizes skill loading in skills.ts. I'd focus the review on useSkill: it unloads the previous skill first, then registers the new tools and sets the visible list — the order is clear. No blocking issues found for now.</span>
<span style="color:#00cdcd">You › /use explore</span>
<span style="color:#cdcd00">Loaded skill explore (built-in: ls, glob, read)</span>
<span style="color:#00cdcd">You › How many lines of code does this project have? Run a few commands and count</span>
<span style="color:#00cd00">I currently only carry the three read-only tools ls / glob / read and can't run shell commands; but I can use glob to find all the code files first, then read a few of the bigger ones and give you an estimate.</span>
<span style="color:#00cdcd">You › /unuse</span>
<span style="color:#cdcd00">(Skill unloaded, default behavior restored)</span>
</pre>

After `code-review` loads, the model gains `git_diff`. After switching to `explore`, the model only sees `ls`, `glob`, and `read`. These are exactly the two operations a skill can perform on the tool list: adding and filtering.

### 4.2 skills.ts: Loading and Unloading Skills

The body of the skill system is `day11/skills.ts`, in full:

```ts
// day11/skills.ts
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerTool, setVisibleTools, unregisterTool, type Tool } from './tools.js';
import { ensureToolPolicy } from './permissions.js';

const SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'skills');

export interface Skill {
    name: string;
    description: string;
    instructions: string;
    /** Tools bundled with a skill: registered on load, removed on unload, callable only while the skill is active. */
    tools: Tool[];
    /** Built-in tool whitelist declared in the SKILL.md header; empty array = no filtering. */
    builtinTools: string[];
}

let skills: Skill[] = [];
let active: Skill | null = null;

/** Parse SKILL.md: the `---` header block holds description / tools; the body between the two `---` lines is the instruction text. */
function parseSkill(dir: string, name: string, raw: string): Skill {
    const lines = raw.split('\n');
    let description = '';
    const builtinTools: string[] = [];
    if (lines[0]?.trim() === '---') {
        let end = 1;
        while (end < lines.length && lines[end]?.trim() !== '---') {
            const line = lines[end].trim();
            if (line.startsWith('description:')) description = line.slice('description:'.length).trim();
            else if (line.startsWith('-')) builtinTools.push(line.replace(/^-\s*/, '').trim());
            end++;
        }
        lines.splice(0, end + (lines[end]?.trim() === '---' ? 1 : 0));
    }
    return { name, description, instructions: lines.join('\n').trim(), tools: [], builtinTools };
}

/** Optional tools.ts inside a skill directory: exports tools: Tool[] as the skill's bundled tools. */
async function loadSkillTools(dir: string): Promise<Tool[]> {
    const file = pathToFileURL(join(dir, 'tools.ts')).href;
    try {
        const mod = await import(file);
        return (Array.isArray(mod.tools) && mod.tools) ?? [];
    } catch {
        return [];
    }
}

/** Scan the skills/ directory, one skill per subdirectory; skills that fail to parse or load are skipped. */
export async function loadSkills(): Promise<Skill[]> {
    skills = [];
    let entries;
    try {
        entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return skills;
        throw err;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(SKILLS_DIR, entry.name);
        const name = entry.name;
        try {
            const raw = await readFile(join(dir, 'SKILL.md'), 'utf8');
            const skill = parseSkill(dir, name, raw);
            skill.tools = await loadSkillTools(dir);
            skills.push(skill);
        } catch (err) {
            console.error(`Failed to load skill ${name}: ${(err as Error).message}`);
        }
    }
    return skills;
}

export function listSkills(): readonly Skill[] {
    return skills;
}

export function activeSkill(): Skill | null {
    return active;
}

/** Remove the current skill's bundled tools and restore default tool visibility; clears active. */
function deactivateSkill(): void {
    if (!active) return;
    for (const tool of active.tools) unregisterTool(tool.name);
    active = null;
    setVisibleTools(null);
}

/**
 * Activate a skill: unload the previous one first, register this skill's bundled tools, and narrow
 * the model's visible tools to the SKILL.md whitelist (empty whitelist = all built-in + bundled tools).
 */
export function useSkill(name: string): void {
    const skill = skills.find((s) => s.name === name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    deactivateSkill();
    for (const tool of skill.tools) {
        ensureToolPolicy(tool.name, 'ask'); // skill tools default to ask; users can change to allow in the config
        registerTool(tool);
    }
    setVisibleTools(skill.builtinTools.length > 0 ? [...skill.builtinTools, ...skill.tools.map((t) => t.name)] : null);
    active = skill;
}

export function unuseSkill(): void {
    deactivateSkill();
}
```

Read the code in four steps:

1. `loadSkills` scans the subdirectories under `skills/`;
2. `parseSkill` reads the description, tool list, and body from `SKILL.md`;
3. `useSkill` registers the bundled tools and sets the tools visible to the model;
4. `unuseSkill` removes the bundled tools and restores the default state.

### 4.3 Two Built-in Skills

The repo ships with two skills. `code-review` shows how to carry your own tools:

Path `day11/skills/code-review/SKILL.md`:

```md
<!-- day11/skills/code-review/SKILL.md -->
---
description: Review code changes from a senior engineer's perspective: read the diff first, then comment item by item
tools:
- read
- glob
---
You are a senior code review expert. Review process:
1. First use git_diff to get the current uncommitted changes (a bundled skill tool, callable directly), reading the diff file by file; when you need context, use read / glob to look at the files, and never guess.
2. Report findings by severity: blocking issues (bugs/security/performance) → suggestions (readability/edge cases) → optional (style). Give a file:line and a concrete fix for each item.
3. Review only, never modify files yourself; end with a one-sentence overall verdict.
```

Its bundled tool lives in `day11/skills/code-review/tools.ts`, 27 lines in full — just a standard registry tool:

```ts
// day11/skills/code-review/tools.ts
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '../../tools.js';

const execAsync = promisify(exec);

/** Bundled tool of the code-review skill: gets the current uncommitted changes so the review can read the diff piece by piece. */
export const tools: Tool[] = [
    {
        name: 'git_diff',
        description: 'Get the current uncommitted code changes (git diff HEAD); outputs a file-level summary plus the line-by-line diff. Always use this to see the changes first when reviewing code.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => {
            try {
                const { stdout } = await execAsync('git diff HEAD', { timeout: 10_000, maxBuffer: 1024 * 1024 });
                if (!stdout.trim()) return '(no uncommitted changes)';
                const lines = stdout.trim().split('\n');
                const files = lines.filter((l) => l.startsWith('diff --git')).map((l) => l.replace('diff --git a/', '').replace(/ b\/.+$/, ''));
                const head = `${files.length} file(s) changed: ${files.join(', ')}\n`;
                const diff = stdout.length > 4000 ? `${stdout.slice(0, 4000)}\n...(diff truncated for length, originally ${stdout.length} chars)` : stdout;
                return head + diff;
            } catch (err) {
                return `git diff failed: ${(err as NodeJS.ErrnoException).message}`;
            }
        },
    },
];
```

Skill tools are uniformly exported as `tools: Tool[]`. `skills.ts` loads this array, then registers the tools into the tool table from Day 4.

`explore` has no bundled tools; it just keeps three from the built-in list:

Path `day11/skills/explore/SKILL.md`:

```md
<!-- day11/skills/explore/SKILL.md -->
---
description: Read-only helper: browse code and directories only, never modify files or run commands
tools:
- ls
- glob
- read
---
You are a read-only code browsing assistant. Before touching any code, first use ls to see the directory layout, glob to find files, then read to inspect contents.

Hard boundaries:
- Use only the three tools ls / glob / read;
- Never call run_shell, write, or patch, and never modify any file;
- Answer with concrete relative file paths so the user can open and verify them.
```

Once loaded, the tool list the model receives contains only `ls`, `glob`, and `read`, so it has no way to call the tools that modify files or run commands.

### 4.4 tools.ts: Controlling Tool Visibility

The tool registry gains two operations: removing a skill's tools, and setting the visible list.

```ts
// day11/tools.ts
/** Remove a skill's bundled tools on unload so the registry returns to its pre-load state. */
export function unregisterTool(name: string): void {
    const index = registry.findIndex((t) => t.name === name);
    if (index >= 0) registry.splice(index, 1);
}

/** The currently visible tool list; null means everything is visible (when no skill is active). */
let visibleTools: string[] | null = null;

/** When a skill activates, narrow visible tools to the set it declares; pass null on unload to restore all tools. */
export function setVisibleTools(names: string[] | null): void {
    visibleTools = names;
}
```

`toOpenAITools` filters tools by the list:

```ts
// day11/tools.ts
export function toOpenAITools(): ChatCompletionTool[] {
    return registry
        .filter((tool) => !visibleTools || visibleTools.includes(tool.name))
        .map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
}
```

When `visibleTools` is `null`, every tool is returned; otherwise only the ones on the list.

### 4.5 permissions.ts: Filling In Tool Policies

A skill's tools aren't in the default config table, so `ensureToolPolicy` adds `ask` at load time:

```ts
// day11/permissions.ts
/** A skill's bundled tools are absent from the default config; add a default policy (ask) on load so they aren't hard-blocked by deny. */
export function ensureToolPolicy(tool: string, policy: Policy): void {
    if (config.tools[tool] === undefined) config.tools[tool] = policy;
}
```

So `git_diff` asks before its first run. You can also set it to `allow` in `.geekagent/GeekAgent.json`.

### 4.6 chat.ts: Adding Skill Instructions

`Chat` stores the current skill's instructions and appends them when assembling the system prompt:

```ts
// day11/chat.ts
  private skillInstructions = '';

  /** Day 11: attach the current skill's instructions, spliced into the system prompt of every request; an empty string means no skill. */
  setSkillInstructions(text: string): void {
    this.skillInstructions = text;
  }

  /** Assemble the system prompt: task cornerstone + project instructions + skill instructions. */
  private systemPrompt(): string {
    const skill = this.skillInstructions.trim();
    return (
      `${AGENT_SYSTEM}\n\nProject instructions (AGENTS.md):\n${this.instructions || 'none'}` +
      (skill ? `\n\nSkill instructions:\n${skill}` : '')
    );
  }
```

The final system prompt contains, in order, the base instructions, the project instructions, and the current skill's instructions.

### 4.7 index.ts: Wiring Up Commands and the Panel

At startup, scan the skill directory first:

```ts
// day11/index.ts
const skills = await loadSkills();
```

The panel shows the current skill, and `describeActiveSkill` lists the tools it brings and keeps:

```ts
// day11/index.ts
        `Skill  ${activeSkill()?.name ?? 'none'}`,   // one row inside buildPanel

/** Describe what tools the current skill carries: bundled tools plus the built-in whitelist, all shown. */
function describeActiveSkill(): string {
    const skill = activeSkill();
    if (!skill) return 'none';
    const parts: string[] = [];
    if (skill.tools.length) parts.push(`bundled: ${skill.tools.map((t) => t.name).join(', ')}`);
    if (skill.builtinTools.length) parts.push(`built-in: ${skill.builtinTools.join(', ')}`);
    return parts.length ? `${skill.name} (${parts.join('; ')})` : skill.name;
}
```

Three commands handle viewing, loading, and unloading. Loading hands the skill's instructions to `Chat`; unloading clears them:

```ts
// day11/index.ts
        case '/skills': {
            const lines = listSkills().filter((s) => s.name).map((s) => `${activeSkill()?.name === s.name ? '*' : ' '} ${s.name} — ${s.description}`);
            tui.append(lines.length > 0 ? `Available skills (from the skills/ directory, load with /use):\n${lines.join('\n')}` : '(no skills in the skills/ directory yet)', 'sys');
            break;
        }
        case '/use':
            if (!id) {
                tui.append('Usage: /use <skill name> (see /skills for available skills)', 'sys');
                break;
            }
            try {
                useSkill(id);
                chat.setSkillInstructions(activeSkill()?.instructions ?? '');
                tui.append(`Loaded skill ${describeActiveSkill()}`, 'tool');
            } catch (e) {
                tui.append(`Failed to load: ${(e as Error).message}`, 'sys');
            }
            break;
        case '/unuse':
            unuseSkill();
            chat.setSkillInstructions('');
            tui.append('(Skill unloaded, default behavior restored)', 'tool');
            break;
```

Finally, update the startup banner:

```ts
// day11/index.ts
tui.append('GeekAgent Day 11 — Skills', 'sys');
const skillNames = skills.map((s) => s.name).join(', ') || '(none yet)';
tui.append(`Find ${skillNames} under day11/skills/. Curious what a skill looks like? /skills lists them, /use <name> loads one, /unuse unloads.`, 'sys');
```

The full flow is: scan the directory at startup → `/use` loads instructions and tools → the model does its task → `/unuse` restores the default state.

## 5. Verification

```bash
npm run typecheck
npm run dev -- day11/index.ts
```

1. Type `/skills` and confirm you see `code-review` and `explore`;
2. Type `/use code-review`, have the model review the uncommitted changes, and confirm it can call `git_diff`;
3. Type `/use explore`, ask the model to run a shell command, and confirm it can only use the three read-only tools;
4. Type `/unuse` and confirm the panel goes back to "Skill none".

## 6. What We Didn't Do

- Only one skill can be loaded at a time;
- The active skill isn't saved with the session;
- Skills have no permission config of their own.

## 7. Next Step

Now the Agent can switch instructions and tools depending on the task. Next we add content-based code search and web reading, so the model can find the information it needs faster.
