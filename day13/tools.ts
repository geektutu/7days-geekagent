import { exec } from 'node:child_process';
import { readdir, readFile, glob, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { authorize, permissionRoot, policyFor, redact, safeGlob, safePath } from './permissions.js';
import { backup } from './undo.js';

const execAsync = promisify(exec);

/** 单条命令最长运行时间，超时直接杀进程。 */
const SHELL_TIMEOUT_MS = 10_000;
/** 命令输出超过这个字符数就截断，避免撑爆上下文。 */
const MAX_OUTPUT_CHARS = 2000;
/** glob 最多返回的条数，防止一次性撑爆上下文。 */
const MAX_GLOB_RESULTS = 200;
/** 写入前 diff 预览最多展示的行数，避免整文件覆盖时刷屏。 */
const MAX_DIFF_LINES = 100;
/** search 最多返回的命中行数，命中太多说明关键词不够聚焦。 */
const MAX_SEARCH_RESULTS = 50;
/** search 只扫不超过这个字节数的文本文件，跳过体积可疑的大文件。 */
const MAX_SEARCH_FILE_SIZE = 1024 * 1024;
/** fetch 最长的等待时间，超时按失败处理。 */
const FETCH_TIMEOUT_MS = 15_000;

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
    /** 工具内部需要先构造 diff 等详细提示时，自行调用 authorize。 */
    authorizes?: boolean;
}

/** 工具注册表。新增工具调用 registerTool 收口，重复名字直接报错。 */
const registry: Tool[] = [];

export function registerTool(tool: Tool): void {
    if (registry.some((t) => t.name === tool.name)) throw new Error(`工具 ${tool.name} 已注册`);
    registry.push(tool);
}

/** 技能卸载时移除它自带的工具，让注册表回到加载前的样子。 */
export function unregisterTool(name: string): void {
    const index = registry.findIndex((t) => t.name === name);
    if (index >= 0) registry.splice(index, 1);
}

/** 当前可见工具的名单；null 表示全部可见（没有技能激活时）。 */
let visibleTools: string[] | null = null;

/** 技能激活时把可见工具收敛到技能声明的集合；卸载时传 null 恢复全部工具。 */
export function setVisibleTools(names: string[] | null): void {
    visibleTools = names;
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
        description: '在本地执行一条 shell 命令（bash -c），返回合并后的标准输出/错误。是否确认由权限配置决定。纯查看文件请优先用 ls / read / glob。',
        parameters: {
            type: 'object',
            properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
            required: ['command'],
            additionalProperties: false,
        },
        run: async (args) => {
            const command = String(args.command ?? '').trim();
            if (!command) return '缺少参数 command';

            if (!(await authorize('run_shell', `即将执行命令：${command}`))) {
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
        authorizes: true,
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
            const input = String(args.path ?? '.').trim() || '.';
            try {
                const dir = await safePath(input);
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
            const input = String(args.path ?? '').trim();
            if (!input) return '缺少参数 path';
            const offset = Math.max(0, Number(args.offset) || 0);
            try {
                const file = await safePath(input);
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
                for await (const p of glob(safeGlob(pattern), {
                    cwd: permissionRoot(),
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
        name: 'search',
        description: '在仓库内按内容检索代码（忽略大小写）。返回 相对路径:行号: 内容，适合找「哪个文件里出现了某段文字/某个调用」。默认跳过 node_modules、隐藏路径、二进制与大于 1MB 的文件。',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: '要检索的关键词，如 "safePath"、一个函数名或一行报错文案。' },
                path: { type: 'string', description: '要检索的相对目录，默认整个仓库根目录；传子目录可加快速度。' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
        run: async (args) => {
            const pattern = String(args.pattern ?? '').trim();
            if (!pattern) return '缺少参数 pattern';
            const sub = String(args.path ?? '').trim();
            try {
                const dir = sub ? await safePath(sub) : permissionRoot();
                const hits = await searchTree(dir, pattern.toLowerCase());
                if (hits.length === 0) return `没有匹配 "${pattern}"${sub ? `（在 ${sub} 下）` : ''}`;
                const hint = hits.length >= MAX_SEARCH_RESULTS ? `\n...(已达上限 ${MAX_SEARCH_RESULTS} 行，换更聚焦的关键词再搜)` : '';
                return `匹配 "${pattern}" ${hits.length} 行：\n${hits.join('\n')}${hint}`;
            } catch (err) {
                return `search 失败：${(err as Error).message}`;
            }
        },
    },
    {
        name: 'fetch',
        description: '抓取一个网页并转成纯文本，让模型看到仓库之外的信息（文档、博文、报错页等）。默认 ask 策略，执行前需要确认；只支持 http/https。',
        parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: '要访问的完整网址，以 http:// 或 https:// 开头。' } },
            required: ['url'],
            additionalProperties: false,
        },
        run: async (args) => {
            const input = String(args.url ?? '').trim();
            if (!input) return '缺少参数 url';
            let target: URL;
            try {
                target = new URL(input);
            } catch {
                return `URL 不合法：${input}`;
            }
            if (target.protocol !== 'http:' && target.protocol !== 'https:') return '只支持 http/https 链接';
            if (!(await authorize('fetch', `\n即将访问网页：\n${input}\n确认抓取？`))) return '已取消抓取';
            try {
                const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
                if (!res.ok) return `请求失败：HTTP ${res.status} ${res.statusText}`;
                const text = await res.text();
                const contentType = res.headers.get('content-type') ?? '';
                const body = /\bhtml\b/.test(contentType) ? htmlToText(text) : text;
                return truncate(body);
            } catch (err) {
                const e = err as Error;
                return e.name === 'TimeoutError' ? `抓取超时（${FETCH_TIMEOUT_MS / 1000}s），可稍后重试` : `抓取失败：${e.message}`;
            }
        },
        authorizes: true,
    },
    {
        name: 'write',
        description: '写入或整体覆盖一个文本文件。ask 策略下展示新旧内容的 diff 并请求确认；自动创建缺失的父目录；适合新建文件或整体重写，小幅修改请优先用 patch。',
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
            const input = String(args.path ?? '').trim();
            if (!input) return '缺少参数 path';
            const file = await safePath(input);
            const wrote = await commitWrite('write', file, String(args.content ?? ''));
            return wrote ? `已写入 ${input}` : '已取消写入';
        },
        authorizes: true,
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
            const input = String(args.path ?? '').trim();
            if (!input) return '缺少参数 path';
            const file = await safePath(input);
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
            const wrote = await commitWrite('patch', file, patched);
            return wrote ? `已应用 ${hunks.length} 处修改到 ${input}` : '已取消修改';
        },
        authorizes: true,
    },
];

BUILTIN_TOOLS.forEach(registerTool);

/** 超出阈值就截断输出，并附上原长度提示。 */
function truncate(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) return text;
    return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...(输出已截断，原共 ${text.length} 字符)`;
}

/**
 * 在 dir 目录内按内容检索：用 Node 内置 glob 枚举文件（默认跳过隐藏路径与 node_modules），
 * 跳过二进制（含空字节）与过大的文件，逐行做忽略大小写的包含匹配，凑满上限即停。
 * 返回「相对 root 的路径:行号: 内容」列表，格式照搬 ripgrep。
 */
async function searchTree(dir: string, pattern: string): Promise<string[]> {
    const root = permissionRoot();
    const prefix = relative(root, dir);
    const hits: string[] = [];
    for await (const p of glob('**/*', {
        cwd: dir,
        exclude: (d) => d.split('/').some((seg) => seg === 'node_modules' || seg.startsWith('.')),
    })) {
        if (hits.length >= MAX_SEARCH_RESULTS) break;
        const rel = (prefix ? `${prefix.replaceAll('\\', '/')}/` : '') + p.replaceAll('\\', '/');
        const file = join(dir, p);
        let st;
        try {
            st = await stat(file);
        } catch {
            continue; // 文件可能在被遍历时被删除
        }
        if (!st.isFile() || st.size > MAX_SEARCH_FILE_SIZE) continue;
        let text: string;
        try {
            text = await readFile(file, 'utf8');
        } catch {
            continue;
        }
        if (text.includes('\0')) continue; // 含空字节基本是二进制，跳过
        text.split('\n').forEach((line, i) => {
            if (hits.length >= MAX_SEARCH_RESULTS) return;
            if (line.toLowerCase().includes(pattern)) hits.push(`${rel}:${i + 1}: ${line.trimEnd()}`);
        });
    }
    return hits;
}

/**
 * 极简 HTML → 纯文本：剥掉脚本/样式/注释，块级标签换行，解码常见实体。
 * 不追求完整解析，够把文档、博文读成模型能用的文本。
 */
function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\/(?:p|div|h[1-6]|li|ul|ol|tr|td|th|table|pre|blockquote|section|article|header|footer)>/gi, '\n')
        .replace(/<(?:br|hr)[\s\S]*?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&nbsp;/gi, ' ')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n');
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
async function commitWrite(tool: 'write' | 'patch', file: string, next: string): Promise<boolean> {
    let oldtxt: string | null = null;
    try {
        oldtxt = await readFile(file, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (oldtxt === next) return true;
    if (!(await authorize(tool, `\n${simpleDiff(oldtxt ?? '', next)}\n确认写入 ${file}？`))) return false;
    await backup(file, oldtxt);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next);
    return true;
}

/** 把注册表里的工具转成 OpenAI Chat Completions 的 tools 参数格式；技能激活时只暴露它声明的工具。 */
export function toOpenAITools(): ChatCompletionTool[] {
    return registry
        .filter((tool) => !visibleTools || visibleTools.includes(tool.name))
        .map((tool) => ({
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
        return redact(`参数不是合法 JSON：${argsJson}`);
    }

    try {
        if (policyFor(name) === 'deny') return `权限拒绝：工具 ${name} 不允许执行`;
        if (!tool.authorizes && !(await authorize(name))) return `权限拒绝：工具 ${name} 不允许执行`;
        return redact(await tool.run(args));
    } catch (err) {
        return redact(`工具执行失败：${(err as Error).message}`);
    }
}
