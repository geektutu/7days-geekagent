---
title: 从零实现 GeekAgent —— Day11 技能系统（Skills）
description: >-
  7天从零实现Agent教程，用 TypeScript 动手写一个最简单的 Agent/Harness。Day 11 把任务指令和工具打包成技能，支持按需加载、卸载，并控制模型当前能看到哪些工具。
date: '2026-08-30 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 11：按任务切换指令和工具——技能系统（Skills）

> Day 10 已经能加载项目指令。今天把一段任务指令和一组工具放在同一个目录里，做成可以随时加载和卸载的技能。

## 0. skills 是加强版的 prompt 吗？

刚听到「技能」这个词，我们很容易产生一个疑问：这不就是一段更长的 prompt 吗？项目里已经有 `AGENTS.md`，为什么还要再做 skills？

两者都能给模型指令，但解决的问题不同：

| | `AGENTS.md` | skills |
|---|---|---|
| 作用范围 | 整个项目 | 当前任务 |
| 生效时间 | 每轮请求都加载 | 用 `/use` 加载，`/unuse` 卸载 |
| 包含内容 | 项目指令 | 任务指令和工具 |
| 工具控制 | 不改变工具列表 | 可以增加或筛选工具 |

例如，在 `AGENTS.md` 中写“只读代码，不要修改”，模型仍然能看到 `write` 和 `patch`。这是一条行为要求。

如果加载 `explore` 技能，程序只把 `ls`、`glob` 和 `read` 发给模型。此时模型看不到修改工具。另一边，`code-review` 技能还能带上原本不存在的 `git_diff`。

所以，`AGENTS.md` 负责项目长期规则，skills 负责当前任务的指令和能力。理解这个区别后，我们再看为什么需要技能。

## 1. 为什么：不同任务需要不同的工具

具体任务会有不同的做法。代码审查需要先看 diff，只读浏览只需要查看目录和文件。如果把这些要求都写进 `AGENTS.md`，项目指令会越来越长，模型每轮都要读取与当前任务无关的内容。

更合适的做法是按任务拆开：加载代码审查技能时增加 `git_diff`，加载只读技能时只向模型提供三个只读工具。

因此，一个技能解决两件事：告诉模型怎么完成当前任务，并决定模型完成任务时能用哪些工具。

## 2. 目标

1. `skills/` 下每个子目录代表一个技能，`SKILL.md` 保存描述、内置工具名单和任务指令，可选的 `tools.ts` 导出技能自带工具；
2. `/use code-review` 后，技能指令进入 system prompt，`git_diff` 加入工具清单；切到 `explore` 后，模型只看到 `ls` / `glob` / `read`；
3. `/skills` 能查看可用技能和当前状态，`/unuse` 会移除技能工具、清空技能指令并恢复默认工具清单。

**当天代码行数**：相对 Day 10，源码新增 254 行、删除 15 行，净增 239 行。

## 3. 设计：技能的目录、工具与状态

### 3.1 一个技能就是一个目录

每个子目录代表一个技能：

```
day11/skills/
├── code-review/
│   ├── SKILL.md        # 描述 + 工具白名单 + 系统提示
│   └── tools.ts        # 该技能自带的工具（可选）
└── explore/
    └── SKILL.md        # 纯指令技能，不带自带工具
```

`SKILL.md` 分成两部分：上半部分记录描述和内置工具名单，下半部分写给模型的任务指令：

```md
<!-- day11/skills/example/SKILL.md -->
---
description: 以资深工程师视角审查代码改动
tools:
- read
- glob
---
你是一名资深代码审查专家。……
```

`description` 显示在 `/skills` 列表中，`tools` 表示加载技能后仍可使用的内置工具。

成熟的技能系统通常还会采用**渐进式加载**：先让模型看到技能名称和简介，选中后再加载完整指令，需要时继续读取脚本、模板或参考资料。这样技能很多时，也不会一次占满上下文。

这一版先实现最小流程：启动时扫描本地目录，由用户用 `/use` 选择技能，加载一份 `SKILL.md` 和可选的 `tools.ts`。

| | 常见技能系统 | 当前 demo |
|---|---|---|
| 选择方式 | 模型按描述自动选择 | 用户执行 `/use` |
| 加载方式 | 按需逐层加载 | 一次加载指令和工具 |
| 可带内容 | 指令、工具、脚本、参考资料 | 指令和工具 |
| 适用规模 | 大量技能长期扩展 | 少量本地技能，先讲清原理 |

两者的核心相同：把某类任务需要的上下文和能力放在一起。demo 省略自动选择与多层资源，先把加载、限制工具和卸载跑通。

### 3.2 工具有两个来源

技能可以同时使用两类工具：

- `tools.ts` 导出技能自带的工具，例如 `code-review` 的 `git_diff`；
- `SKILL.md` 的 `tools` 从内置工具中挑选当前可见的工具。

`setVisibleTools` 保存当前名单，`toOpenAITools()` 在把工具发送给模型前进行过滤。没有加载技能时，所有内置工具照常可见。

### 3.3 同一时间只加载一个技能

为了避免两份指令和工具名单互相冲突，同一时间只保留一个技能：

- `useSkill` 先卸载旧技能，再注册新工具、设置可见名单；
- `unuseSkill` 移除技能工具，恢复全部内置工具。

技能自带工具也经过 Day 8 的权限层，默认使用 `ask`。

## 4. 实现：先效果，后实现

### 4.1 先看效果

启动后在 TUI 里看到的流程（颜色用 HTML 还原）：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 11 —— 技能系统</span>
<span style="color:#808080">可在 day11/skills/ 下看到code-review、explore。想看技能长什么样，/skills 列出来、/use <名字> 加载、/unuse 卸载。</span>
<span style="color:#00cdcd">You › /skills</span>
<span style="color:#808080">可用技能（skills/ 目录，/use 加载）：</span>
<span style="color:#808080">  code-review — 以资深工程师视角审查代码改动，先看改动再逐条给意见</span>
<span style="color:#808080">  explore — 只读助手：只浏览代码与目录，不改动任何文件、不执行命令</span>
<span style="color:#00cdcd">You › /use code-review</span>
<span style="color:#cdcd00">已加载技能 code-review（自带工具：git_diff；内置工具：read、glob）</span>
<span style="color:#00cdcd">You › 我今天的改动还没提交，帮我看看哪里最值得改</span>
<span style="color:#cdcd00">工具 git_diff 请求执行 [y/N] → y</span>
<span style="color:#cdcd00">[调用工具 git_diff → 改动了 1 个文件：day11/skills.ts</span>
<span style="color:#cdcd00">diff --git a/day11/skills.ts b/day11/skills.ts</span>
<span style="color:#cdcd00">new file mode 100644</span>
<span style="color:#cdcd00">+import { readdir, readFile } from 'node:fs/promises';</span>
<span style="color:#cdcd00">…]</span>
<span style="color:#00cd00">这次改动把技能加载集中在 skills.ts。建议重点检查 useSkill：它先卸载旧技能，再注册新工具并设置可见名单，顺序清楚。当前没有发现阻断性问题。</span>
<span style="color:#00cdcd">You › /use explore</span>
<span style="color:#cdcd00">已加载技能 explore（内置工具：ls、glob、read）</span>
<span style="color:#00cdcd">You › 这个项目有多少行代码？跑几条命令统计下</span>
<span style="color:#00cd00">我当前只带 ls / glob / read 三个只读工具，没法执行 shell 命令；但可以用 glob 先把代码文件都找出来，再用 read 读几个大文件，给个估算。</span>
<span style="color:#00cdcd">You › /unuse</span>
<span style="color:#cdcd00">（已卸载技能，恢复默认行为）</span>
</pre>

`code-review` 加载后，模型多了 `git_diff`。切换到 `explore` 后，模型只能看到 `ls`、`glob` 和 `read`。这正是技能对工具清单的两种操作：增加和筛选。

### 4.2 skills.ts：加载与卸载技能

技能系统的主体是 `day11/skills.ts`，完整代码如下：

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
    /** 技能自带工具：加载时注册、卸载时移除，只在技能生效期间可调用。 */
    tools: Tool[];
    /** SKILL.md 头部声明的内置工具白名单；空数组 = 不收敛工具。 */
    builtinTools: string[];
}

let skills: Skill[] = [];
let active: Skill | null = null;

/** 解析 SKILL.md：头部 `---` 块里放 description / tools，两条 `---` 之间是指令正文。 */
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

/** 技能目录里可选 tools.ts：导出 tools: Tool[]，作为该技能的自带工具。 */
async function loadSkillTools(dir: string): Promise<Tool[]> {
    const file = pathToFileURL(join(dir, 'tools.ts')).href;
    try {
        const mod = await import(file);
        return (Array.isArray(mod.tools) && mod.tools) ?? [];
    } catch {
        return [];
    }
}

/** 扫描 skills/ 目录，每个子目录一个技能；解析 / 加载失败的技能直接跳过。 */
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
            console.error(`技能 ${name} 加载失败：${(err as Error).message}`);
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

/** 卸载当前技能自带工具并恢复默认工具可见性；active 置空。 */
function deactivateSkill(): void {
    if (!active) return;
    for (const tool of active.tools) unregisterTool(tool.name);
    active = null;
    setVisibleTools(null);
}

/**
 * 激活技能：先卸掉上一个技能，再注册本技能自带工具，并按 SKILL.md 的白名单
 * 收敛模型可见工具（空名单 = 全部内置工具 + 技能自带工具）。
 */
export function useSkill(name: string): void {
    const skill = skills.find((s) => s.name === name);
    if (!skill) throw new Error(`未知技能：${name}`);
    deactivateSkill();
    for (const tool of skill.tools) {
        ensureToolPolicy(tool.name, 'ask'); // 技能工具默认 ask，用户可自行在配置里改 allow
        registerTool(tool);
    }
    setVisibleTools(skill.builtinTools.length > 0 ? [...skill.builtinTools, ...skill.tools.map((t) => t.name)] : null);
    active = skill;
}

export function unuseSkill(): void {
    deactivateSkill();
}
```

代码可以按四步阅读：

1. `loadSkills` 扫描 `skills/` 下的子目录；
2. `parseSkill` 读取 `SKILL.md` 的描述、工具名单和正文；
3. `useSkill` 注册自带工具，并设置模型可见的工具；
4. `unuseSkill` 移除自带工具，恢复默认状态。

### 4.3 两个内置技能

仓库内置两个技能。`code-review` 展示如何携带自己的工具：

路径 `day11/skills/code-review/SKILL.md`：

```md
<!-- day11/skills/code-review/SKILL.md -->
---
description: 以资深工程师视角审查代码改动，先看改动再逐条给意见
tools:
- read
- glob
---
你是资深代码审查专家。审查流程：
1. 先用 git_diff 拿到当前未提交的改动（技能自带工具，可直接调用），逐文件读 diff，需要上下文时用 read / glob 补看文件，不要凭空猜测。
2. 按严重程度输出意见：阻断性问题（bug/安全/性能）→ 建议（可读性/边界）→ 可选（风格）。每条给文件:行号和修改建议。
3. 只审查、不动手修改文件；最后给一句总体结论。
```

它的自带工具在 `day11/skills/code-review/tools.ts`，完整 27 行，就是一个标准的注册表工具：

```ts
// day11/skills/code-review/tools.ts
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '../../tools.js';

const execAsync = promisify(exec);

/** code-review 技能自带工具：拿到当前未提交的改动，供审查时逐 diff 阅读。 */
export const tools: Tool[] = [
    {
        name: 'git_diff',
        description: '获取当前未提交的代码改动（git diff HEAD），输出文件级摘要与逐行 diff。审查代码时必须先用它看改动。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => {
            try {
                const { stdout } = await execAsync('git diff HEAD', { timeout: 10_000, maxBuffer: 1024 * 1024 });
                if (!stdout.trim()) return '（当前没有未提交的改动）';
                const lines = stdout.trim().split('\n');
                const files = lines.filter((l) => l.startsWith('diff --git')).map((l) => l.replace('diff --git a/', '').replace(/ b\/.+$/, ''));
                const head = `改动了 ${files.length} 个文件：${files.join('、')}\n`;
                const diff = stdout.length > 4000 ? `${stdout.slice(0, 4000)}\n...(diff 过长已截断，原 ${stdout.length} 字符)` : stdout;
                return head + diff;
            } catch (err) {
                return `git diff 失败：${(err as NodeJS.ErrnoException).message}`;
            }
        },
    },
];
```

技能工具统一导出为 `tools: Tool[]`。`skills.ts` 加载这个数组，再把工具注册到 Day 4 的工具表中。

`explore` 没有自带工具，只从内置工具中保留三项：

路径 `day11/skills/explore/SKILL.md`：

```md
<!-- day11/skills/explore/SKILL.md -->
---
description: 只读助手：只浏览代码与目录，不改动任何文件、不执行命令
tools:
- ls
- glob
- read
---
你是只读代码浏览助手。访问任何代码前，先用 ls 看目录结构、glob 找文件，再用 read 读内容。

硬性界限：
- 只用 ls / glob / read 三个工具；
- 绝不调用 run_shell、write、patch，也不修改任何文件；
- 回答要给出具体文件相对路径，方便用户自己打开确认。
```

加载后，模型收到的工具列表中只有 `ls`、`glob` 和 `read`，因此无法调用修改文件或执行命令的工具。

### 4.4 tools.ts：控制工具是否可见

工具注册表新增两个操作：删除技能工具，以及设置可见名单。

```ts
// day11/tools.ts
/** 技能卸载时移除它自带的工具，让注册表回到加载前的样子。 */
export function unregisterTool(name: string): void {
    const index = registry.findIndex((t) => t.name === name);
    if (index >= 0) registry.splice(index, 1);
}

/** 当前可见工具的名单；null 表示全部可见（没有技能激活时）。 */
let visibleTools: string[] | null = null;

/** 技能激活时把可见工具收敛到技能声明的集合；卸载时传 null 恢复全部工具。 */
export function setVisibleTools(names: string[] | null): void {
    visibleTools = names;
}
```

`toOpenAITools` 根据名单过滤工具：

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

`visibleTools` 为 `null` 时返回全部工具，否则只返回名单中的工具。

### 4.5 permissions.ts：补充工具权限

技能工具不在默认配置表中，加载时用 `ensureToolPolicy` 补上 `ask`：

```ts
// day11/permissions.ts
/** 技能自带的工具不在默认配置里，加载时补一条默认策略（默认 ask），避免被一律 deny 卡死。 */
export function ensureToolPolicy(tool: string, policy: Policy): void {
    if (config.tools[tool] === undefined) config.tools[tool] = policy;
}
```

因此，`git_diff` 第一次执行前会询问。也可以在 `.geekagent/GeekAgent.json` 中把它设为 `allow`。

### 4.6 chat.ts：加入技能指令

`Chat` 保存当前技能指令，并在组装 system prompt 时追加进去：

```ts
// day11/chat.ts
  private skillInstructions = '';

  /** Day 11：挂上当前技能的指令，拼接进每次请求的 system prompt；传空串表示无技能。 */
  setSkillInstructions(text: string): void {
    this.skillInstructions = text;
  }

  /** 组装 system prompt：任务基石 + 项目指令 + 技能指令。 */
  private systemPrompt(): string {
    const skill = this.skillInstructions.trim();
    return (
      `${AGENT_SYSTEM}\n\n项目指令（AGENTS.md）：\n${this.instructions || '暂无'}` +
      (skill ? `\n\n技能指令：\n${skill}` : '')
    );
  }
```

最终的 system prompt 依次包含基础指令、项目指令和当前技能指令。

### 4.7 index.ts：接入命令与面板

启动时先扫描技能目录：

```ts
// day11/index.ts
const skills = await loadSkills();
```

面板显示当前技能，`describeActiveSkill` 负责列出它携带和保留的工具：

```ts
// day11/index.ts
        `技能  ${activeSkill()?.name ?? '无'}`,   // buildPanel 里的一行

/** 描述当前技能带什么工具：自带工具 + 内置工具收敛的白名单，都展示出来。 */
function describeActiveSkill(): string {
    const skill = activeSkill();
    if (!skill) return '无';
    const parts: string[] = [];
    if (skill.tools.length) parts.push(`自带工具：${skill.tools.map((t) => t.name).join('、')}`);
    if (skill.builtinTools.length) parts.push(`内置工具：${skill.builtinTools.join('、')}`);
    return parts.length ? `${skill.name}（${parts.join('；')}）` : skill.name;
}
```

三条命令负责查看、加载和卸载。加载时把技能指令交给 `Chat`，卸载时清空：

```ts
// day11/index.ts
        case '/skills': {
            const lines = listSkills().filter((s) => s.name).map((s) => `${activeSkill()?.name === s.name ? '*' : ' '} ${s.name} — ${s.description}`);
            tui.append(lines.length > 0 ? `可用技能（skills/ 目录，/use 加载）：\n${lines.join('\n')}` : '（skills/ 目录下暂无技能）', 'sys');
            break;
        }
        case '/use':
            if (!id) {
                tui.append('用法：/use <技能名>（/skills 查看可用技能）', 'sys');
                break;
            }
            try {
                useSkill(id);
                chat.setSkillInstructions(activeSkill()?.instructions ?? '');
                tui.append(`已加载技能 ${describeActiveSkill()}`, 'tool');
            } catch (e) {
                tui.append(`加载失败：${(e as Error).message}`, 'sys');
            }
            break;
        case '/unuse':
            unuseSkill();
            chat.setSkillInstructions('');
            tui.append('（已卸载技能，恢复默认行为）', 'tool');
            break;
```

最后更新启动提示：

```ts
// day11/index.ts
tui.append('GeekAgent Day 11 —— 技能系统', 'sys');
const skillNames = skills.map((s) => s.name).join('、') || '（暂无）';
tui.append(`可在 day11/skills/ 下看到${skillNames}。想看技能长什么样，/skills 列出来、/use <名字> 加载、/unuse 卸载。`, 'sys');
```

完整流程是：启动扫描目录 → `/use` 加载指令和工具 → 模型执行任务 → `/unuse` 恢复默认状态。

## 5. 验证

```bash
npm run typecheck
npm run dev -- day11/index.ts
```

1. 输入 `/skills`，确认能看到 `code-review` 和 `explore`；
2. 输入 `/use code-review`，让模型审查未提交改动，确认它能调用 `git_diff`；
3. 输入 `/use explore`，让模型执行 shell，确认它只能使用三个只读工具；
4. 输入 `/unuse`，确认面板恢复为“技能 无”。

## 6. 没做什么

- 一次只能加载一个技能；
- 当前技能不会随会话保存；
- 技能没有独立的权限配置。

## 7. 下一步

现在，Agent 能根据任务切换指令和工具。下一步补上按内容搜索代码和读取网页的能力，让模型更快找到需要的信息。
