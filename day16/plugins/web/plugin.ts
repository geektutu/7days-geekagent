// day16/plugins/web/plugin.ts
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, PluginContext } from '../../plugin-sdk.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 8787;

let server: Server | null = null;
let chatting = false;

async function readChatHtml(): Promise<string> {
    return await readFile(join(ROOT, 'index.html'), 'utf8');
}

/** 把全局 tui 的 append 接到当前请求的 SSE 流上，然后调用 reply 或 handleCommand。 */
async function handleChatSSE(ctx: PluginContext, message: string, res: ServerResponse): Promise<void> {
    const tui = ctx.tui;
    tui.append = (text, color) => {
        if (!text) return;
        const type = color === 'model' ? 'content' : color === 'sys' ? 'system' : 'tool';
        res.write(`data: ${JSON.stringify({ type, text })}\n\n`);
    };
    tui.appendInline = (text, color) => tui.append(text, color);
    try {
        if (message.startsWith('/')) await ctx.handleCommand(message);
        else await ctx.reply(message);
    } catch (e) {
        res.write(`data: ${JSON.stringify({ type: 'error', text: (e as Error).message })}\n\n`);
    } finally {
        chatting = false;
    }
    res.write('data: {"type":"done"}\n\n');
    res.end();
}

const plugin: Plugin = {
    name: 'web',
    description: 'Web 对话界面：web 模式启动，浏览器里和模型交互',
    onStart: async (ctx) => {
        if (ctx.mode !== 'web') return;
        const html = await readChatHtml();
        server = createServer((req, res) => {
            if (req.method === 'GET' && req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(html);
            } else if (req.method === 'GET' && req.url === '/status') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ plugin: 'web', status: 'ok', port: PORT, at: new Date().toISOString() }));
            } else if (req.method === 'POST' && req.url === '/api/chat') {
                if (chatting) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end('{"error":"chat is busy"}');
                    return;
                }
                let body = '';
                req.on('data', (c) => (body += c));
                req.on('end', () => {
                    try {
                        const { message } = JSON.parse(body);
                        if (typeof message !== 'string' || !message.trim()) {
                            res.writeHead(400);
                            res.end('{"error":"message required"}');
                            return;
                        }
                        res.writeHead(200, {
                            'Content-Type': 'text/event-stream',
                            'Cache-Control': 'no-cache',
                            Connection: 'keep-alive',
                        });
                        chatting = true;
                        void handleChatSSE(ctx, message, res);
                    } catch (e) {
                        if (!res.headersSent) res.writeHead(500);
                        res.end(String((e as Error).message));
                    }
                });
            } else {
                res.writeHead(404);
                res.end('not found');
            }
        });
        await new Promise<void>((resolve, reject) => {
            server!.once('error', reject);
            server!.listen(PORT, resolve);
        });
        ctx.tui.append(`[web 插件] 对话界面已启动：http://localhost:${PORT}`, 'sys');
    },
    onExit: async () => {
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
    },
};

export default plugin;
