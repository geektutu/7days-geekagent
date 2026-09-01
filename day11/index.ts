// day11/index.ts
import 'dotenv/config';
import { basename } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { loadConfig } from './config.js';
import { Chat } from './chat.js';
import { Sessions } from './sessions.js';
import { loadSessions, saveSessions } from './storage.js';
import { TUI, estimateTokens } from './tui.js';
import { loadPermissions, permissionRoot, setupPermissions } from './permissions.js';
import { undo } from './undo.js';
import { formatTodos, setupPlanning } from './todos.js';
import { listMemories, loadMemory, setupMemory } from './memory.js';
import { loadInstructions } from './instructions.js';
import { activeSkill, listSkills, loadSkills, unuseSkill, useSkill } from './skills.js';

/** 模型上下文窗口（tokens）：demo 直接写死，用于计算「上下文占用比例」。 */
const CONTEXT_WINDOW = 64000;
/** 面板内容宽 26 列；「根目录  」占 8 列，剩余 18 列优先留给最后一级目录。 */
const ROOT_DISPLAY_WIDTH = 18;

if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Day 11 的 TUI 需要真实终端（TTY）；管道 / 重定向下请运行 day6。');
    process.exit(1);
}

const config = loadConfig();
let permissions;
try {
    permissions = await loadPermissions();
} catch (e) {
    console.error(`.geekagent/GeekAgent.json 读取失败：${(e as Error).message}`);
    process.exit(1);
}
let instructions = '';
try {
    await loadMemory();
    instructions = await loadInstructions(permissions.root);
} catch (e) {
    console.error(`项目上下文读取失败：${(e as Error).message}`);
    process.exit(1);
}
const chat = new Chat(config.baseURL, config.apiKey, config.model, instructions);
const sessions = new Sessions();
const skills = await loadSkills();

/** 用量状态：live 是流式进行中按字符估算的增量；正式总数以接口 usage 为准。 */
const usage = { cum: 0, round: 0, live: 0 };
/** 忙碌期间 TUI 不接受新输入，这里再兜一层防止异步入队重入。 */
let busy = false;

const tui = new TUI(onLine, onExit);
setupPlanning((task) => chat.delegate(task), updatePanel);
setupMemory(updatePanel);
setupPermissions(permissions, (prompt) => tui.confirm(prompt));
chat.setUsageListener((u) => {
    usage.live = 0; // 真实用量到了，清掉流式估算，避免短暂重复计数
    usage.cum += u.total;
    usage.round += u.total;
    updatePanel();
});

/** 右侧面板：模型、会话、用量，以及 Agent 当前维护的 TODO。 */
function buildPanel(): string[] {
    const window = CONTEXT_WINDOW;
    const ctx = estimateTokens(JSON.stringify(chat.exportHistory()));
    const root = permissionRoot();
    const shownRoot = visibleWidth(root) <= ROOT_DISPLAY_WIDTH ? root : `…/${basename(root)}`;
    const todos = formatTodos();
    return [
        `模型  ${config.model}`,
        `会话  ${sessions.currentId()}`,
        `根目录  ${shownRoot}`,
        `记忆  ${listMemories().length} 条`,
        `指令  ${instructions ? '已加载' : '无'}`,
        `技能  ${activeSkill()?.name ?? '无'}`,
        '──── 上下文 ────',
        `${ctx} / ${window} tokens`,
        `${Math.ceil((ctx / window) * 100)}% used`,
        '──── 本轮 ────',
        `${usage.round + usage.live} tokens`,
        '──── 累计 ────',
        `${usage.cum} tokens`,
        '──── TODO ────',
        ...(todos.length > 0 ? todos : ['（暂无任务）']),
    ];
}

function updatePanel(): void {
    tui.setPanel(buildPanel());
}

/** 描述当前技能带什么工具：自带工具 + 内置工具收敛的白名单，都展示出来。 */
function describeActiveSkill(): string {
    const skill = activeSkill();
    if (!skill) return '无';
    const parts: string[] = [];
    if (skill.tools.length) parts.push(`自带工具：${skill.tools.map((t) => t.name).join('、')}`);
    if (skill.builtinTools.length) parts.push(`内置工具：${skill.builtinTools.join('、')}`);
    return parts.length ? `${skill.name}（${parts.join('；')}）` : skill.name;
}

function printHelp(): void {
    tui.append(`可用命令：
  /help    显示帮助
  /compact 立即压缩旧对话摘要（不等自动触发）
  /undo    撤销最近一次 write / patch 写入
  /todos   查看 Agent 当前的 TODO 列表
  /memory  查看跨会话保留的长期记忆
  /skills  列出可用技能
  /use     加载技能（/use <名字>）
  /unuse   卸载当前技能
  /save    保存全部会话到 .geekagent/sessions.json
  /load    从 .geekagent/sessions.json 恢复全部会话
  /new <id> 新建并切换到会话
  /open <id> 切换会话
  /sessions 列出内存中的会话
  /reset   清空当前会话历史（长期记忆保留）
  /exit    保存全部会话并退出（等价于 Ctrl+C / Ctrl+D）
工具权限由 .geekagent/GeekAgent.json 的 allow / ask / deny 控制；文件工具只能访问 root 内的路径。
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
            tui.append('（已清空当前会话历史，长期记忆保留）', 'sys');
            break;
        case '/compact':
            tui.append(`[${await chat.compact()}]`, 'tool');
            break;
        case '/undo':
            try {
                tui.append(`（${await undo()}）`, 'sys');
            } catch (e) {
                tui.append(`撤销失败：${(e as Error).message}`, 'sys');
            }
            break;
        case '/todos': {
            const todos = formatTodos();
            tui.append(todos.length > 0 ? `TODO：\n${todos.join('\n')}` : '（暂无 TODO）', 'sys');
            break;
        }
        case '/memory': {
            const memories = listMemories();
            const lines = memories.map((item, i) => `${i + 1}. ${item}`);
            tui.append(lines.length > 0 ? `长期记忆：\n${lines.join('\n')}` : '（暂无长期记忆）', 'sys');
            break;
        }
        case '/skills': {
            const lines = listSkills().filter((s) => s.name).map((s) => `${activeSkill()?.name === s.name ? '*' : ' '} ${s.name} — ${s.description}`);
            tui.append(lines.length > 0 ? `可用技能（skills/ 目录，/use 加载）：\n${lines.join('\n')}` : '（skills/ 目录下暂无技能）', 'sys');
            break;
        }
        case '/use':
            if (!id) {
                tui.append('用法：/use <技能名>（/skills 查看可用技能）', 'sys');
                break;
            }
            try {
                useSkill(id);
                chat.setSkillInstructions(activeSkill()?.instructions ?? '');
                tui.append(`已加载技能 ${describeActiveSkill()}`, 'tool');
            } catch (e) {
                tui.append(`加载失败：${(e as Error).message}`, 'sys');
            }
            break;
        case '/unuse':
            unuseSkill();
            chat.setSkillInstructions('');
            tui.append('（已卸载技能，恢复默认行为）', 'tool');
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
tui.append('GeekAgent Day 11 —— 技能系统', 'sys');
const skillNames = skills.map((s) => s.name).join('、') || '（暂无）';
tui.append(`可在 day11/skills/ 下看到${skillNames}。想看技能长什么样，/skills 列出来、/use <名字> 加载、/unuse 卸载。`, 'sys');
