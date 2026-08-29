// day7/index.ts
import 'dotenv/config';
import { loadConfig } from './config.js';
import { Chat } from './chat.js';
import { setConfirmFn } from './tools.js';
import { Sessions } from './sessions.js';
import { loadSessions, saveSessions } from './storage.js';
import { TUI, estimateTokens } from './tui.js';

/** 模型上下文窗口（tokens）：demo 直接写死，用于计算「上下文占用比例」。 */
const CONTEXT_WINDOW = 64000;

if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Day 7 的 TUI 需要真实终端（TTY）；管道 / 重定向下请运行 day6。');
    process.exit(1);
}

const config = loadConfig();
const chat = new Chat(config.baseURL, config.apiKey, config.model);
const sessions = new Sessions();

/** 用量状态：live 是流式进行中按字符估算的增量；正式总数以接口 usage 为准。 */
const usage = { cum: 0, round: 0, live: 0 };
/** 忙碌期间 TUI 不接受新输入，这里再兜一层防止异步入队重入。 */
let busy = false;

const tui = new TUI(onLine, onExit);
// 把工具层的执行确认接到 TUI：默认实现是「一律拒绝」，这里换成输入行上的 [y/N]
setConfirmFn((prompt) => tui.confirm(prompt));
chat.setUsageListener((u) => {
    usage.live = 0; // 真实用量到了，清掉流式估算，避免短暂重复计数
    usage.cum += u.total;
    usage.round += u.total;
    updatePanel();
});

/** 右侧面板：模型、会话、上下文占用与本轮 / 累计 tokens。 */
function buildPanel(): string[] {
    const window = CONTEXT_WINDOW;
    const ctx = estimateTokens(JSON.stringify(chat.exportHistory()));
    return [
        `模型  ${config.model}`,
        `会话  ${sessions.currentId()}`,
        '──── 上下文 ────',
        `${ctx} / ${window} tokens`,
        `${Math.ceil((ctx / window) * 100)}% used`,
        '──── 本轮 ────',
        `${usage.round + usage.live} tokens`,
        '──── 累计 ────',
        `${usage.cum} tokens`,
    ];
}

function updatePanel(): void {
    tui.setPanel(buildPanel());
}

function printHelp(): void {
    tui.append(`可用命令：
  /help    显示帮助
  /compact 立即压缩旧对话摘要（不等自动触发）
  /save    保存全部会话到 .geekagent/sessions.json
  /load    从 .geekagent/sessions.json 恢复全部会话
  /new <id> 新建并切换到会话
  /open <id> 切换会话
  /sessions 列出内存中的会话
  /reset   清空当前会话记忆
  /exit    保存全部会话并退出（等价于 Ctrl+C / Ctrl+D）
已接入工具：get_current_time（当前时间）、run_shell（执行 shell，需确认）、ls / read / glob（只读、免确认）、write / patch（写入前展示 diff 并确认）。
右侧面板实时显示本轮 / 累计 tokens 与上下文占用比例：消耗看得见，挤爆之前就知道该压缩了。`, 'sys');
}

async function saveAll(): Promise<{ count: number; file: string }> {
    const data = sessions.dump(chat.exportHistory());
    const file = await saveSessions(data);
    return { count: Object.keys(data.sessions).length, file };
}

async function handleCommand(line: string): Promise<void> {
    const [command, id] = line.split(/\s+/, 2);
    switch (command) {
        case '/help':
            printHelp();
            break;
        case '/reset':
            chat.reset();
            tui.append('（已清空对话记忆）', 'sys');
            break;
        case '/compact':
            tui.append(`[${await chat.compact()}]`, 'tool');
            break;
        case '/save':
            try {
                const { count, file } = await saveAll();
                tui.append(`（已保存 ${count} 个会话到 ${file}）`, 'sys');
            } catch (e) {
                tui.append(`保存失败：${(e as Error).message}`, 'sys');
            }
            break;
        case '/load':
            try {
                const { data, file } = await loadSessions();
                const messages = sessions.restore(data);
                chat.importHistory(messages);
                tui.append(`（已从 ${file} 恢复 ${sessions.list(messages).length} 个会话，当前：${sessions.currentId()}）`, 'sys');
            } catch (e) {
                tui.append(`读取失败：${(e as Error).message}`, 'sys');
            }
            break;
        case '/new':
            if (!id) {
                tui.append('用法：/new <id>', 'sys');
                break;
            }
            try {
                chat.importHistory(sessions.create(id, chat.exportHistory()));
                tui.append(`（已新建并切换到会话 ${id}）`, 'sys');
            } catch (e) {
                tui.append(`新建失败：${(e as Error).message}`, 'sys');
            }
            break;
        case '/sessions': {
            const lines = sessions
                .list(chat.exportHistory())
                .map((item) => `${item.current ? '*' : ' '} ${item.id}（${item.count} 条消息）`);
            tui.append(`会话：\n${lines.join('\n')}`, 'sys');
            break;
        }
        case '/open':
            if (!id) {
                tui.append('用法：/open <id>', 'sys');
                break;
            }
            try {
                const messages = sessions.open(id, chat.exportHistory());
                chat.importHistory(messages);
                tui.append(`（已切换到会话 ${id}，${messages.length} 条消息）`, 'sys');
            } catch (e) {
                tui.append(`打开失败：${(e as Error).message}`, 'sys');
            }
            break;
        case '/exit':
            await onExit();
            break;
        default:
            tui.append(`未知命令：${command}（输入 /help 查看）`, 'sys');
    }
    updatePanel();
}

async function reply(line: string): Promise<void> {
    usage.round = 0;
    try {
        tui.append('', 'sys'); // 回复前空一行，把上一段对话隔开
        for await (const delta of chat.streamReply(line)) {
            // 进度行（工具调用 / 历史压缩）用黄色；流式期间按字符估算本轮增量
            if (delta.startsWith('\n[调用工具') || delta.startsWith('\n[历史压缩')) {
                usage.live = 0;
                tui.append(delta, 'tool');
            } else {
                tui.appendInline(delta, 'model');
                usage.live = estimateTokens(delta);
            }
            updatePanel();
        }
        usage.live = 0;
        tui.append('', 'sys');
    } catch (e) {
        tui.append(`请求失败：${(e as Error).message}`, 'sys');
    }
    updatePanel();
}

async function onLine(line: string): Promise<void> {
    if (busy) return; // TUI 已挡一道，这里再兜一次防止重入
    busy = true;
    tui.setBusy(true);
    if (line.startsWith('/')) {
        await handleCommand(line);
    } else {
        await reply(line);
    }
    busy = false;
    tui.setBusy(false);
    tui.ready(); // 恢复到输入状态，读下一行
}

async function onExit(): Promise<void> {
    tui.stop(); // 恢复原来的终端内容后再用 console 打印
    try {
        const generatedId = sessions.nameDefault(chat.exportHistory());
        const { count, file } = await saveAll();
        console.log(`（退出前已保存 ${count} 个会话到 ${file}）`);
        if (generatedId) console.log(`（会话 ID：${generatedId}，重启后可用 /load 再用 /open ${generatedId} 打开）`);
    } catch (e) {
        console.error(`退出前保存失败：${(e as Error).message}`);
    }
    console.log('bye');
    process.exit(0);
}

tui.start();
updatePanel();
tui.append('GeekAgent Day 7 —— 轻量 TUI + 用量显示', 'sys');
tui.append('输入 /help 查看命令；右侧面板实时显示用量。', 'sys');
