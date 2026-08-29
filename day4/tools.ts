import { exec } from 'node:child_process';
import { readdir, readFile, glob, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { Interface as ReadLine } from 'node:readline';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { out } from './color.js';

const execAsync = promisify(exec);

/** 单条命令最长运行时间，超时直接杀进程。 */
const SHELL_TIMEOUT_MS = 10_000;
/** 命令输出超过这个字符数就截断，避免撑爆上下文。 */
const MAX_OUTPUT_CHARS = 2000;
/** glob 最多返回的条数，防止一次性撑爆上下文。 */
const MAX_GLOB_RESULTS = 200;
/** 写入前 diff 预览最多展示的行数，避免整文件覆盖时刷屏。 */
const MAX_DIFF_LINES = 100;

/** patch 的单个修改片段：把文件中唯一出现的 old 替换为 new。 */
interface PatchHunk {
    old: string;
    new: string;
}

/**
 * 工具的最小抽象：一个名字 + 描述 + 参数 JSON Schema + 一个 run 函数。
 * Day 2 只有时间工具一个成员；如今所有工具统一走注册表收口，
 * 外部只通过 toOpenAITools / execTool 两个出口访问。
 */
export interface Tool {
    name: string;
    description: string;
    /** OpenAI function 的 parameters 层（如 { type: 'object', properties, additionalProperties }） */
    parameters: Record<string, unknown>;
    run(args: Record<string, unknown>): Promise<string> | string;
}

/** 工具注册表。新增工具调用 registerTool 收口，重复名字直接报错。 */
const registry: Tool[] = [];

export function registerTool(tool: Tool): void {
    if (registry.some((t) => t.name === tool.name)) throw new Error(`工具 ${tool.name} 已注册`);
    registry.push(tool);
}

/** 内置工具数组：逐一注册进注册表，之后模型就能自动调用了。 */
const BUILTIN_TOOLS: Tool[] = [
    {
        name: 'get_current_time',
        description: '获取当前本地时间（Asia/Shanghai）。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    },
    {
        name: 'run_shell',
        description: '在本地执行一条 shell 命令（bash -c），返回合并后的标准输出/错误。执行前会向用户确认。纯查看文件请优先用 ls / read / glob（只读、免确认）。',
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
    {
        name: 'ls',
        description: '列出目录下的条目（只读）。默认当前目录，目录元素带 / 后缀，目录在前。',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: '要列出的目录路径，默认当前目录。' } },
            additionalProperties: false,
        },
        run: async (args) => {
            const dir = String(args.path ?? '.').trim() || '.';
            try {
                const entries = await readdir(dir, { withFileTypes: true });
                if (entries.length === 0) return '(空目录)';
                const lines = entries
                    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
                    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
                return `共 ${lines.length} 项：\n${lines.join('\n')}`;
            } catch (err) {
                return `打开目录失败：${(err as NodeJS.ErrnoException).message}`;
            }
        },
    },
    {
        name: 'read',
        description: '读取文本文件内容（只读）。文件过大时自动截断，可用 offset 从指定字符偏移处分段续读。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '要读取的文件路径。' },
                offset: { type: 'number', description: '从第 offset 个字符开始读，默认 0；用于分段读大文件。' },
            },
            required: ['path'],
            additionalProperties: false,
        },
        run: async (args) => {
            const file = String(args.path ?? '').trim();
            if (!file) return '缺少参数 path';
            const offset = Math.max(0, Number(args.offset) || 0);
            try {
                const text = await readFile(file, 'utf8');
                if (offset >= text.length) return 'offset 已越过文件末尾';
                const slice = text.slice(offset, offset + MAX_OUTPUT_CHARS);
                const truncated = offset + slice.length < text.length;
                const meta = `（文件共 ${text.length} 字符，已读第 ${offset}-${offset + slice.length} 段）\n`;
                const hint = truncated ? `\n...(已截断，续读可用 offset=${offset + slice.length})` : '';
                return meta + slice + hint;
            } catch (err) {
                return `读取文件失败：${(err as NodeJS.ErrnoException).message}`;
            }
        },
    },
    {
        name: 'glob',
        description: '按通配符查找文件路径（只读，不含内容）。* 匹配单层内任意串、? 匹配单个字符、** 匹配任意多层目录；默认从当前目录查找，跳过 node_modules 与隐藏路径。',
        parameters: {
            type: 'object',
            properties: { pattern: { type: 'string', description: 'glob 模式，如 "day4/*.ts" 或 "**/tools.ts"。' } },
            required: ['pattern'],
            additionalProperties: false,
        },
        run: async (args) => {
            const pattern = String(args.pattern ?? '').trim();
            if (!pattern) return '缺少参数 pattern';
            try {
                const files: string[] = [];
                for await (const p of glob(pattern, {
                    cwd: process.cwd(),
                    exclude: (dir) => dir.includes('node_modules'),
                })) {
                    files.push(p.replaceAll('\\', '/'));
                    if (files.length >= MAX_GLOB_RESULTS) break;
                }
                if (files.length === 0) return '(没有匹配到任何文件)';
                const list = files.join('\n');
                const hint = files.length >= MAX_GLOB_RESULTS ? `\n...(已达上限 ${MAX_GLOB_RESULTS} 条，可换更精确的 pattern)` : '';
                return `匹配到 ${files.length} 个：\n${list}${hint}`;
            } catch (err) {
                return `glob 失败：${(err as Error).message}`;
            }
        },
    },
    {
        name: 'write',
        description: '写入或整体覆盖一个文本文件。展示新旧内容的 diff 并请求确认；自动创建缺失的父目录；适合新建文件或整体重写，小幅修改请优先用 patch。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '要写入的文件路径。' },
                content: { type: 'string', description: '文件的新完整内容（原内容将被整体替换）。' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
        },
        run: async (args) => {
            const file = String(args.path ?? '').trim();
            if (!file) return '缺少参数 path';
            const wrote = await commitWrite(file, String(args.content ?? ''));
            return wrote ? `已写入 ${file}` : '已取消写入';
        },
    },
    {
        name: 'patch',
        description: '对已有文本文件做局部修改：hunks 里每个 { old, new } 把文件中唯一出现的 old 片段替换为 new。应用前展示 diff 并请求确认；old 须在文件中唯一匹配，否则该片段失败。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '要修改的文件路径。' },
                hunks: {
                    type: 'array',
                    description: '修改片段列表：每个片段把文件中唯一匹配的 old 替换为 new。',
                    items: {
                        type: 'object',
                        properties: {
                            old: { type: 'string', description: '要从文件中替换的原文片段，须唯一匹配（建议带上足够上下文）。' },
                            new: { type: 'string', description: '替换后的新文本。' },
                        },
                        required: ['old', 'new'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['path', 'hunks'],
            additionalProperties: false,
        },
        run: async (args) => {
            const file = String(args.path ?? '').trim();
            if (!file) return '缺少参数 path';
            const hunks = (Array.isArray(args.hunks) ? args.hunks : []) as PatchHunk[];
            if (hunks.length === 0) return 'hunks 为空，未做任何修改';
            let original: string;
            try {
                original = await readFile(file, 'utf8');
            } catch (err) {
                return `读取文件失败：${(err as Error).message}`;
            }
            let patched = original;
            for (const h of hunks) {
                if (!h.old) return 'hunks 中存在空的 old 片段';
                const i = patched.indexOf(h.old);
                if (i < 0) return `未找到匹配片段：${truncate(h.old)}`;
                if (patched.indexOf(h.old, i + 1) >= 0) return `片段匹配到多处，请加长 old 使其唯一：${truncate(h.old)}`;
                patched = patched.slice(0, i) + h.new + patched.slice(i + h.old.length);
            }
            if (patched === original) return '替换后内容与原文件一致，未做任何修改';
            const wrote = await commitWrite(file, patched);
            return wrote ? `已应用 ${hunks.length} 处修改到 ${file}` : '已取消修改';
        },
    },
];

BUILTIN_TOOLS.forEach(registerTool);

/** 超出阈值就截断输出，并附上原长度提示。 */
function truncate(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) return text;
    return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...(输出已截断，原共 ${text.length} 字符)`;
}

/** 按行拆文本：忽略结尾换行带来的空串；空文本返回空数组。 */
const splitLines = (s: string): string[] => (s === '' ? [] : s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));

/**
 * 最小 diff：砍掉公共前缀与公共后缀，剩下的就是变更部分，前后各留 3 行上下文。
 * 只覆盖「单处整体修改」这一最常见场景（新建/覆盖/局部小改），够用且零依赖。
 */
function simpleDiff(oldText: string, newText: string): string {
    const a = splitLines(oldText), b = splitLines(newText);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let q = 0;
    while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
    const ctx = 3, out: string[] = [];
    for (let i = Math.max(0, p - ctx); i < p; i++) out.push(' ' + a[i]);
    for (let i = p; i < a.length - q; i++) out.push('-' + a[i]);
    for (let i = p; i < b.length - q; i++) out.push('+' + b[i]);
    for (let i = Math.max(0, b.length - q); i < Math.min(b.length, b.length - q + ctx); i++) out.push(' ' + b[i]);
    if (out.length > MAX_DIFF_LINES) {
        out.length = MAX_DIFF_LINES;
        out.push(`...(diff 太长，仅展示前 ${MAX_DIFF_LINES} 行)`);
    }
    return out.join('\n');
}

/** 展示 diff 并确认后写盘；新文件也照常走此流程。内容没变则不打扰用户，直接返回成功。 */
async function commitWrite(file: string, next: string): Promise<boolean> {
    let oldtxt = '';
    try {
        oldtxt = await readFile(file, 'utf8');
    } catch {
        /* 新文件：旧内容视为空 */
    }
    if (oldtxt === next) return true;
    if (!(await confirm(`\n${simpleDiff(oldtxt, next)}\n确认写入 ${file}？`))) return false;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next);
    return true;
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

/** 把注册表里的工具转成 OpenAI Chat Completions 的 tools 参数格式。 */
export function toOpenAITools(): ChatCompletionTool[] {
    return registry.map((tool) => ({
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
    const tool = registry.find((t) => t.name === name);
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