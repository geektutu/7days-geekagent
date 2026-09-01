---
title: 从零实现 GeekAgent —— Day10 项目指令与长期记忆
description: >-
  7天从零实现Agent教程，用 TypeScript 动手写一个最简单的 Agent/Harness。Day 10 补上两种跨会话信息：AGENTS.md 保存项目规则，memory 保存运行中积累的经验，让新建会话后的模型既知道项目规则，也想得起以前确认过的偏好。
date: '2026-08-29 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 10：既懂项目规则，也记得用户偏好——项目指令与长期记忆

> GeekAgent 已经能保存会话，但新建会话后，模型不知道项目规则，也想不起以前确认过的偏好。今天补上两种跨会话信息：`AGENTS.md` 保存项目规则，memory 保存运行中积累的经验。

## 0. 两种“记住”不是一回事

假设我们希望 Agent 写博客时使用第一人称。这句话既可以写进 `AGENTS.md`，也可以在聊天时告诉 Agent「请记住」。看起来都是让模型记住一句话，实际用途不同。

`AGENTS.md` 像项目说明书，由我们写好，和代码一起提交。模型每次回答前都要读它。

memory 更像 Agent 的便签。模型在工作时把用户偏好、项目事实和重要决定记下来，以后需要时再搜索。它属于本地运行数据，不进入版本库。

| 对比项 | `AGENTS.md` | memory |
|---|---|---|
| 谁来写 | 我们手工编写 | 模型调用 `memory_write` 写入 |
| 保存什么 | 项目规则、编码约定、工作流程 | 用户偏好、项目事实、重要决定 |
| 是否进入版本库 | 是 | 否，`.geekagent/` 已被忽略 |
| 何时更新 | 修改文件后，下次启动生效 | 运行时动态更新，写完即可搜索 |
| 模型怎么读取 | 每次请求完整带上 | 调用 `memory_search` 按需读取 |
| 上下文占用 | 文件多长，就带上多少 | 最多返回 10 条搜索结果 |
| 跨会话 | 是 | 是 |

如果把全部 memory 也放进每次请求，它就和 `AGENTS.md` 没有多少区别。今天让项目规则始终可见，让长期记忆只在需要时出现。

## 1. 目标

今天的验收标准：

1. 启动时读取工作根目录的 `AGENTS.md`，每轮请求都把完整项目规则放在 history 前面的 system prompt 中；
2. 模型能用 `memory_write` 保存用户偏好、项目事实和重要决定，需要回忆时再用 `memory_search` 按关键词取回，而不是每轮携带全部记忆；
3. 长期记忆写入 `.geekagent/memory.json`，切换会话或重启后仍然存在，`/memory` 可以查看当前条目。

**当天代码行数**：Day 10 源码相对 Day 9 新增 128 行、删除 13 行，净增 115 行，控制在 500 行以内。

## 2. AGENTS.md：项目写给 Agent 的说明书

### 2.1 先看效果

项目根 `AGENTS.md` 写着“全文少用你，多用我/我们”。这条规则每轮都会带给模型，所以第一次对话就能使用：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › 写一句开场白，不用阅读项目内容</span>
<span style="color:#00cd00">我们常说 Agent 很复杂，但我想试试，用最笨的办法、最少的代码，把它从零搭出来。</span>
</pre>

### 2.2 读取哪一份文件

Day 8 已经在 `.geekagent/GeekAgent.json` 中配置了工作根目录。我们直接读取这个目录下的 `AGENTS.md`，不再增加新的路径配置。

启动时读取一次文件，之后每次请求都把完整内容放在聊天记录前面。文件不存在就使用空字符串。项目指令不属于某一段会话，所以保存会话时不会重复保存。

### 2.3 instructions.ts：读取完整项目指令

项目指令读取只有 13 行，完整代码如下：

```ts
// day10/instructions.ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** 读取项目根目录的 AGENTS.md；没有项目指令时返回空文本。 */
export async function loadInstructions(root: string): Promise<string> {
    try {
        return (await readFile(resolve(root, 'AGENTS.md'), 'utf8')).trim();
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw err;
    }
}
```

我们只读工作根目录这一份文件：有就返回全文，没有就返回空字符串。

### 2.4 chat.ts：每轮都带给模型

`Chat` 在构造时接收 `AGENTS.md` 的内容。每轮请求把它放在当前会话历史前面：

```ts
// day10/chat.ts
        const stream = await this.client.chat.completions.create({
          model: this.model,
          messages: [{ role: 'system', content: `${AGENT_SYSTEM}\n\n项目指令（AGENTS.md）：\n${this.instructions || '暂无'}` }, ...this.history],
          tools: toOpenAITools(),
          tool_choice: forceTodo
              ? { type: 'function', function: { name: 'todo_write' } }
              : 'auto',
          stream: true,
          stream_options: { include_usage: true }, // Day 7：请求末尾的 chunk 里带上本次用量
        });
```

这里没有 memory。项目指令直接出现，长期记忆要搜索后才会出现。

## 3. memory：Agent 随手记下的便签

### 3.1 先看效果

先让 Agent 记住一条偏好，然后切到新会话：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › 请记住：用户希望回答先给结论</span>
<span style="color:#cdcd00">[调用工具 memory_write → 已记住：用户希望回答先给结论]</span>
<span style="color:#00cd00">记住了。</span>
<span style="color:#00cdcd">You › /new review</span>
<span style="color:#808080">（已新建并切换到会话 review）</span>
<span style="color:#00cdcd">You › 回忆一下用户对回答方式有什么偏好</span>
<span style="color:#cdcd00">[调用工具 memory_search → 找到 1 条记忆：</span>
<span style="color:#cdcd00">1. 用户希望回答先给结论]</span>
<span style="color:#00cd00">用户希望回答先给结论。</span>
</pre>

新会话里没有原来的聊天记录，memory 也没有提前交给模型。模型先搜索，再根据结果回答。

### 3.2 记忆写进本地 JSON

长期记忆使用最直接的字符串数组：

```json
[
  "博客正文使用第一人称‘我/我们’",
  "用户希望回答先给结论"
]
```

文件放在 `.geekagent/memory.json`。`.gitignore` 已经忽略这个目录，所以本地记忆不会混进代码提交。

`memory_write` 每次写一条完整事实。模型决定记什么，程序只负责去重和写盘。

### 3.3 主流方案是 embedding，今天先用关键词

现在主流的记忆搜索会使用 embedding：先用模型把文字转换成一串数字，再比较两串数字有多接近。这样搜索「回复风格」，也可能找到「用户希望回答先给结论」。

| | 关键词搜索 | embedding 搜索 |
|---|---|---|
| 匹配依据 | 是否出现相同词语 | 向量之间的语义距离 |
| 擅长 | 名称、代码、原句 | 同义表达、换一种说法 |
| 额外组件 | 无 | embedding 模型；规模大时还需向量数据库 |
| 当前选择 | 采用，几十行即可跑通 | 暂不采用 |

```text
写入：记忆文本 ──embedding──> 向量，随记忆一起保存
搜索：用户问题 ──embedding──> 查询向量
                              │
                              └─ 与记忆向量计算相似度 ──> topN
```

只有几百条记忆时，向量可以存在 JSON 中，再在内存里逐条比较，不需要向量数据库。记忆更多时，才需要数据库加快查找。记忆的 embedding 在写入时算一次并保存，搜索时只计算问题的 embedding。

不过，embedding 需要额外的模型和配置，当前使用的服务也不一定支持。今天先用关键词代替：模型给出几个关键词，程序统计每条记忆命中了几个，按命中数排序，最多返回 10 条。

```text
query: "博客 人称"

记忆 A：博客正文使用第一人称“我/我们”   命中 2 个词
记忆 B：用户希望回答先给结论             命中 0 个词
记忆 C：博客示例使用真实终端输出           命中 1 个词

返回顺序：A → C
```

关键词没对上时可能漏掉相关记忆，这是今天接受的边界。以后换成 embedding，两个工具和外层工具循环仍然可以保留。

### 3.4 memory.ts：写入与搜索

`memory.ts` 共 78 行：启动时读取文件，注册写入和搜索两个工具，再给界面提供记忆列表。完整代码如下：

```ts
// day10/memory.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { registerTool, type Tool } from './tools.js';

const MEMORY_FILE = resolve('.geekagent/memory.json');
let items: string[] = [];

/** 启动时从磁盘恢复长期记忆；文件不存在等同于还没有记忆。 */
export async function loadMemory(): Promise<void> {
    try {
        const value = JSON.parse(await readFile(MEMORY_FILE, 'utf8')) as unknown;
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
            throw new Error('memory.json 必须是字符串数组');
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

/** 注册写记忆工具；模型判断某条信息值得跨会话保留时主动调用。 */
export function setupMemory(changed: () => void): void {
    const tools: Tool[] = [
        {
            name: 'memory_write',
            description: '把值得跨会话保留的用户偏好、项目事实或重要决定写入长期记忆。不要记录临时任务进度或可随时从文件读到的内容。',
            parameters: {
                type: 'object',
                properties: { content: { type: 'string', description: '一条独立、简洁、脱离当前对话也能理解的事实' } },
                required: ['content'],
                additionalProperties: false,
            },
            run: async (args) => {
                const content = String(args.content ?? '').trim();
                if (!content) return '缺少参数 content';
                if (items.includes(content)) return '这条记忆已经存在';
                const next = [...items, content];
                await mkdir(dirname(MEMORY_FILE), { recursive: true });
                await writeFile(MEMORY_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
                items = next;
                changed();
                return `已记住：${content}`;
            },
        },
        {
            name: 'memory_search',
            description: '按关键词搜索长期记忆。需要回忆用户偏好、项目事实或以前的决定时调用；query 使用一个或多个空格分隔的关键词。',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: '搜索关键词，多个词用空格分隔，如“博客 人称”' } },
                required: ['query'],
                additionalProperties: false,
            },
            run: (args) => {
                const keywords = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
                if (keywords.length === 0) return '缺少参数 query';
                const matches = items
                    .map((content) => ({ content, score: keywords.filter((word) => content.toLowerCase().includes(word)).length }))
                    .filter((item) => item.score > 0)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 10);
                return matches.length > 0
                    ? `找到 ${matches.length} 条记忆：\n${matches.map((item, i) => `${i + 1}. ${item.content}`).join('\n')}`
                    : '没有找到相关记忆';
            },
        },
    ];
    tools.forEach(registerTool);
}

export function listMemories(): readonly string[] {
    return items;
}
```

搜索只做三步：拆关键词、数命中、取前 10 条。

内置指令告诉模型何时写、何时搜：

```ts
// day10/chat.ts
const AGENT_SYSTEM = `你是一个本地编码 Agent。遇到需要多个步骤的任务时，先调用 todo_write 制定简短计划，再逐项执行并更新状态；用户明确要求 TODO 或任务清单时，必须先调用 todo_write。简单任务直接完成，不要为了形式创建 TODO。可把边界清楚的分析、设计或审查任务交给 delegate_task，多个子任务必须串行委派。用户偏好、项目事实或重要决定值得跨会话保留时，调用 memory_write；需要回忆这些信息时调用 memory_search，不要假设记忆内容。不要记录临时任务进度或可随时从文件读到的内容。`;
```

调用 `memory_search` 后，搜索结果和其他工具结果一样进入当前会话。

## 4. 启动时加载两种信息

入口先加载权限，确定项目根目录；然后读取 memory 和 `AGENTS.md`：

```ts
// day10/index.ts
const config = loadConfig();
let permissions;
try {
    permissions = await loadPermissions();
} catch (e) {
    console.error(`.geekagent/GeekAgent.json 读取失败：${(e as Error).message}`);
    process.exit(1);
}
let instructions = '';
try {
    await loadMemory();
    instructions = await loadInstructions(permissions.root);
} catch (e) {
    console.error(`项目上下文读取失败：${(e as Error).message}`);
    process.exit(1);
}
const chat = new Chat(config.baseURL, config.apiKey, config.model, instructions);
const sessions = new Sessions();
```

两个 memory 工具也要加入权限表：

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

右栏显示“指令 已加载/无”和“记忆 N 条”。`/memory` 供我们查看本地记忆，不会把全部内容送给模型。

## 5. 验证

```bash
npm run typecheck
npm run dev -- day10/index.ts
```

1. 确认右栏显示“指令 已加载”，让 Agent 复述一条根 `AGENTS.md` 中的规则
2. 输入“请记住：用户希望回答先给结论”，确认出现 `memory_write` 结果
3. 输入 `/new review`，再问“回忆用户对回答方式的偏好”，确认先出现 `memory_search`，再给出答案
4. 输入 `/memory` 并重启 Day 10，确认本地记忆仍然存在
5. 检查 `git status`，确认 `.geekagent/memory.json` 没有进入版本库

## 6. 没做什么

- `AGENTS.md` 只读取项目根的一份，不合并多级指令
- memory 只能追加，不能编辑或删除
- 搜索只匹配关键词，不理解语义

## 7. 下一步

现在，项目规则会始终生效，运行中积累的经验也能按需找回。下一步把相关指令和工具组成可选择的能力包，需要时再加载。
