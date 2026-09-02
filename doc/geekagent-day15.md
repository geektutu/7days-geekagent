---
title: 从零实现 GeekAgent —— Day15 MCP 工具接入
description: >-
  7天从零实现Agent教程，用 TypeScript 动手写一个最简单的 Agent/Harness。Day 15 接入 MCP：配置文件里声明 server，启动时在 stdio 上跑 JSON-RPC，外部进程提供的工具直接进入模型的工具清单。
date: '2026-09-02 18:00:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 15：接入外部工具——MCP 客户端

> Day 4 已经能把 TypeScript 函数注册成工具，但每接一种外部服务，我们仍要自己写适配代码。今天实现一个 MCP 客户端：在配置文件中声明 server，Agent 启动时自动连接，并把对方提供的工具放进现有注册表。

## 0. MCP 和 Skills 都在增加工具，有什么区别？

Day 11 的 Skills 已经能为 Agent 增加工具。现在又引入 MCP（Model Context Protocol），看起来像是在重复解决同一个问题。

两者确实都会改变模型看到的工具清单，但它们处理的不是同一层问题。Skill 负责按任务组织能力：进入代码审查任务时，加载目录中已经写明的指令、内置工具白名单和本地工具。MCP 负责发现并连接能力：配置里只写 server 的启动方式，Agent 连接后再用 `tools/list` 询问“你有哪些工具”，不需要提前知道工具名、说明和参数。

| 对比项 | Skills | MCP |
|---|---|---|
| 解决什么问题 | 按任务组合指令和工具 | 用统一协议连接外部能力 |
| 工具怎样发现 | 扫描 Skill 目录，读取本地声明 | 连接 server 后调用 `tools/list` |
| 谁负责维护 | Agent 项目 | server 提供方 |
| 怎样演进 | 修改 Skill 后随 Agent 项目一起更新 | server 独立更新，Agent 启动时重新发现 |
| 何时进入清单 | `/use` 加载 Skill 时 | Agent 启动并连接 server 后 |
| 本次怎样使用 | `SKILL.md` 提供任务指令 | 只接 tools，不承载任务指令 |

工具发现是这里最关键的差别。新增一个 Skill 时，我们已经在目录里写好了它带哪些工具；接入一个 MCP server 时，GeekAgent 事先只知道怎么启动它。具体有哪些工具、每个工具接收什么参数，要等握手后由 server 自己报告。

这也让工具可以独立演进。server 可以单独增加工具、调整描述或扩展参数，不必同时修改 GeekAgent；Agent 下次启动时再次调用 `tools/list`，就能拿到新的清单。当前实现只在启动阶段发现一次，还不能在 server 运行期间热更新工具。

两者不是替代关系。MCP server 负责把数据库、浏览器等能力接进 Agent，Skill 再决定某类任务需要哪些指令和工具。当前 demo 先让发现到的 MCP 工具全局可见，还没有把两套机制组合起来。

MCP 也不是模型的新能力。模型仍然通过 function calling，从 `tools` 数组中选择函数并生成参数。MCP 工作在模型外面，规定 Agent（client）怎样发现和调用工具服务（server）。一次调用经过三段：

```text
模型 ──function calling──> GeekAgent（MCP 客户端）──JSON-RPC──> MCP server ──> 真正的能力
```

模型看见的仍是一份普通工具清单。发现和调用外部工具，是 GeekAgent 在模型之外完成的工作。

## 1. 为什么：工具和 Agent 绑在了一起

Day 4 的注册表把工具统一成 `Tool` 接口。新增本地工具已经很直接：写一个对象，再调用 `registerTool`。但接入数据库、浏览器或协作平台时，我们仍要安装各自的 SDK、处理鉴权，并把适配代码放进 Agent 仓库。

当 M 个 Agent 分别适配 N 种工具时，最坏要维护 M×N 份适配。共同协议把它拆成两边：Agent 实现 MCP client，工具实现 MCP server，只需要维护 M+N 份协议实现。

今天先打通最短链路：从配置启动一个本地 server，读取它的工具清单，再通过现有工具循环完成调用。工具由 server 提供和维护，GeekAgent 只负责协议与接入，不再为每个工具编写适配代码。

## 2. 目标

1. `.geekagent/mcp.json` 声明本地 server 后，Agent 启动子进程并完成 MCP 握手；`/mcp` 和右侧面板显示连接结果；
2. server 返回的工具以 `mcp_<服务名>_<工具名>` 注册，模型通过原有 function calling 调用，执行结果来自 server；
3. 外部工具沿用 Day 8 的权限策略，默认每次询问，也可以按工具名配置为 `allow` 或 `deny`。

**当天代码行数**：相对 Day 14，源码新增 314 行、删除 3 行，净增 311 行；其中 `demo-server.mjs`（52 行）是用于验证协议的教学 server。

## 3. 设计：把 MCP 工具接进现有注册表

### 3.1 MCP 能传什么

先看 server 可以提供的三类能力：

| 能力 | 提供什么 | 谁决定何时使用 |
|---|---|---|
| tools | 可执行的函数 | 模型 |
| resources | 文件、数据库记录等上下文数据 | 应用程序 |
| prompts | 可复用的提示词模板 | 用户 |

MCP client 还可以向 server 提供 sampling 等能力，让 server 请求客户端调用模型。这属于相反方向的能力协商，不是 server 提供的第四类内容。

今天只接 tools。它与 Day 4 的工具注册表形状最接近：都有名称、描述、参数结构和执行结果。resources 与 prompts 需要新的交互入口，留在边界之外。

消息还需要一种传输方式。当前 MCP 常用两种：

| 对比项 | stdio | Streamable HTTP |
|---|---|---|
| server 位置 | 本地子进程 | 远程 HTTP 服务 |
| 鉴权 | 无需（信任本机进程） | OAuth / Bearer Token |
| 适合场景 | 个人本地工具 | 托管给多人用的公共工具 |
| 本次实现 | 是 | 未做 |

stdio 不需要 HTTP 服务和远程鉴权，Node.js 的 `spawn` 就能启动，适合用较少代码看清协议。代价是只能连接本机命令，而且 server 与 Agent 共享当前用户权限。

### 3.2 消息的形状：带 id 的 JSON-RPC

MCP 的消息就是 JSON-RPC 2.0：每条请求带自增的 id、方法名和参数，server 的回应带同一个 id——靠 id 把一问一答配对，不用关心消息到达的顺序。stdio 传输下约定一行一条消息。下面是我们 demo server 实际收发的完整一轮：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"geekagent","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"geekagent-demo","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"word_count","description":"统计一段文字的字符数与词数（词数按空白切分计算）。","inputSchema":{"type":"object","properties":{"text":{"type":"string","description":"要统计的文字"}},"required":["text"]}},{"name":"dice","description":"掷一个六面骰子，返回随机点数。","inputSchema":{"type":"object","properties":{}}}]}}
```

`initialize` 交换协议版本、能力和双方信息；server 回应后，client 用 `notifications/initialized` 表示初始化完成。这条通知没有 `id`，不需要回应。接着，`tools/list` 返回工具清单。参数描述 `inputSchema` 使用 JSON Schema，正好可以传给 OpenAI function calling 的 `parameters`。之后每次调用仍是一问一答：

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dice","arguments":{}}}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"点数：2"}]}}
```

工具结果放在 `content` 数组中，每项都有内容类型。当前 demo 只拼接最常见的 `text` 内容。

### 3.3 内置工具与 MCP 工具

两条路线放在一起看：

| | 内置工具（Day 4 路线） | MCP 工具（今天） |
|---|---|---|
| 代码位置 | Agent 仓库里的 TypeScript 函数 | 任意外部进程 |
| 新增工具的成本 | 写代码、注册、随 Agent 发布 | 安装 server，再添加配置 |
| 进程隔离 | 与 Agent 同进程 | 独立子进程，崩溃互不影响 |
| 信任边界 | 随 Agent 一起审查 | 外部代码，默认逐次确认 |
| 适合 | 紧贴本项目的核心能力 | 通用能力与第三方集成 |

两条路线不冲突。读写文件这类核心能力继续放在 Agent 内部，调用路径短，也容易统一限制工作目录；第三方集成更适合通过 MCP 复用。不同 server 可能提供同名工具，所以我们注册时统一加上 `mcp_<服务名>_` 前缀，例如 `mcp_demo_dice`。

### 3.4 连接生命周期与权限

每个 server 随 Agent 启动，依次完成 `initialize → initialized → tools/list`。Agent 退出时关闭所有子进程。单次请求等待 10 秒；server 启动失败或中途退出时，客户端拒绝挂起的请求，并把错误留在连接状态中。

MCP 统一了调用方式，没有替我们判断一次操作是否安全。外部工具默认使用 `ask`，每次执行前仍由 Day 8 的权限层确认；确认信任后，才在 `.geekagent/GeekAgent.json` 中按完整工具名改成 `allow`。

## 4. 实现：先效果，后实现

### 4.1 先看效果

先按 4.3 在本地创建 `.geekagent/mcp.json`，其中只声明 demo server 的启动命令，没有填写 `word_count` 和 `dice`。启动后输入 `/mcp`，两个工具已经出现在清单中；它们来自握手后的 `tools/list` 响应：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 15 —— MCP 工具接入</span>
<span style="color:#808080">.geekagent/mcp.json 里声明的 server 已自动接入：它们的工具以 mcp_ 前缀出现在工具清单里，/mcp 查看详情。</span>
<span style="color:#00cdcd">You › /mcp</span>
<span style="color:#808080">demo（2 个工具）</span>
<span style="color:#808080">  mcp_demo_word_count</span>
<span style="color:#808080">  mcp_demo_dice</span>
<span style="color:#00cdcd">You › 掷一次骰子，再统计「Model Context Protocol」这个词组的字符数和词数</span>
<span style="color:#cdcd00">即将调用 MCP 工具：mcp_demo_word_count（来自 server demo）</span>
<span style="color:#cdcd00">确认执行？[y/N] → y</span>
<span style="color:#cdcd00">[调用工具 mcp_demo_word_count → 字符数 22，词数 3]</span>
<span style="color:#cdcd00">即将调用 MCP 工具：mcp_demo_dice（来自 server demo）</span>
<span style="color:#cdcd00">确认执行？[y/N] → y</span>
<span style="color:#cdcd00">[调用工具 mcp_demo_dice → 点数：5]</span>
<span style="color:#00cd00">骰子点数是 5。「Model Context Protocol」共有 22 个字符、3 个词。</span>
</pre>

配置文件只告诉 GeekAgent 怎样启动 `demo`，`mcp_demo_word_count` 和 `mcp_demo_dice` 都不是手工注册的。客户端从 `tools/list` 读取名称、描述和 `inputSchema`，加上 server 前缀后放进 Day 4 的注册表，所以面板会自动显示 `MCP  demo(2)`，模型也能立即调用。执行前的确认仍沿用 Day 8 的权限模型。

### 4.2 demo-server.mjs：提供两个外部工具（完整 52 行）

先看 server 侧。它从 stdin 读取 JSON-RPC 消息，再把响应写到 stdout：

```js
// day15/demo-server.mjs
// 最简 MCP server：stdin/stdout 上讲 JSON-RPC，一行一个消息，对外提供两个演示工具。
import { createInterface } from 'node:readline';

const TOOLS = [
    {
        name: 'word_count',
        description: '统计一段文字的字符数与词数（词数按空白切分计算）。',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: '要统计的文字' } },
            required: ['text'],
        },
        run: ({ text }) => `字符数 ${text.length}，词数 ${String(text).split(/\s+/).filter(Boolean).length}`,
    },
    {
        name: 'dice',
        description: '掷一个六面骰子，返回随机点数。',
        inputSchema: { type: 'object', properties: {} },
        run: () => `点数：${1 + Math.floor(Math.random() * 6)}`,
    },
];

function handle(method, params) {
    if (method === 'initialize') {
        return { protocolVersion: params.protocolVersion, capabilities: {}, serverInfo: { name: 'geekagent-demo', version: '1.0.0' } };
    }
    if (method === 'tools/list') {
        return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    }
    if (method === 'tools/call') {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return { content: [{ type: 'text', text: `未知工具：${params.name}` }], isError: true };
        return { content: [{ type: 'text', text: tool.run(params.arguments ?? {}) }] };
    }
    return undefined;
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }
    if (msg.id === undefined) return; // 通知（如 initialized）：不需要回应
    const result = handle(msg.method, msg.params ?? {});
    if (result !== undefined) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    }
});
```

这个 server 处理三个请求：`initialize` 返回协议版本与自身信息；`tools/list` 返回名称、说明和 JSON Schema；`tools/call` 找到普通 JavaScript 函数并执行，再把结果包装成 `content` 数组。`notifications/initialized` 没有 `id`，所以直接跳过。

### 4.3 配置文件

在仓库根目录创建 `.geekagent/mcp.json`，内容如下：

```json
{
  "mcpServers": {
    "demo": {
      "command": "node",
      "args": ["day15/demo-server.mjs"]
    }
  }
}
```

`mcpServers` 的每个键是 server 名称，这里的 `demo` 最终会进入工具名前缀。`command` 是可执行命令，`args` 是启动参数，代码还支持用 `env` 补充环境变量。因为我们从仓库根目录运行 GeekAgent，所以 `day15/demo-server.mjs` 能直接找到；换到其他目录启动时，需要相应调整为绝对路径或正确的相对路径。

配置只描述怎样启动 server，没有列出它提供的工具。保存文件并重启 GeekAgent 后，客户端才会连接 server，通过 `tools/list` 动态取得工具清单。

### 4.4 mcp.ts：客户端本体（完整 227 行）

```ts
// day15/mcp.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { authorize, ensureToolPolicy } from './permissions.js';
import { registerTool, type Tool } from './tools.js';

/** .geekagent/mcp.json 里一个 server 的启动配置：stdio 模式下，它就是一个本地子进程。 */
export interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

/** server 在 tools/list 里返回的工具描述：名字、说明与参数 JSON Schema。 */
interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

/** MCP 协议版本：握手时报出我们支持的版本，实际以 server 回应的版本继续。 */
const PROTOCOL_VERSION = '2025-06-18';
/** 单个请求的等待上限：外部进程不回应时按失败处理，不让 Agent 一直挂着。 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 等待回应中的一个请求：id → resolve / reject。 */
interface Pending {
    resolve: (result: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

/**
 * 与一个 MCP server 的连接：子进程 + 按行收包的 JSON-RPC 客户端。
 * start 完成握手并拿到工具清单，之后每个工具调用对应一次 tools/call 请求。
 */
class McpClient {
    private proc: ChildProcess | null = null;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private buffer = '';
    /** server 无法启动或已退出后的失败说明；此后所有新请求直接失败，不再干等超时。 */
    private dead: string | null = null;

    constructor(
        readonly name: string,
        private cfg: McpServerConfig,
    ) {}

    /** 启动子进程并完成 initialize 握手，返回 server 声明的工具清单。 */
    async start(): Promise<McpToolInfo[]> {
        this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
            env: { ...process.env, ...this.cfg.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc.stdin!.on('error', () => {}); // server 已死时写入会触发 EPIPE，吞掉即可，失败由 markDead 记录
        this.proc.stdout!.setEncoding('utf8');
        this.proc.stdout!.on('data', (chunk: string) => this.onData(chunk));
        this.proc.stderr!.setEncoding('utf8');
        this.proc.stderr!.on('data', (chunk: string) => console.error(`[mcp:${this.name}] ${chunk.trimEnd()}`));
        this.proc.on('error', (err) => this.markDead(`server 无法启动：${err.message}`));
        this.proc.on('exit', (code) => this.markDead(`server 进程已退出（code ${code}）`));

        await this.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'geekagent', version: '0.1.0' },
        });
        this.notify('notifications/initialized');
        const list = await this.request('tools/list', {});
        return (list.tools ?? []) as McpToolInfo[];
    }

    /** 调用 server 上的工具，把返回内容里的 text 片段拼成一段文本。 */
    async callTool(tool: string, args: Record<string, unknown>): Promise<string> {
        const result = await this.request('tools/call', { name: tool, arguments: args });
        const text = (Array.isArray(result.content) ? result.content : [])
            .filter((item: any) => item?.type === 'text')
            .map((item: any) => item.text)
            .join('\n');
        if (result.isError) throw new Error(text || 'MCP 工具返回错误');
        return text || '(无内容)';
    }

    stop(): void {
        this.proc?.kill();
    }

    /** 按行切包：stdio 传输约定一行一个 JSON。 */
    private onData(chunk: string): void {
        this.buffer += chunk;
        let index: number;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + 1);
            if (line) this.accept(line);
        }
    }

    private accept(line: string): void {
        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            return; // 不是合法 JSON 的行直接忽略
        }
        const pending = this.pending.get(msg.id);
        if (!pending) return; // 配不上请求的（id 不存在）是 server 发的通知，demo 不处理
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
    }

    /** 发出请求并等待同 id 的回应；超时按失败处理。 */
    private request(method: string, params: unknown): Promise<any> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            if (this.dead) {
                reject(new Error(this.dead));
                return;
            }
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`请求 ${method} 超时（${REQUEST_TIMEOUT_MS / 1000}s 无回应）`));
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    /** 通知没有 id，也不等待回应。 */
    private notify(method: string): void {
        this.send({ jsonrpc: '2.0', method });
    }

    private send(message: object): void {
        try {
            this.proc?.stdin?.write(`${JSON.stringify(message)}\n`);
        } catch {
            // 进程不在了：挂起的请求由超时或 markDead 处理
        }
    }

    /** server 启动失败或崩溃时，记下原因并拒绝所有挂起的请求。 */
    private markDead(reason: string): void {
        this.dead = reason;
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
        }
        this.pending.clear();
    }
}

/** 把 server 上的一个工具包装成注册表 Tool：name 加 mcp 前缀，run 就是一次 JSON-RPC 调用。 */
function asRegistryTool(server: string, client: McpClient, info: McpToolInfo): Tool {
    const name = `mcp_${server}_${info.name}`.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
    return {
        name,
        description: `[MCP:${server}] ${info.description ?? info.name}`,
        parameters: info.inputSchema ?? { type: 'object', properties: {} },
        run: async (args) => {
            if (!(await authorize(name, `\n即将调用 MCP 工具：${name}（来自 server ${server}）\n确认执行？`))) {
                return '已取消调用';
            }
            return client.callTool(info.name, args);
        },
        authorizes: true,
    };
}

/** 一个 server 的接入状态，供面板与 /mcp 展示。 */
export interface McpStatus {
    server: string;
    tools: string[];
    error?: string;
}

let statuses: McpStatus[] = [];
let clients: McpClient[] = [];

export function mcpStatuses(): readonly McpStatus[] {
    return statuses;
}

/**
 * 读取 .geekagent/mcp.json（mcpServers: { 名字: { command, args?, env? } }），
 * 逐个启动 server 并把它们的工具注册进注册表。文件不存在 = 没有 MCP server；
 * 某个 server 启动失败只记录状态，不影响其他 server 与 Agent 本体。
 */
export async function connectMcpServers(file = '.geekagent/mcp.json'): Promise<void> {
    statuses = [];
    clients = [];
    let raw: string;
    try {
        raw = await readFile(file, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        return;
    }
    const config = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
    for (const [name, cfg] of Object.entries(config.mcpServers ?? {})) {
        const client = new McpClient(name, cfg);
        try {
            const tools = await client.start();
            const names: string[] = [];
            for (const info of tools) {
                const tool = asRegistryTool(name, client, info);
                ensureToolPolicy(tool.name, 'ask'); // 外部进程提供的工具默认 ask，GeekAgent.json 里可改 allow / deny
                registerTool(tool);
                names.push(tool.name);
            }
            clients.push(client);
            statuses.push({ server: name, tools: names });
        } catch (err) {
            client.stop();
            statuses.push({ server: name, tools: [], error: (err as Error).message });
        }
    }
}

/** 退出前关掉所有 server 子进程，不留孤儿进程。 */
export function stopMcpServers(): void {
    for (const client of clients) client.stop();
    clients = [];
}
```

这份客户端按执行顺序分成三部分。

**`McpClient` 管理通信。** `start` 用 `spawn` 拉起子进程，并在 stdout 上按行拆分 JSON。`request` 生成自增 `id`，把 Promise 与定时器放进 `pending`；`accept` 收到响应后，再用相同 `id` 找回等待中的请求。

**失败有两条路径。** 10 秒没有响应时，请求超时；进程启动失败或退出时，`markDead` 立即拒绝全部挂起请求。server 写到 stderr 的日志会加上 `[mcp:名字]` 前缀，方便定位来源。

**`asRegistryTool` 负责接入注册表。** 工具名加 server 前缀，`inputSchema` 直接作为 `parameters`，`run` 转成一次 `tools/call`。`connectMcpServers` 逐个连接并注册工具，同时用 `ensureToolPolicy` 补上默认的 `ask` 策略。

`chat.ts` 和工具循环没有修改。MCP 工具进入注册表后，模型看到的结构与内置工具相同，差异只发生在 `run` 的执行路径上。

### 4.5 index.ts：启动、展示与退出

启动阶段读取配置并连接 server。配置文件无法读取或解析时退出；单个 server 连接失败则由 `mcp.ts` 记录状态：

```ts
// day15/index.ts
import { connectMcpServers, mcpStatuses, stopMcpServers } from './mcp.js';
```

```ts
// day15/index.ts
try {
    await connectMcpServers();
} catch (e) {
    console.error(`MCP 配置读取失败：${(e as Error).message}`);
    process.exit(1);
}
```

`mcpLine` 把连接状态压缩成一行，供右侧面板展示：

```ts
// day15/index.ts
/** 描述当前 MCP 接入情况：每个 server 的工具数或失败原因。 */
function mcpLine(): string {
    const statuses = mcpStatuses();
    if (statuses.length === 0) return '无';
    return statuses.map((s) => (s.error ? `${s.server}(启动失败)` : `${s.server}(${s.tools.length})`)).join('、');
}
```

```ts
// day15/index.ts
        `技能  ${activeSkill()?.name ?? '无'}`,
        `MCP  ${mcpLine()}`,
```

`/mcp` 展开每个 server 的完整工具名，也方便我们配置权限策略：

```ts
// day15/index.ts
        case '/mcp': {
            const statuses = mcpStatuses();
            if (statuses.length === 0) {
                tui.append('（未接入 MCP server；在 .geekagent/mcp.json 里声明后重启生效）', 'sys');
                break;
            }
            const lines = statuses.map((s) =>
                s.error
                    ? `× ${s.server}：${s.error}`
                    : `${s.server}（${s.tools.length} 个工具）\n${s.tools.map((t) => `  ${t}`).join('\n')}`,
            );
            tui.append(lines.join('\n'), 'sys');
            break;
        }
```

退出时关闭 server 子进程。`/exit` 会进入 `onExit`，Ctrl+C 也直接调用同一个函数：

```ts
// day15/index.ts
        case '/exit':
            stopMcpServers();
            await onExit();
            break;
```

至此，完整路径是：读取 `mcp.json`，启动并握手，拉取工具，注册到工具表，收到模型调用后发送 `tools/call`，最后把 server 的文本结果交回原有对话循环。

## 5. 验证

先确认仓库根目录已有 4.3 的 `.geekagent/mcp.json`，再运行：

```bash
npm run typecheck
npm run dev -- day15/index.ts
```

1. 启动后输入 `/mcp`：配置中没有工具名，但界面显示 `demo（2 个工具）`、两个动态发现的工具名，右侧面板出现 `MCP  demo(2)`；
2. 输入「掷一次骰子，再统计「Model Context Protocol」这个词组的字符数和词数」：模型调用两个 `mcp_` 工具，每次执行前询问，最终返回骰子点数以及 22 个字符、3 个词；
3. 在 `.geekagent/GeekAgent.json` 的 `tools` 中加入 `"mcp_demo_dice": "allow"` 并重启：再次掷骰子不再询问；改成 `"deny"` 并重启，则调用被权限层拒绝。

## 6. 没做什么

- 只支持 stdio 传输，连不了远程的 Streamable HTTP server，也就没有 OAuth 鉴权那一层；
- server 提供的 resources、prompts，以及 client 提供的 sampling 都没有接；
- 不处理 server 的动态变化（工具增删通知、分页拉取）与断线重连，server 崩溃后要重启 Agent；
- content 只取 text 块，图片、嵌入式资源等类型不处理；
- 工具名截断、同名冲突等极端情况依赖注册表的报错，没有做更细的规范化。

## 7. 下一步

MCP 让工具可以在 Agent 之外独立演进，但当前连接仍局限在本机，能力也只有 tools。接下来可以沿着传输范围、协议能力和工具管理继续扩展，让外部能力在更多场景中保持可发现、可控制。
