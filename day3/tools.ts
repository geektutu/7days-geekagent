import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Interface as ReadLine } from 'node:readline';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { out } from './color.js';

const execAsync = promisify(exec);

/** 单条命令最长运行时间，超时直接杀进程。 */
const SHELL_TIMEOUT_MS = 10_000;
/** 命令输出超过这个字符数就截断，避免撑爆上下文。 */
const MAX_OUTPUT_CHARS = 2000;

/**
 * 工具的最小抽象：一个名字 + 描述 + 参数 JSON Schema + 一个 run 函数。
 * Day 2 只有时间工具一个成员；后续每天往 TOOLS 数组里加即可（Day 4 再收编成注册表）。
 */
export interface Tool {
    name: string;
    description: string;
    /** OpenAI function 的 parameters 层（如 { type: 'object', properties, additionalProperties }） */
    parameters: Record<string, unknown>;
    run(args: Record<string, unknown>): Promise<string> | string;
}

/** 全部已接入工具。模型只会拿到这份清单里声明的函数。 */
export const TOOLS: Tool[] = [
    {
        name: 'get_current_time',
        description: '获取当前本地时间（Asia/Shanghai）。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    },
    {
        name: 'run_shell',
        description: '在本地执行一条 shell 命令（bash -c），返回合并后的标准输出/错误。执行前会向用户确认。',
        parameters: {
            type: 'object',
            properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
            required: ['command'],
            additionalProperties: false,
        },
        run: async (args) => {
            const command = String(args.command ?? '').trim();
            if (!command) return '缺少参数 command';

            if (!(await confirm(`即将执行命令：${command}`))) {
                return '已取消执行';
            }

            try {
                const { stdout, stderr } = await execAsync(command, {
                    timeout: SHELL_TIMEOUT_MS,
                    maxBuffer: MAX_OUTPUT_CHARS * 4,
                });
                return truncate([stdout, stderr].filter(Boolean).join('\n') || '(无输出)');
            } catch (err) {
                const e = err as { message: string; stdout?: string; stderr?: string };
                const partial = [e.stdout, e.stderr].filter(Boolean).join('\n');
                return truncate(`命令执行失败（${e.message}）\n${partial}`);
            }
        },
    },
];

/** 超出阈值就截断输出，并附上原长度提示。 */
function truncate(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) return text;
    return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...(输出已截断，原共 ${text.length} 字符)`;
}

/**
 * 执行前确认的抽象。设计成可注入的函数：后续的权限模型直接替换 setConfirmFn 即可
 * （白名单 / ask / allow / deny），工具循环与工具定义都无需改动。
 *
 * 默认实现是「拒绝」——这样即使调用方忘记注入交互式确认，命令也绝不会在无人确认下执行。
 */
type ConfirmFn = (prompt: string) => Promise<boolean>;

let confirm: ConfirmFn = async () => false;

/** 注入交互式确认逻辑（后续权限模型可在此替换）。 */
export function setConfirmFn(fn: ConfirmFn): void {
    confirm = fn;
}

/**
 * 基于「唯一的那一个」readline 接口构造 CLI 确认：临时挂一个 line 监听器读一次回答，
 * 读完即移除，主 rl 始终不 close。这是确认能力的默认 CLI 实现，属于 tools 内部细节，
 * 不单独导出；外部通过 installCliConfirm(rl) 安装。
 */
function buildCliConfirm(rl: ReadLine): ConfirmFn {
    return (prompt) =>
        new Promise<boolean>((resolve) => {
            const onLine = (raw: string) => {
                rl.removeListener('line', onLine);
                const ans = raw.trim().toLowerCase();
                resolve(ans === 'y' || ans === 'yes');
            };
            rl.on('line', onLine);
            rl.resume();
            out('tool', `${prompt} [y/N] `);
        });
}

/** 用主 REPL 的 readline 接口安装 CLI 确认（index.ts 调用这一行即可）。 */
export function installCliConfirm(rl: ReadLine): void {
    setConfirmFn(buildCliConfirm(rl));
}

/** 把内部 Tool 转成 OpenAI Chat Completions 的 tools 参数格式。 */
export function toOpenAITools(): ChatCompletionTool[] {
    return TOOLS.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}

/**
 * 按名字执行工具。参数是模型生成的 JSON 字符串。
 * 任何报错都作为「结果文本」返回给模型——让模型自己读错误（失败自检后续会实现，先在这里埋线）。
 */
export async function execTool(name: string, argsJson: string): Promise<string> {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return `未知工具：${name}`;

    let args: Record<string, unknown> = {};
    try {
        args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
        return `参数不是合法 JSON：${argsJson}`;
    }

    try {
        return await tool.run(args);
    } catch (err) {
        return `工具执行失败：${(err as Error).message}`;
    }
}