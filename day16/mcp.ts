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
