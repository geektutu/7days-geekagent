import { createInterface } from 'node:readline';
import 'dotenv/config';
import { loadConfig } from './config.js';
import { Chat } from './chat.js';
import { installCliConfirm } from './tools.js';
import { err, out, paint } from './color.js';
import { Sessions } from './sessions.js';
import { loadSessions, saveSessions } from './storage.js';

const config = loadConfig();
const chat = new Chat(config.baseURL, config.apiKey, config.model);
const sessions = new Sessions();

const rl = createInterface({ input: process.stdin, output: process.stdout });

// 用彩色提示符标注「用户输入」这一侧，避免再整行回显造成重复。
rl.setPrompt(paint('user', 'You › '));

let busy = false;

async function saveAll(): Promise<{ count: number; file: string }> {
    const data = sessions.dump(chat.exportHistory());
    const file = await saveSessions(data);
    return { count: Object.keys(data.sessions).length, file };
}

function printHelp(): void {
    out('sys', `可用命令：
  /help   显示帮助
  /compact 立即压缩旧对话摘要（不等自动触发）
  /new <id> 新建并切换到会话
  /sessions 列出内存中的会话
  /open <id> 切换会话
  /save   保存全部会话到 .geekagent/sessions.json
  /load   从 .geekagent/sessions.json 恢复全部会话
  /reset  清空当前会话记忆
  /exit   保存全部会话并退出（等价于 Ctrl+C / Ctrl+D）
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
            const [command, id] = line.split(/\s+/, 2);
            switch (command) {
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
                case '/save':
                    try {
                        const { count, file } = await saveAll();
                        out('sys', `（已保存 ${count} 个会话到 ${file}）`, true);
                    } catch (e) {
                        err('sys', `保存失败：${(e as Error).message}`);
                    }
                    break;
                case '/load':
                    try {
                        const { data, file } = await loadSessions();
                        const messages = sessions.restore(data);
                        chat.importHistory(messages);
                        out('sys', `（已从 ${file} 恢复 ${sessions.list(messages).length} 个会话，当前：${sessions.currentId()}）`, true);
                    } catch (e) {
                        err('sys', `读取失败：${(e as Error).message}`);
                    }
                    break;
                case '/new':
                    if (!id) {
                        err('sys', '用法：/new <id>');
                        break;
                    }
                    try {
                        chat.importHistory(sessions.create(id, chat.exportHistory()));
                        out('sys', `（已新建并切换到会话 ${id}）`, true);
                    } catch (e) {
                        err('sys', `新建失败：${(e as Error).message}`);
                    }
                    break;
                case '/sessions': {
                    const list = sessions.list(chat.exportHistory());
                    const lines = list.map((item) => `${item.current ? '*' : ' '} ${item.id}（${item.count} 条消息）`);
                    out('sys', `会话：\n${lines.join('\n')}`, true);
                    break;
                }
                case '/open':
                    if (!id) {
                        err('sys', '用法：/open <id>');
                        break;
                    }
                    try {
                        const messages = sessions.open(id, chat.exportHistory());
                        chat.importHistory(messages);
                        out('sys', `（已切换到会话 ${id}，${messages.length} 条消息）`, true);
                    } catch (e) {
                        err('sys', `打开失败：${(e as Error).message}`);
                    }
                    break;
                case '/exit':
                    rl.close();
                    return;
                default:
                    out('sys', `未知命令：${command}（输入 /help 查看）`, true);
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

rl.on('close', async () => {
    try {
        const generatedId = sessions.nameDefault(chat.exportHistory());
        const { count, file } = await saveAll();
        out('sys', `（退出前已保存 ${count} 个会话到 ${file}）`, true);
        if (generatedId) {
            out('sys', `（会话 ID：${generatedId}，重启后可用 /load 再用 /open ${generatedId} 打开）`, true);
        }
    } catch (e) {
        err('sys', `退出前保存失败：${(e as Error).message}`);
    }
    out('sys', 'bye', true);
});

out('sys', `GeekAgent Day 6 —— 多会话与持久化（模型：${config.model}，当前会话：${sessions.currentId()}）`, true);
rl.prompt();
