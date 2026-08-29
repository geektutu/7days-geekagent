import { createInterface } from 'node:readline';
import 'dotenv/config';
import { loadConfig } from './config.js';
import { Chat } from './chat.js';
import { installCliConfirm } from './tools.js';
import { err, out, paint } from './color.js';

const config = loadConfig();
const chat = new Chat(config.baseURL, config.apiKey, config.model);

const rl = createInterface({ input: process.stdin, output: process.stdout });

// 用彩色提示符标注「用户输入」这一侧，避免再整行回显造成重复。
rl.setPrompt(paint('user', 'You › '));

let busy = false;

function printHelp(): void {
    out('sys', `可用命令：
  /help   显示帮助
  /compact 立即压缩旧对话摘要（不等自动触发）
  /reset  清空本轮对话记忆
  /exit   退出（等价于 Ctrl+C / Ctrl+D）
已接入工具：get_current_time（当前时间）、run_shell（执行 shell 命令，执行前需确认）、ls（列目录）、read（读文件）、glob（通配符查文件）——三者只读、免确认；write（写文件）、patch（按片段精确修改）——后两者写入前会展示 diff 并确认。模型需要时会自动调用。
 历史保护：history 累积过久时自动压缩——让模型把旧对话摘要成一条「此前对话摘要」，保留最近几条消息原样，腾出上下文（压缩进度以黄色行提示）。
 输入任意内容即可与模型对话。`, true);
}

// 把「基于主 REPL 那一个 readline 的确认」注入工具层（后续做权限模型时可替换 setConfirmFn）。
installCliConfirm(rl);

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
                case '/compact':
                    out('sys', '\n'); // 压缩进度另起一行
                    out('tool', `[${await chat.compact()}]`, true);
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
                    // 进度行（工具调用 / 历史压缩）用黄色，真正的回复用绿色
                    const isProgress = delta.startsWith('\n[调用工具') || delta.startsWith('\n[历史压缩');
                    out(isProgress ? 'tool' : 'model', delta);
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

out('sys', `GeekAgent Day 5 —— 历史压缩（模型：${config.model}，输入 /help 查看命令）`, true);
rl.prompt();
