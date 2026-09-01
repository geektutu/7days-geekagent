---
title: 从零实现 GeekAgent —— Day9 任务规划与子 Agent
description: >-
  7天从零实现Agent教程，用 TypeScript 动手写一个最简单的 Agent/Harness。Day 9 让 Agent 先列清单再动手：加一张由模型维护的 TODO 表，再提供一个隔离上下文的子 Agent。主 Agent 安排顺序，子 Agent 处理边界清楚的小任务，当前进度始终显示在右侧分栏。
date: '2026-08-28 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 9：让 Agent 先列清单再动手——任务规划与子 Agent

> 前八天的 GeekAgent 已经能读写文件、执行命令，也有了权限边界。但面对一个包含多个步骤的任务，它仍然只顾着眼前一次工具调用：做到哪里、下一步是什么，全藏在模型的上下文里。今天加一张由模型维护的 TODO 表，再提供一个隔离上下文的子 Agent。主 Agent 负责安排顺序，子 Agent 负责处理边界清楚的小任务，当前进度始终显示在右侧分栏。

## 0. 为什么 Agent 需要一张看得见的清单

「帮我检查项目并修好类型错误」背后至少有五步：读取配置、运行检查、定位原因、修改代码、再次验证。模型可以把计划写成一段话，但普通文本帮不上忙：程序不知道哪一项干完了，后面的工具调用也没有办法稳定地更新它；我们只能盯着不断滚动的消息猜进度。

还有第二个麻烦：任务里常夹着「顺路想一想」的小问题，比如先比较两种方案。这种分析一旦在主对话里展开，大段文字会挤占真正干活要用的上下文。

解法是两个新工具：`todo_write` 对付第一个麻烦——让模型把计划写成一张能打钩的清单，每推进一步就重写整张表，进度始终显示在右栏；`delegate_task` 对付第二个麻烦——把独立的小问题交给一次单独的请求去想，只把结论带回来，过程不占主对话的地方。

| | 普通文本计划 | `todo_write` 结构化清单 |
|---|---|---|
| 程序能否读取 | 只能当文本显示 | 能读取每项内容和状态 |
| 更新方式 | 模型再说一段新计划 | 重写统一的 TODO 数组 |
| 界面展示 | 混在消息流中 | 固定显示在右栏 |
| 约束 | 格式随模型变化 | 状态值和进行中数量固定 |

主流 Agent 的 planner 可能会维护依赖关系、执行图或动态重规划。这里先用线性 TODO 表表达顺序和状态，再用一个无工具的子 Agent 隔离独立分析任务。

先用一张图把 TODO 表的一生讲完——怎么出现、怎么更新、怎么收尾，今天的设计和实现都是在展开这张图：

```text
用户输入多步任务
     │
     ▼
① 规划   模型调用 todo_write，交出整张表
     │     todos.ts 校验后存入内存，并通知 TUI
     │     右栏立刻出现：
     │       [ ] 读 tsconfig
     │       [ ] 运行类型检查
     │       [ ] 逐个修复并验证
     ▼
② 推进   模型干一步活，就重写一次整张表
     │     普通活由 read / run_shell 完成；
     │     独立的分析活交给 delegate_task，
     │     子 Agent 在干净上下文里跑一次请求，只回结论
     │     右栏跟着翻转：
     │       [x] 读 tsconfig
     │       [>] 运行类型检查
     │       [ ] 逐个修复并验证
     ▼
③ 收尾   最后一项标为 completed，模型给出最终回答
           [x] 读 tsconfig
           [x] 运行类型检查
           [x] 逐个修复并验证
```

图里其实只有三个角色：**模型出主意**——清单上写什么、每项什么状态，都是它调 `todo_write` 时现场交出来的；**todos.ts 记账**——把交来的表检查一遍，覆盖存进内存；**TUI 显示**——内存一变就刷新右栏。清单本体不在模型手里，所以每次都得整张重写。

那模型自己不保管清单，更新状态时怎么知道表上现在有什么？答案是对话历史（history）：

- **上一张表在哪**：模型每次调 `todo_write`，这条调用会连同参数原样记进 history——上一张表和每项的状态都在里面。工具的回执只有一句「已更新 2 项 TODO」，不含明细。
- **进度怎么算**：history 里还躺着这之后每一步工具调用和结果，模型翻一翻就知道哪些活干完了，把翻完的表整张重交一遍。

换句话说，`todos.ts` 只忠实保存模型交上来的表，进度它一概不管；表对不对，全看模型能不能从 history 里把自己的进度准确拼回来。

## 1. 目标

今天的验收标准：

1. 收到多步骤任务后，模型用 `todo_write` 写入整张计划；每项只有 `pending`、`in_progress`、`completed` 三种状态，同时最多一项进行中；
2. 模型每完成一步就更新清单，右栏与 `/todos` 读取同一份状态，因此能持续看到当前进度；
3. `delegate_task` 用不带主历史的独立请求处理子任务，只把结论作为工具结果交回主 Agent，再由主 Agent 继续执行。

**当天代码行数**：Day 9 源码相对 Day 8 新增 123 行、删除 10 行，净增 113 行，控制在 500 行以内。

## 2. 设计

### 2.1 TODO 是一个普通的 function tool，外加一条刷新链路

模型本身没有 TODO 能力，OpenAI SDK 也没有 `todo_write`。它和 Day 2 的时间工具一样，是我们自己定义的 function tool：`todos.ts` 写好工具名、用途说明和参数格式，Day 4 的 `toOpenAITools()` 把它们放进请求，模型看到说明就知道怎么调用（完整定义见 3.1）。实现上有两个取舍：

- **整表写入，不做增删改**。为什么不拆成「新增一项」「改一项状态」「删一项」三个工具？那样模型要给每项编号，还得记住编号怎么变。清单通常就几行，每次整张重写多花不了几个 token，却省掉一整套编号协议。把关放在入口：内容不能为空、status 必须合法、进行中的任务最多一个；不合格就整张退回，旧表原样保留，不让半份计划上屏。
- **保存即上屏**。`todos.ts` 把新表存进内存就喊一声 `onChange`，入口把这声喊接到 TUI 的 `updatePanel()`，右栏立刻刷新。右栏和 `/todos` 读的是同一份 `formatTodos()`，两处永远一致。

### 2.2 子 Agent 是一次不带历史的请求，外加一次强制回写

`delegate_task` 是今天最简单的工具：收到任务描述，就新开一次模型请求，`messages` 只有「system + 任务描述」两条，主 Agent 的历史一条不带；结论拿回来后，由工具循环包装成一条工具结果消息，交回主 Agent。它复用同一个模型客户端，API 配置和用量统计照常工作。

边界刻意收得很窄：子 Agent 没有工具可用，也不能再往下委派，更不直接改 TODO——它只负责想，动手仍由主 Agent 完成。多个委派排着队逐个执行，天然串行。

这里的“子 Agent”不是另一个常驻进程，也不是多 Agent 协作框架。它只是一次使用独立 messages 的模型请求：用新的上下文处理一个边界清楚的问题，再把结论作为工具结果交回主 Agent。

还有一个坑：委派期间主 Agent 的清单停在旧状态，模型一疏忽就忘了更新。所以委派返回后的下一轮，我们用 `tool_choice` 把请求钉死在 `todo_write` 上，逼主 Agent 把刚干完的项标成 `completed`（失败了也可以顺手调整计划），再继续往下走。这次回写不靠模型自觉。

### 2.3 何时列清单，由 system 指令说了算

不是每句话都值得列清单——问「现在几点」也先规划三步，纯属多花一次调用。Day 9 第一次给主请求加了 system 指令，规则只有一条：多步骤任务先规划再执行，简单任务直接回答。这条指令每次请求时临时拼在 history 前面，不写进会话历史，保存会话时也不用反复存同一段话。

光靠指令还不够保险，我们另设了两个强制点：用户的话里点了名（出现 `todo`、任务清单，或「然后」「最后」「并总结」这类步骤词），第一轮就钉死 `todo_write`；再加上 2.2 说的委派返回后那一轮。其余轮次让模型自己决定。

## 3. 实现：先看效果

启动 Day 9 后交给它一个两步小任务，主区域显示工具进度，右侧同时出现 TODO：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › 让子 Agent 比较 TypeScript 中 interface 和 type 的区别，并给出选择建议</span>
<span style="color:#cdcd00">[调用工具 todo_write → 已更新 2 项 TODO]</span>
<span style="color:#cdcd00">[调用工具 delegate_task → interface 适合可扩展的对象结构，type 更适合联合类型与类型组合。]</span>
<span style="color:#cdcd00">[调用工具 todo_write → 已更新 2 项 TODO]</span>
<span style="color:#00cd00">对象结构优先使用 interface；需要联合类型或复杂组合时使用 type。</span>
</pre>

右侧分栏在执行过程中同步变化：

```text
──── TODO ────
[x] 比较 interface 和 type
[>] 给出选择建议
```

先回忆一下 Day 2 的循环节奏：每一轮把 system 指令加整份 history 发给模型，模型要么直接回答，要么点名要调工具；我们执行工具，把「模型的调用」和「工具的结果」两条消息追加进 history，再发起下一轮。`todo_write` 在这个循环里没有任何特殊待遇，就是普通工具之一。

带着这个节奏，把刚才那次运行摊成一条时间线：主线是主 Agent 只增不减的 history，每轮请求都等于 system 指令 + 整份 history；子 Agent 的请求发生在 `delegate_task` 执行的那一刻，两条消息，用完即弃：

```json
① 用户输入
   { "role": "user", "content": "让子 Agent 比较 TypeScript 的 interface 和 type，并给出选择建议" }

② 第 1 轮请求返回：先规划。history 追加两条
   { "role": "assistant", "content": null,
     "tool_calls": [{ "id": "call_1", "function": { "name": "todo_write",
       "arguments": { "todos": [
         { "content": "比较 interface 和 type", "status": "in_progress" },
         { "content": "给出选择建议", "status": "pending" } ] } } }] }
   { "role": "tool", "tool_call_id": "call_1", "content": "已更新 2 项 TODO" }

③ 第 2 轮请求返回：委派分析
   { "role": "assistant", "content": null,
     "tool_calls": [{ "id": "call_2", "function": { "name": "delegate_task",
       "arguments": { "task": "比较 TypeScript 的 interface 和 type，并给出选择建议" } } }] }
   ⤷ execTool 执行 delegate_task，此刻子 Agent 发出独立请求（不在主 history 里）：
       { "role": "system", "content": "你是子 Agent。只完成给定子任务，返回简洁…结果；不要寒暄。" }
       { "role": "user", "content": "比较 TypeScript 的 interface 和 type，并给出选择建议" }
     拿到结论后这份请求即丢弃，结论作为工具结果回到主 history：
   { "role": "tool", "tool_call_id": "call_2", "content": "interface 适合可扩展的对象结构，type 更适合联合类型…组合。" }

④ 第 3 轮请求（tool_choice 钉住 todo_write）返回：回写进度。history 再追加两条
   { "role": "assistant", "content": null,
     "tool_calls": [{ "id": "call_3", "function": { "name": "todo_write",
       "arguments": { "todos": [
         { "content": "比较 interface 和 type", "status": "completed" },
         { "content": "给出选择建议", "status": "in_progress" } ] } } }] }
   { "role": "tool", "tool_call_id": "call_3", "content": "已更新 2 项 TODO" }

⑤ 第 4 轮请求返回：没有 tool_calls，就是最终回答
   { "role": "assistant", "content": "对象结构优先使用 interface；需要联合类型…时使用 type。" }
```

说明两点：协议里 `arguments` 实际是 JSON 字符串，上面展开成对象便于阅读；字符串里的 `…` 表示中段省略。右栏此刻显示的 `[x] 比较 / [>] 给出建议`，正是 ④ 写入的状态。

回头看 §0 埋的两个问题，现在都能对上号：

- **上一张表在哪**：② 那条 assistant 消息的 `tool_calls` 参数里，③④⑤ 每轮请求都原样带着
- **进度怎么算的**：④ 之前，history 里已经躺着 ②③ 的全部调用和子 Agent 结论，模型据此把第一项翻成 `completed`

最后注意：子 Agent 的结论会作为工具结果进入主 history，主 Agent 看得见；它自己那两段消息不进主对话，下一轮请求也不会重复发送。

### 3.1 todos.ts：状态、校验和两个工具

Day 9 新增的 `todos.ts` 一共 77 行，包含完整的 TODO 状态、两个工具和展示格式：

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

/** 注册规划与委派工具；状态变化通过监听器立即同步到 TUI。 */
export function setupPlanning(delegate: (task: string) => Promise<string>, changed: () => void): void {
    onChange = changed;
    const tools: Tool[] = [
        {
            name: 'todo_write',
            description: '写入完整 TODO 列表，用于规划和更新任务进度。开始一项时标为 in_progress，完成后标为 completed；同一时间只保留一个 in_progress。',
            parameters: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                content: { type: 'string', description: '简短、可执行的任务描述' },
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
                    return 'TODO 格式无效';
                }
                if (next.filter((todo) => todo.status === 'in_progress').length > 1) {
                    return '同一时间只能有一个进行中的 TODO';
                }
                items = next.map((todo) => ({ content: todo.content.trim(), status: todo.status }));
                onChange();
                return `已更新 ${items.length} 项 TODO`;
            },
        },
        {
            name: 'delegate_task',
            description: '把一个边界清楚的子任务交给隔离上下文的子 Agent，等待它完成后返回结果。适合分析、设计和审查；多个子任务应逐个调用。',
            parameters: {
                type: 'object',
                properties: { task: { type: 'string', description: '完整、自包含的子任务说明' } },
                required: ['task'],
                additionalProperties: false,
            },
            run: async (args) => {
                const task = String(args.task ?? '').trim();
                return task ? delegate(task) : '缺少参数 task';
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

对照开头的流程图，几个关键点：

- 沿用 Day 4 的 `Tool` 和注册表，没有为规划再造一套调用协议
- `delegate_task` 自己不实现子 Agent，只调用注入进来的 `delegate` 函数

### 3.2 chat.ts：子 Agent 与两次强制回写

`Chat` 新增一个公开方法。它使用同一个模型客户端，API 配置和用量统计都能直接复用：

```ts
// day9/chat.ts
  /** 子 Agent 使用独立上下文完成一个聚焦任务，结果回到主 Agent 后再继续 pipeline。 */
  async delegate(task: string): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: '你是子 Agent。只完成给定子任务，返回简洁、可直接交给主 Agent 使用的结果；不要寒暄。' },
        { role: 'user', content: task },
      ],
    });
    this.reportUsage(res.usage);
    return res.choices[0]?.message?.content?.trim() || '子 Agent 未返回结果';
  }
```

`messages` 只有两条，没有展开主 Agent 的整段 history；返回文本由 `execTool` 包装成 `role=tool` 消息，主 Agent 据此决定下一步。

主请求这边，system 指令写明「何时规划」：

```ts
// day9/chat.ts
const AGENT_SYSTEM = `你是一个本地编码 Agent。遇到需要多个步骤的任务时，先调用 todo_write 制定简短计划，再逐项执行并更新状态；用户明确要求 TODO 或任务清单时，必须先调用 todo_write。简单任务直接完成，不要为了形式创建 TODO。可把边界清楚的分析、设计或审查任务交给 delegate_task，多个子任务必须串行委派。`;
```

代码里的强制逻辑只有几行。`wantsTodo` 认出「用户点了名」，`mustUpdateTodo` 记住「上一轮委派过、该回写了」；两者命中任何一个，这一轮的 `tool_choice` 就钉在 `todo_write` 上，否则交给模型自由发挥：

```ts
// day9/chat.ts
    const wantsTodo = /todo|任务清单|然后|最后|再.{0,12}(?:给出|总结|汇总)|并(?:给出|总结|汇总)/i.test(userInput);
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

// delegate_task 执行完成后
          mustUpdateTodo = toolCalls.some((c) => c.name === 'delegate_task');
```

顺带一处小改动：工具循环上限 `MAX_TOOL_TURNS` 从 5 放宽到 30。规划、委派和逐项回写都要消耗轮次，5 轮走不完一趟完整流程。

### 3.3 把新工具加入权限表

Day 8 会拒绝权限表里没有登记的工具，因此两个新工具还要加入默认配置。它们只更新内存或请求模型，不操作文件和 shell，默认设为 `allow`：

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

`loadPermissions` 会把已有配置覆盖到这张默认表上，旧的 `.geekagent/GeekAgent.json` 即使没有这两个字段，升级到 Day 9 后也能直接使用；需要限制时，再显式改成 `ask` 或 `deny`。

### 3.4 把状态变化接到右侧分栏

入口在 TUI 创建后注册工具。`delegate_task` 接到 `Chat.delegate`，TODO 的变化回调接到已有的 `updatePanel`：

```ts
// day9/index.ts
const tui = new TUI(onLine, onExit);
setupPlanning((task) => chat.delegate(task), updatePanel);
setupPermissions(permissions, (prompt) => tui.confirm(prompt));
```

面板构建函数在原有用量信息之后追加 TODO。长文字继续由 Day 7 的 `Panel` 按列宽截断，不会撑开布局：

```ts
// day9/index.ts
function buildPanel(): string[] {
    const window = CONTEXT_WINDOW;
    const ctx = estimateTokens(JSON.stringify(chat.exportHistory()));
    const root = permissionRoot();
    const shownRoot = visibleWidth(root) <= ROOT_DISPLAY_WIDTH ? root : `…/${basename(root)}`;
    const todos = formatTodos();
    return [
        `模型  ${config.model}`,
        `会话  ${sessions.currentId()}`,
        `根目录  ${shownRoot}`,
        '──── 上下文 ────',
        `${ctx} / ${window} tokens`,
        `${Math.ceil((ctx / window) * 100)}% used`,
        '──── 本轮 ────',
        `${usage.round + usage.live} tokens`,
        '──── 累计 ────',
        `${usage.cum} tokens`,
        '──── TODO ────',
        ...(todos.length > 0 ? todos : ['（暂无任务）']),
    ];
}
```

`/todos` 不维护第二份状态，只读取同一个 `formatTodos()`：

```ts
// day9/index.ts
        case '/todos': {
            const todos = formatTodos();
            tui.append(todos.length > 0 ? `TODO：\n${todos.join('\n')}` : '（暂无 TODO）', 'sys');
            break;
        }
```

## 4. 验证

```bash
npm run typecheck
npm run dev -- day9/index.ts
```

1. 输入“让子 Agent 比较 TypeScript 中 interface 和 type 的区别，并给出选择建议”
2. 确认右栏状态随执行变化，`/todos` 与右栏内容一致
3. 确认出现 `delegate_task` 结果，最终回复正常完成

## 5. 没做什么

- TODO 不持久化，也不跟随会话切换；清单明细只存在 history 里，历史压缩可能把它压薄
- 子 Agent 不能调用工具或继续委派
- 暂无并行调度和失败重试

## 6. 下一步

现在，长任务已经有了可观察的执行顺序，但 Agent 还不知道项目要求它怎样工作，重要结论也只活在当前会话里。下一步同时接入项目明确写下的规则和运行中积累的记忆，让稳定指令始终可见，让零散经验按需找回。
