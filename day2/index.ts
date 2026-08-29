import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { Chat } from './chat.js';
import { err, out, paint } from './color.js';

const config = loadConfig();
const chat = new Chat(config.baseURL, config.apiKey, config.model);

const rl = createInterface({ input: process.stdin, output: process.stdout });

// 用彩色提示符标注「用户输入」这一侧。
rl.setPrompt(paint('user', 'You › '));

let busy = false;

function printHelp(): void {
    out('sys', `可用命令：
  /help   显示帮助
  /reset  清空本轮对话记忆
  /exit   退出（等价于 Ctrl+C / Ctrl+D）
 已接入工具：get_current_time（当前时间）——模型需要时会自动调用。
 输入任意内容即可与模型对话。`, true);
}

rl.on('line', async (raw) => {
    if (busy) return; // 上一轮还在流式输出，忽略连发输入
    busy = true;

    const line = raw.trim();
    if (line) {
        if (line.startsWith('/')) {
            switch (line) {
                case '/help':
                    printHelp();
                    break;
                case '/reset':
                    chat.reset();
                    out('sys', '（已清空对话记忆）', true);
                    break;
                case '/exit':
                    rl.close();
                    return;
                default:
                    out('sys', `未知命令：${line}（输入 /help 查看）`, true);
            }
        } else {
            try {
                out('sys', '\n'); // 模型回复另起一行
                for await (const delta of chat.streamReply(line)) {
                    out(delta.startsWith('\n[调用工具') ? 'tool' : 'model', delta);
                }
                out('sys', '\n');
            } catch (e) {
                err('sys', `\n请求失败：${(e as Error).message}`);
            }
        }
    }

    busy = false;
    rl.prompt();
});

rl.on('close', () => {
    out('sys', 'bye', true);
    process.exit(0);
});

out('sys', `GeekAgent Day 2 —— Agent 动手：工具调用（模型：${config.model}，输入 /help 查看命令）`, true);
rl.prompt();
