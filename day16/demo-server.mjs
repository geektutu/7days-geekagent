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
