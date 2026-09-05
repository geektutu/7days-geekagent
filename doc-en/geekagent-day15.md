---
title: Build GeekAgent from Scratch — Day 15 MCP Tool Integration
description: >-
  A 7-day tutorial on building an Agent from scratch, writing the simplest possible Agent/Harness in TypeScript. Day 15 integrates MCP: servers are declared in a config file, JSON-RPC runs over stdio at startup, and tools provided by external processes land straight in the model's tool list.
date: '2026-09-02 18:00:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 15: Plugging In External Tools — The MCP Client

> Day 4 could already register TypeScript functions as tools, but every new external service still meant writing adapter code ourselves. Today we build an MCP client: declare servers in a config file, connect automatically when the Agent starts, and put the tools they provide into the existing registry.

## 0. MCP and Skills Both Add Tools — What's the Difference?

Day 11's Skills can already add tools for the Agent. Now MCP (Model Context Protocol) enters the picture, which looks like solving the same problem twice.

Both do change the tool list the model sees, but they work on different layers. Skills organize capabilities by task: entering a code-review task loads the instructions written in the directory, the built-in tool whitelist, and local tools. MCP discovers and connects capabilities: the config only says how to start a server, and after connecting, the Agent asks `tools/list` "which tools do you have" — no need to know tool names, descriptions, or parameters up front.

| Aspect | Skills | MCP |
|---|---|---|
| Problem it solves | Combining instructions and tools per task | Connecting external capabilities over a uniform protocol |
| How tools are discovered | Scan the Skill directory, read local declarations | Call `tools/list` after connecting to a server |
| Who maintains it | The Agent project | The server provider |
| How it evolves | Edit the Skill and ship it with the Agent project | The server updates independently; the Agent rediscovers at startup |
| When it enters the list | When a Skill is loaded with `/use` | After the Agent starts and connects to a server |
| How it's used this time | `SKILL.md` provides task instructions | Tools only, no task instructions |

Tool discovery is the most crucial difference here. When we add a Skill, we have already written in the directory which tools it carries; when we connect an MCP server, all GeekAgent knows up front is how to start it. Which tools exist and what parameters each accepts are reported by the server itself after the handshake.

This also lets tools evolve independently. A server can add tools, tweak descriptions, or extend parameters on its own, without GeekAgent changing at the same time; the next time the Agent starts, it calls `tools/list` again and gets the new list. The current implementation discovers only once at startup and cannot hot-reload tools while a server is running.

The two are not substitutes. MCP servers bring capabilities like databases and browsers into the Agent, and Skills then decide which instructions and tools a given kind of task needs. In this demo, discovered MCP tools are simply visible globally; the two mechanisms are not combined yet.

MCP is not a new model capability either. The model still picks functions from the `tools` array and generates arguments via function calling. MCP works outside the model, specifying how an Agent (the client) discovers and calls tool services (servers). One call passes through three legs:

```text
model ──function calling──> GeekAgent (MCP client) ──JSON-RPC──> MCP server ──> the real capability
```

What the model sees is still an ordinary tool list. Discovering and calling external tools is work GeekAgent does outside the model.

## 1. Why: Tools and the Agent Got Coupled

Day 4's registry unified tools behind the `Tool` interface. Adding a local tool is already straightforward: write an object, then call `registerTool`. But connecting a database, browser, or collaboration platform still means installing its SDK, handling authentication, and placing adapter code inside the Agent repo.

With M agents each adapting to N kinds of tools, the worst case is maintaining M×N adapters. A shared protocol splits it in two: agents implement MCP clients and tools implement MCP servers, leaving only M+N protocol implementations to maintain.

Today we build the shortest path: start a local server from config, read its tool list, and complete calls through the existing tool loop. Tools are provided and maintained by the server; GeekAgent handles only the protocol and integration, and no longer writes adapter code per tool.

## 2. Goals

1. After `.geekagent/mcp.json` declares a local server, the Agent spawns the subprocess and completes the MCP handshake; `/mcp` and the side panel show the connection result;
2. Tools returned by a server are registered as `mcp_<server>_<tool>`; the model calls them through the existing function calling, and execution results come from the server;
3. External tools follow Day 8's permission policy: ask every time by default, and configurable per tool name to `allow` or `deny`.

**Lines of code for the day**: compared with Day 14, the source gains 314 lines and loses 3 — a net gain of 311; among them `demo-server.mjs` (52 lines) is a teaching server for verifying the protocol.

## 3. Design: Wiring MCP Tools into the Existing Registry

### 3.1 What MCP Can Carry

First, the three kinds of capabilities a server can provide:

| Capability | What it provides | Who decides when to use it |
|---|---|---|
| tools | Executable functions | The model |
| resources | Context data such as files and database records | The application |
| prompts | Reusable prompt templates | The user |

An MCP client can also offer capabilities such as sampling to the server, letting the server ask the client to call the model. That is capability negotiation in the opposite direction, not a fourth category provided by servers.

Today we only integrate tools. They are the closest in shape to Day 4's tool registry: both have a name, description, parameter schema, and execution results. Resources and prompts would need new interaction entry points and stay out of scope.

Messages also need a transport. MCP currently has two common ones:

| Aspect | stdio | Streamable HTTP |
|---|---|---|
| Server location | Local subprocess | Remote HTTP service |
| Authentication | None (trusting local processes) | OAuth / Bearer Token |
| Suited for | Personal local tools | Public tools hosted for many users |
| This implementation | Yes | Not done |

stdio needs no HTTP service and no remote authentication, and Node.js `spawn` can start it — good for seeing the protocol clearly with little code. The cost is that it only connects to commands on the same machine, and the server shares the current user's permissions with the Agent.

### 3.2 The Shape of Messages: JSON-RPC with an id

MCP messages are just JSON-RPC 2.0: each request carries an incrementing id, a method name, and params; the server's response carries the same id — the id pairs each question with its answer, so the order messages arrive in doesn't matter. Over stdio the convention is one message per line. Here is a complete round trip from our demo server:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"geekagent","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"geekagent-demo","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"word_count","description":"Count the characters and words of a piece of text (words are counted by splitting on whitespace).","inputSchema":{"type":"object","properties":{"text":{"type":"string","description":"The text to count"}},"required":["text"]}},{"name":"dice","description":"Roll a six-sided die and return the random result.","inputSchema":{"type":"object","properties":{}}}]}}
```

`initialize` exchanges protocol version, capabilities, and identity info; after the server responds, the client sends `notifications/initialized` to say initialization is done. This notification has no `id` and needs no reply. Then `tools/list` returns the tool list. The parameter descriptions in `inputSchema` use JSON Schema, which happens to fit straight into OpenAI function calling's `parameters`. Every later call is still one question, one answer:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dice","arguments":{}}}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Roll: 2"}]}}
```

Tool results sit in a `content` array, each entry with a content type. This demo only concatenates the most common `text` content.

### 3.3 Built-in Tools vs MCP Tools

The two routes side by side:

| | Built-in tools (Day 4 route) | MCP tools (today) |
|---|---|---|
| Code location | TypeScript functions in the Agent repo | Any external process |
| Cost of adding a tool | Write code, register, ship with the Agent | Install a server, then add config |
| Process isolation | Same process as the Agent | Independent subprocess; crashes don't affect each other |
| Trust boundary | Reviewed together with the Agent | External code, confirmed one call at a time by default |
| Suited for | Core capabilities tied to this project | General capabilities and third-party integrations |

The routes don't conflict. Core abilities like reading and writing files stay inside the Agent — short call paths, and easy to uniformly constrain the working directory; third-party integrations fit MCP reuse better. Different servers may provide tools with the same name, so registration uniformly adds the `mcp_<server>_` prefix, e.g. `mcp_demo_dice`.

### 3.4 Connection Lifecycle and Permissions

Each server starts with the Agent and completes `initialize → initialized → tools/list` in order. The Agent closes all subprocesses on exit. A single request waits up to 10 seconds; when a server fails to start or exits mid-run, the client rejects pending requests and keeps the error in the connection state.

MCP unifies how calls are made; it does not decide for us whether an operation is safe. External tools default to `ask`, and Day 8's permission layer still confirms each execution; once you decide to trust a tool, flip its full name to `allow` in `.geekagent/GeekAgent.json`.

## 4. Implementation: Effect First, Then Code

### 4.1 The Effect First

First create `.geekagent/mcp.json` locally as in 4.3 — it only declares the demo server's start command and never lists `word_count` or `dice`. After startup, type `/mcp` and the two tools are already in the list; they come from the `tools/list` response after the handshake:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 15 — MCP tool integration</span>
<span style="color:#808080">Servers declared in .geekagent/mcp.json are connected automatically: their tools appear in the tool list with the mcp_ prefix; /mcp shows details.</span>
<span style="color:#00cdcd">You › /mcp</span>
<span style="color:#808080">demo (2 tools)</span>
<span style="color:#808080">  mcp_demo_word_count</span>
<span style="color:#808080">  mcp_demo_dice</span>
<span style="color:#00cdcd">You › Roll the die once, then count the characters and words in the phrase "Model Context Protocol"</span>
<span style="color:#cdcd00">About to call MCP tool: mcp_demo_word_count (from server demo)</span>
<span style="color:#cdcd00">Confirm execution? [y/N] → y</span>
<span style="color:#cdcd00">[Calling tool mcp_demo_word_count → Characters 22, words 3]</span>
<span style="color:#cdcd00">About to call MCP tool: mcp_demo_dice (from server demo)</span>
<span style="color:#cdcd00">Confirm execution? [y/N] → y</span>
<span style="color:#cdcd00">[Calling tool mcp_demo_dice → Roll: 5]</span>
<span style="color:#00cd00">The die rolled a 5. "Model Context Protocol" has 22 characters and 3 words.</span>
</pre>

The config file only tells GeekAgent how to start `demo`; `mcp_demo_word_count` and `mcp_demo_dice` were never registered by hand. The client reads names, descriptions, and `inputSchema` from `tools/list`, prefixes the server name, and drops them into Day 4's registry, so the panel automatically shows `MCP  demo(2)` and the model can call them right away. The pre-execution confirmation still follows Day 8's permission model.

### 4.2 demo-server.mjs: Two External Tools (52 Lines in Full)

First the server side. It reads JSON-RPC messages from stdin and writes responses to stdout:

```js
// day15/demo-server.mjs
// Minimal MCP server: speaks JSON-RPC over stdin/stdout, one message per line, exposing two demo tools.
import { createInterface } from 'node:readline';

const TOOLS = [
    {
        name: 'word_count',
        description: 'Count the characters and words of a piece of text (words are counted by splitting on whitespace).',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'The text to count' } },
            required: ['text'],
        },
        run: ({ text }) => `Characters ${text.length}, words ${String(text).split(/\s+/).filter(Boolean).length}`,
    },
    {
        name: 'dice',
        description: 'Roll a six-sided die and return the random result.',
        inputSchema: { type: 'object', properties: {} },
        run: () => `Roll: ${1 + Math.floor(Math.random() * 6)}`,
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
        if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${params.name}` }], isError: true };
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
    if (msg.id === undefined) return; // notification (e.g. initialized): no reply needed
    const result = handle(msg.method, msg.params ?? {});
    if (result !== undefined) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    }
});
```

This server handles three requests: `initialize` returns the protocol version and its identity; `tools/list` returns names, descriptions, and the JSON Schema; `tools/call` finds the ordinary JavaScript function, runs it, and wraps the result in a `content` array. `notifications/initialized` has no `id`, so it is skipped outright.

### 4.3 The Config File

Create `.geekagent/mcp.json` at the repository root:

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

Each key of `mcpServers` is a server name; `demo` here ends up inside the tool-name prefix. `command` is the executable, `args` the launch arguments, and the code also supports `env` for extra environment variables. Since we run GeekAgent from the repository root, `day15/demo-server.mjs` resolves directly; launching from another directory means adjusting to an absolute path or the correct relative path.

The config only describes how to start a server; it does not list the tools it provides. Only after saving the file and restarting GeekAgent does the client connect to the server and fetch the tool list dynamically via `tools/list`.

### 4.4 mcp.ts: The Client Itself (227 Lines in Full)

```ts
// day15/mcp.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { authorize, ensureToolPolicy } from './permissions.js';
import { registerTool, type Tool } from './tools.js';

/** Startup config for one server in .geekagent/mcp.json: in stdio mode it is just a local subprocess. */
export interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

/** A tool description returned by the server in tools/list: name, description, and the JSON Schema of its parameters. */
interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

/** MCP protocol version: report the version we support at handshake; the actual session continues with the version the server echoes back. */
const PROTOCOL_VERSION = '2025-06-18';
/** Per-request wait cap: if the external process never answers, treat it as failure instead of leaving the Agent hanging. */
const REQUEST_TIMEOUT_MS = 10_000;

/** A request awaiting its response: id → resolve / reject. */
interface Pending {
    resolve: (result: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

/**
 * A connection to one MCP server: a subprocess plus a line-based JSON-RPC client.
 * start completes the handshake and fetches the tool list; afterwards each tool call maps to one tools/call request.
 */
class McpClient {
    private proc: ChildProcess | null = null;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private buffer = '';
    /** Failure reason for a server that failed to start or has exited; every new request fails fast afterwards instead of waiting out the timeout. */
    private dead: string | null = null;

    constructor(
        readonly name: string,
        private cfg: McpServerConfig,
    ) {}

    /** Start the subprocess, complete the initialize handshake, and return the tool list the server declares. */
    async start(): Promise<McpToolInfo[]> {
        this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
            env: { ...process.env, ...this.cfg.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc.stdin!.on('error', () => {}); // writing after the server dies triggers EPIPE; swallow it — markDead records the failure
        this.proc.stdout!.setEncoding('utf8');
        this.proc.stdout!.on('data', (chunk: string) => this.onData(chunk));
        this.proc.stderr!.setEncoding('utf8');
        this.proc.stderr!.on('data', (chunk: string) => console.error(`[mcp:${this.name}] ${chunk.trimEnd()}`));
        this.proc.on('error', (err) => this.markDead(`Failed to start the server: ${err.message}`));
        this.proc.on('exit', (code) => this.markDead(`The server process has exited (code ${code})`));

        await this.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'geekagent', version: '0.1.0' },
        });
        this.notify('notifications/initialized');
        const list = await this.request('tools/list', {});
        return (list.tools ?? []) as McpToolInfo[];
    }

    /** Call a tool on the server and join the text pieces of the returned content into one string. */
    async callTool(tool: string, args: Record<string, unknown>): Promise<string> {
        const result = await this.request('tools/call', { name: tool, arguments: args });
        const text = (Array.isArray(result.content) ? result.content : [])
            .filter((item: any) => item?.type === 'text')
            .map((item: any) => item.text)
            .join('\n');
        if (result.isError) throw new Error(text || 'The MCP tool returned an error');
        return text || '(no content)';
    }

    stop(): void {
        this.proc?.kill();
    }

    /** Split packets by line: the stdio transport sends one JSON per line. */
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
            return; // ignore lines that are not valid JSON
        }
        const pending = this.pending.get(msg.id);
        if (!pending) return; // unmatched ids are server-initiated notifications; the demo ignores them
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
    }

    /** Send a request and wait for the response with the same id; a timeout counts as failure. */
    private request(method: string, params: unknown): Promise<any> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            if (this.dead) {
                reject(new Error(this.dead));
                return;
            }
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Request ${method} timed out (no response within ${REQUEST_TIMEOUT_MS / 1000}s)`));
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    /** Notifications have no id and await no response. */
    private notify(method: string): void {
        this.send({ jsonrpc: '2.0', method });
    }

    private send(message: object): void {
        try {
            this.proc?.stdin?.write(`${JSON.stringify(message)}\n`);
        } catch {
            // the process is gone: pending requests are handled by timeout or markDead
        }
    }

    /** When the server fails to start or crashes, record why and reject every pending request. */
    private markDead(reason: string): void {
        this.dead = reason;
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
        }
        this.pending.clear();
    }
}

/** Wrap one server tool as a registry Tool: prefix the name with mcp, and run becomes a single JSON-RPC call. */
function asRegistryTool(server: string, client: McpClient, info: McpToolInfo): Tool {
    const name = `mcp_${server}_${info.name}`.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
    return {
        name,
        description: `[MCP:${server}] ${info.description ?? info.name}`,
        parameters: info.inputSchema ?? { type: 'object', properties: {} },
        run: async (args) => {
            if (!(await authorize(name, `\nAbout to call MCP tool: ${name} (from server ${server})\nConfirm execution?`))) {
                return 'Call cancelled';
            }
            return client.callTool(info.name, args);
        },
        authorizes: true,
    };
}

/** A server's integration status, shown by the panel and /mcp. */
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
 * Read .geekagent/mcp.json (mcpServers: { name: { command, args?, env? } }),
 * start each server and register their tools into the registry. A missing file = no MCP servers;
 * a failed server only records its status and does not affect other servers or the Agent itself.
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
                ensureToolPolicy(tool.name, 'ask'); // tools from external processes default to ask; GeekAgent.json can change it to allow / deny
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

/** Shut down all server subprocesses before exit, leaving no orphans. */
export function stopMcpServers(): void {
    for (const client of clients) client.stop();
    clients = [];
}
```

This client splits into three parts by execution order.

**`McpClient` manages communication.** `start` spawns the subprocess and splits JSON line by line on stdout. `request` generates an incrementing `id` and puts the Promise and its timer into `pending`; when `accept` receives a response, it finds the waiting request by the same `id`.

**Failure has two paths.** With no response for 10 seconds, the request times out; when the process fails to start or exits, `markDead` immediately rejects all pending requests. Logs the server writes to stderr get a `[mcp:name]` prefix, making the source easy to locate.

**`asRegistryTool` handles registry integration.** The tool name gets the server prefix, `inputSchema` becomes `parameters` directly, and `run` turns into one `tools/call`. `connectMcpServers` connects to each server and registers tools, using `ensureToolPolicy` to add the default `ask` policy.

`chat.ts` and the tool loop were not modified. Once MCP tools enter the registry, the model sees exactly the same structure as built-in tools; the difference only appears in the execution path of `run`.

### 4.5 index.ts: Startup, Display, and Exit

The startup phase reads the config and connects to servers. If the config cannot be read or parsed, exit; a single failed server connection is recorded by `mcp.ts`:

```ts
// day15/index.ts
import { connectMcpServers, mcpStatuses, stopMcpServers } from './mcp.js';
```

```ts
// day15/index.ts
try {
    await connectMcpServers();
} catch (e) {
    console.error(`Failed to read the MCP config: ${(e as Error).message}`);
    process.exit(1);
}
```

`mcpLine` compresses the connection status into one line for the side panel:

```ts
// day15/index.ts
/** Describes the current MCP status: each server's tool count or its failure reason. */
function mcpLine(): string {
    const statuses = mcpStatuses();
    if (statuses.length === 0) return 'none';
    return statuses.map((s) => (s.error ? `${s.server}(failed to start)` : `${s.server}(${s.tools.length})`)).join(', ');
}
```

```ts
// day15/index.ts
        `Skills  ${activeSkill()?.name ?? 'none'}`,
        `MCP  ${mcpLine()}`,
```

`/mcp` expands every server's full tool names, which also makes the permission policies easy to configure:

```ts
// day15/index.ts
        case '/mcp': {
            const statuses = mcpStatuses();
            if (statuses.length === 0) {
                tui.append('(no MCP servers connected; declare them in .geekagent/mcp.json and restart to take effect)', 'sys');
                break;
            }
            const lines = statuses.map((s) =>
                s.error
                    ? `× ${s.server}: ${s.error}`
                    : `${s.server} (${s.tools.length} tools)\n${s.tools.map((t) => `  ${t}`).join('\n')}`,
            );
            tui.append(lines.join('\n'), 'sys');
            break;
        }
```

On exit, close the server subprocesses. `/exit` goes through `onExit`, and Ctrl+C calls the same function:

```ts
// day15/index.ts
        case '/exit':
            stopMcpServers();
            await onExit();
            break;
```

At this point the full path is: read `mcp.json`, start and handshake, fetch tools, register them into the tool table, send `tools/call` when the model calls one, and hand the server's text result back to the existing conversation loop.

## 5. Verification

First make sure `.geekagent/mcp.json` from 4.3 exists at the repository root, then run:

```bash
npm run typecheck
npm run dev -- day15/index.ts
```

1. After startup, type `/mcp`: the config lists no tool names, yet the screen shows `demo (2 tools)` with the two dynamically discovered tool names, and the side panel shows `MCP  demo(2)`;
2. Type "roll the die once, then count the characters and words in the phrase 'Model Context Protocol'": the model calls the two `mcp_` tools, each execution asks first, and the final answer returns the die roll plus 22 characters and 3 words;
3. Add `"mcp_demo_dice": "allow"` to `tools` in `.geekagent/GeekAgent.json` and restart: rolling again no longer asks; change it to `"deny"` and restart, and the permission layer rejects the call.

## 6. What We Didn't Do

- Only local stdio servers; no Streamable HTTP and no OAuth;
- Only tools and text results; no resources, prompts, sampling, or multimodal content;
- No handling of dynamic tool changes, pagination, or reconnection; a crashed server requires restarting the Agent.

## 7. Next Step

MCP answered "how do external tools get in", but looking back at the main program, Skills, RAG, and MCP each still carry their own initialization code, command entry points, and exit cleanup. Next, we give these extension capabilities a common loading and lifecycle convention, so new abilities stop piling wiring code into `index.ts`.
