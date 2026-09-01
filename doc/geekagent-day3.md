---
title: 从零实现 GeekAgent —— Day3 Bash 工具
description: >-
  7天从零实现Agent教程，用 TypeScript 动手写一个最简单的 Agent/Harness。Day 3 给模型接上第一个能碰真实机器的工具：在本地执行 shell 命令，并加上超时、输出截断、执行前确认三道护栏，让 Agent 真正「动手」。
date: '2026-08-22 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 3：让模型真正「动手」——Bash is all you need

> Day 2 打通了「工具调用循环」，但 `get_current_time` 只是个零风险演示。Day 3 给模型接上第一个能碰真实机器的工具：在本地执行 shell 命令，并加上超时、输出截断、执行前确认三道护栏。

## 0. 标题从哪来：Bash is all you need

"Bash is all you need" 是 coding-agent 圈子里流行的一句口号，玩的是 Transformer 开山论文那句著名的 "Attention is all you need" 的梗。它的含义很直白：

在编程 Agent 的世界里，只要模型能跑一条 shell 命令，几乎就等于拥有了所有能力——读文件靠 `cat` / `head`，列目录靠 `ls`，搜代码靠 `grep` / `rg`，改文件靠 `echo >` / `sed`，跑测试、装依赖、调 git、启服务……全都是 bash 的一条子命令。换句话说，一个能用的 bash 工具，在能力上**已经囊括**了后面要做的 `read` / `glob` / 写文件 / 搜索等所有专用工具。这句话最早随 Andrej Karpathy 一类"给模型一个终端基本就够"的观点出圈，也成为很多早期 Agent（如 SWE-agent）把 bash 当作主交互界面的原因。

但这句口号只说对了一半：**bash 能做很多事，也意味着它能造成很大影响**。`cat` 和 `rm -rf` 都从同一个入口执行，所以不能把模型生成的命令直接交给系统。我们用 `run_shell` 接入 bash，同时加入超时、输出截断和执行前确认，并把确认做成可替换的函数。

## 1. 为什么 shell 不能直接裸跑

`bash -c <command>` 本身只是一行，但模型生成的命令可能出错，也可能影响工作区之外的内容。我们先加三项最基本的限制：

1. **超时**：模型让跑 `sleep 999` 或一个挂起的命令，没有超时就会永久阻塞「请求 → 执行 → 回传」的循环，agent 直接卡死。
2. **输出截断**：模型让跑 `cat 几个G的日志` 或 `find /`，stdout 能瞬间撑爆上下文窗口，把前面的对话全挤掉。截到 ~2000 字符是保底。
3. **执行前确认**：命令可能是 `rm -rf`。Day 3 先用手动 `y/N` 顶上，并把确认逻辑**独立成一个函数**，后续的权限模型（白名单 / ask / allow / deny）直接替换它。

工业级实现（Claude Code 的 Bash 工具、OpenCode 的 bash 工具）也是同一个思路，只是护栏更完整：

| | 工业级 Bash 工具 | Day 3 demo |
|---|---|---|
| 运行隔离 | sandbox 或容器 | 当前机器直接执行 |
| 长任务 | 后台任务、可继续读取输出 | 10 秒超时 |
| 输出 | stdout/stderr 流式、结构化 | 合并后截断到 2000 字符 |
| 权限 | 规则、白名单或分级确认 | 每次执行前 `y/N` |

两者的核心都是“模型提出命令，程序受控执行”。Day 3 先用最少代码跑通这条链路，不把它包装成可直接用于生产环境的 shell sandbox。

## 2. 目标：把「本地执行命令」交给模型

Day 3 只做一件事：**让模型通过 `run_shell` 在本地执行一条 shell 命令，并读取结果**。从此它可以列目录、跑测试、查进程和修改配置。

验收标准：

1. 模型在需要时会主动调用 `run_shell` 工具，并给出 `command` 参数
2. 命令执行前，终端弹出 `y/N` 确认，拒绝则命令不跑
3. 命令有超时上限（10s），不会永久挂起 agent 循环
4. 超长输出被截断（2000 字符），不会撑爆上下文

**当天代码行数**：5 个源文件共 359 行，`tools.ts` 约 142 行，包含 shell 工具、输出截断和执行确认。

## 3. 设计：确认留在工具内部

Day 2 的工具循环已经能处理任意工具的 `run`，因此这次只新增 shell 工具，不修改循环体。

关键设计决策：**确认发生在工具 `run` 内部，而不是在循环里**。

```
chat.ts 循环（Day 2 原样，未改）：
    for 每一轮:
        发请求 → 流式收 → 若有完整 tool_calls：
            逐个 execTool(name, args)
                ↓
        run_shell.run(args)  ← Day 3 新增，循环对此无感知
            1. 解析 command
            2. await confirm(...)   ← 可注入的确认（本行调用的 confirm 由 setConfirmFn 注入）
            3. bash -c 执行（带 timeout）
            4. 合并 stdout/stderr + 截断
            5. 返回字符串
            ↓
        结果以 role=tool 回传，模型继续
```

这样 `execTool` 不知道也不关心「这个工具要不要确认」——确认的细节完全封装在 `run_shell.run` 里，它只调用一个 `confirm` 函数变量。后续要升级权限时，只需通过 `setConfirmFn` 把 `confirm` 换成白名单/allow/deny 实现，循环和其它工具都不用动。

## 4. 实现：tools.ts 加工具与确认，index.ts 加一行接线

Day 3 的改动主要在 `day3/tools.ts`：新增 `run_shell` 工具、输出截断以及可注入的确认能力；`index.ts` 把主 REPL 的 readline 注入为确认实现（见 4.3）。

运行后终端里会看到下面的效果（颜色用 HTML 还原）：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › 帮我看下当前目录有哪些文件</span>
<span style="color:#00cd00">好的，我来列一下……</span>
<span style="color:#cdcd00">[调用工具 run_shell → ls]</span>
<span style="color:#cdcd00">即将执行命令：ls [y/N]</span>
<span style="color:#00cd00">目录里有：chat.ts  config.ts  index.ts  tools.ts</span>
<span style="color:#00cdcd">You › </span>
</pre>

改动包括 `tools.ts` 的工具实现与 `index.ts` 的一行接线。

### 4.1 新增依赖与常量

```ts
// day3/tools.ts
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Interface as ReadLine } from 'node:readline';

const execAsync = promisify(exec);

const SHELL_TIMEOUT_MS = 10_000;   // 单条命令最长运行时间，超时杀进程
const MAX_OUTPUT_CHARS = 2000;     // 输出超此字符数截断，避免撑爆上下文
```

### 4.2 `TOOLS` 数组新增 `run_shell`

`run_shell` 仍然注册到 Day 2 的 `TOOLS`，调用循环通过同一个 `Tool` 接口执行：

```ts
// day3/tools.ts
{
  name: 'run_shell',
  description: '在本地执行一条 shell 命令（bash -c），返回合并后的标准输出/错误。执行前会向用户确认。',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
    required: ['command'],
    additionalProperties: false,
  },
  run: async (args) => {
    const command = String(args.command ?? '').trim();
    if (!command) return '缺少参数 command';

    if (!(await confirm(`即将执行命令：${command}`))) {
      return '已取消执行';
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_CHARS * 4,
      });
      return truncate([stdout, stderr].filter(Boolean).join('\n') || '(无输出)');
    } catch (err) {
      const e = err as { message: string; stdout?: string; stderr?: string };
      const partial = [e.stdout, e.stderr].filter(Boolean).join('\n');
      return truncate(`命令执行失败（${e.message}）\n${partial}`);
    }
  },
}
```

与当天主题直接相关的只有两点：

- **超时交给 `exec`**：达到 `timeout` 后结束子进程，避免工具循环一直等待。
- **stdout/stderr 合并**：两路输出拼到一起回传，模型看到的就是终端用户会看到的东西（含报错）。

### 4.3 两个独立小函数 + 一处对 index.ts 的增量改动

`tools.ts` 里把确认能力连同 `truncate` 一并实现：

```ts
// day3/tools.ts
/** 超出阈值就截断输出，并附上原长度提示。 */
function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...(输出已截断，原共 ${text.length} 字符)`;
}

type ConfirmFn = (prompt: string) => Promise<boolean>;

let confirm: ConfirmFn = async () => false;   // 未注入时一律拒绝，命令不会在无人确认下执行

/** 注入交互式确认逻辑（后续权限模型可在此替换）。 */
export function setConfirmFn(fn: ConfirmFn): void {
  confirm = fn;
}

// 基于「唯一的那一个」readline 接口构造 CLI 确认：临时挂一个 line 监听器读一次回答，
// 读完即移除，主 rl 始终不 close。默认 CLI 实现，属于 tools 内部细节，不单独导出。
function buildCliConfirm(rl: ReadLine): ConfirmFn {
  return (prompt) =>
    new Promise<boolean>((resolve) => {
      const onLine = (raw: string) => {
        rl.removeListener('line', onLine);
        const ans = raw.trim().toLowerCase();
        resolve(ans === 'y' || ans === 'yes');
      };
      rl.on('line', onLine);
      rl.resume();
      out('tool', `${prompt} [y/N] `);   // 确认提示染黄色，一眼认出是危险操作
    });
}

/** 用主 REPL 的 readline 接口安装 CLI 确认（index.ts 调用这一行即可）。 */
export function installCliConfirm(rl: ReadLine): void {
  setConfirmFn(buildCliConfirm(rl));
}
```

`truncate` 是纯函数，把「超长处理」从主流程里抽出来。`confirm` / `setConfirmFn` 是 Day 3 最重要的抽象——被 `run_shell` 调用，但签名与具体工具无关，将来做权限模型时把它的实现从「每次都问」换成「按白名单自动 allow/deny」即可，调用点完全不用改。

`index.ts` 相对 Day 2 仅多这一行接线（其余 REPL 循环原样保留）：

```ts
// day3/index.ts
import { installCliConfirm } from './tools.js';

installCliConfirm(rl);   // 把主 REPL 的 rl 注入为确认实现
```

`run_shell` 的 `run` 里只调用 `confirm(...)`，不碰任何 `readline`、不创建接口——这就是 Day 3 把「确认」做成可替换抽象、且不与主 REPL 争抢 stdin 的关键。

### 4.4 终端着色：复用 Day 1 的 color.ts

Day 3 不新写着色逻辑，直接复用 Day 1 的 `color.ts`（`paint` / `out` / `err` + 颜色表 `C`），Day 1/2/3 共用同一份。Day 3 在两处用到黄色（`tool`）：

1. **工具调用进度行**：chat.ts yield 的 `[调用工具 run_shell → ...]` 用黄色，与模型正文（绿色）区分，index.ts 按行首 `\n[调用工具` 判断。
2. **执行前确认提示**：上面 `buildCliConfirm` 里的 `out('tool', \`${prompt} [y/N] \`)` 把确认提示染成黄色，一眼认出「危险操作需要拍板」。

效果见本节开头的终端示例：工具调用进度行与执行前确认提示都染黄，与模型正文（绿色）区分。

## 5. 验证

- `npm run typecheck`：确认类型检查通过。
- 冒烟测试：运行 `npm run dev -- day3/index.ts`，让模型「帮我看下当前目录有哪些文件」（模型应调用 `run_shell` 跑 `ls`），终端先弹 `y/N` 确认，确认后回传结果
- 护栏自测：
  - 跑 `sleep 11` → 约 10s 后超时，返回失败信息
  - 跑 `cat <大文件>` → 输出被截断到 2000 字符
  - 确认时输入 `n` → 返回「已取消执行」，命令没跑

## 6. 没做什么

- **权限模型**：确认只是「每次问 y/N」，还不能按工具配置 allow / ask / deny。
- **目录隔离**：shell 能访问任意路径，没有限制在当前工作区内。
- **流式输出**：命令执行完才一次性回传输出。

## 7. 下一步

shell 能读写文件，但能力范围太宽，连只读操作也需要确认。下一步把高频文件操作拆成参数明确的专用工具，让读取更顺手、写入变化更容易检查。
