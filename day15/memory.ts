// day13/memory.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { registerTool, type Tool } from './tools.js';

const MEMORY_FILE = resolve('.geekagent/memory.json');
/** 记忆条目按这个字符窗口切块；检索、返回都以块为单位，长条目也能精确定位到段。 */
const CHUNK_SIZE = 320;
/** 相邻块的字符重叠，避免一句结论恰好被切在块边界上。 */
const CHUNK_OVERLAP = 80;
/** 一次检索最多返回的命中块数，够用又不至于撑爆上下文。 */
const MAX_RESULTS = 5;
/** BM25 平滑参数：k1 越小对词频越敏感，b 越大对长度归一越弱。 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** 查询里的虚词 / 常用字：命中再多也没有区分度，直接忽略。 */
export const STOPWORDS = new Set(['的', '了', '在', '是', '和', '一', '个', '也', '就', '都', '把', '被', '从', '到', '给', '与', '及', '这', '那', '并', '而', '等', '有', '没', '不', '我们', '一个', '可以']);

let items: string[] = [];

/** 一条记忆的一块：记录它属于哪条、条内第几段、原文偏移。 */
export interface Chunk {
    entry: number;
    index: number;
    start: number;
    text: string;
}

/**
 * 按固定窗口 + 重叠把条目切成块；短条目（不超过窗口）就是一块。
 * size 参数供 Day 14 的知识库按更大窗口切文档，省略时沿用记忆的默认窗口。
 */
export function chunkEntry(text: string, entry: number, size = CHUNK_SIZE): Chunk[] {
    if (text.length <= size) return [{ entry, index: 0, start: 0, text }];
    const chunks: Chunk[] = [];
    const step = size - CHUNK_OVERLAP;
    for (let start = 0; ; start += step) {
        chunks.push({ entry, index: chunks.length, start, text: text.slice(start, start + size) });
        if (start + size >= text.length) break;
    }
    return chunks;
}

/** 归一化：转小写、空白压成一个空格。查询词直接按子串匹配，省掉分词。 */
function norm(s: string): string {
    return s.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 零依赖分词：中文连续段切成字符二元组（bigram），英文 / 数字保留整词。
 * 自然语言提问没有词边界，bigram 是换掉「必须空格分隔关键词」的最小代价。
 */
export function tokenize(text: string): string[] {
    const tokens: string[] = [];
    const runs = norm(text).match(/[\u4e00-\u9fa5]+|[a-z0-9]+/g) ?? [];
    for (const run of runs) {
        if (/[a-z0-9]/.test(run[0]) || run.length === 1) {
            tokens.push(run);
        } else {
            for (let i = 0; i + 2 <= run.length; i++) tokens.push(run.slice(i, i + 2));
        }
    }
    return tokens;
}

/** 统计 term 在 text 中连续出现的次数（不重叠计数）。 */
function termCount(text: string, term: string): number {
    let n = 0, i = 0;
    while ((i = text.indexOf(term, i)) >= 0) {
        n++;
        i += term.length;
    }
    return n;
}

/**
 * BM25-lite：每个查询词按「tf × 平滑 idf」贡献分数，再用文档长度做归一。
 * df 越大（出现越广的词）idf 越小，长块因为词频被摊薄也不会白白占优。
 */
export function bm25(chunk: string, query: string[], all: Chunk[]): number {
    const n = all.length;
    const avgdl = all.reduce((s, c) => s + norm(c.text).length, 0) / n;
    const doc = norm(chunk);
    const dl = doc.length;
    let score = 0;
    for (const t of query) {
        const df = all.filter((c) => norm(c.text).includes(t)).length;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const tf = termCount(doc, t);
        const normed = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl)));
        score += idf * normed;
    }
    return score;
}

/** 对 query tokens 做 BM25 检索，返回命中的 top-k 块；一个都没有就返回空串。 */
function topHits(query: string[], chunks: Chunk[]): Chunk[] {
    return chunks
        .map((chunk) => ({ chunk, score: bm25(chunk.text, query, chunks) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map((hit) => hit.chunk);
}

/** 把命中块排成「条目 #N，第 M 段：内容」的可读列表，模型和用户看同一份。 */
function formatHits(hits: Chunk[]): string {
    return hits.map((c, i) => `${i + 1}. （条目 #${c.entry + 1}，第 ${c.index + 1} 段）${c.text.trim()}`).join('\n');
}

/** 按 BM25 打分检索记忆块（手动调用）：query 是空格分隔的关键词。 */
export function searchMemory(query: string): string {
    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
    if (keywords.length === 0) return '没有找到相关记忆';
    const chunks = items.flatMap((item, entry) => chunkEntry(item, entry));
    if (chunks.length === 0) return '没有找到相关记忆';
    const hits = topHits(keywords, chunks);
    return hits.length > 0 ? `找到 ${hits.length} 条相关记忆：\n${formatHits(hits)}` : '没有找到相关记忆';
}

/**
 * 每轮对话前的自动唤起：把用户原话直接切成 bigram token 再检索，命中就以「自动唤起记忆」
 * 的形式拼进 system prompt——模型不用记得自己去查，提问的同时相关记忆已在案头。
 */
export function recallMemory(rawText: string): string {
    const keywords = tokenize(rawText).filter((t) => !STOPWORDS.has(t));
    if (keywords.length === 0) return '';
    const chunks = items.flatMap((item, entry) => chunkEntry(item, entry));
    if (chunks.length === 0) return '';
    const hits = topHits(keywords, chunks);
    return hits.length > 0 ? `自动唤起 ${hits.length} 条相关记忆（供参考）：\n${formatHits(hits)}` : '';
}

/** 磁盘格式保持 string[] 不变，读、写、内存态三处一致。 */
async function saveToDisk(next: string[]): Promise<void> {
    await mkdir(dirname(MEMORY_FILE), { recursive: true });
    await writeFile(MEMORY_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    items = next;
}

/** 启动时从磁盘恢复长期记忆；文件不存在等同于还没有记忆。 */
export async function loadMemory(): Promise<void> {
    try {
        const value = JSON.parse(await readFile(MEMORY_FILE, 'utf8')) as unknown;
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
            throw new Error('memory.json 必须是字符串数组');
        }
        items = value.map((item) => item.trim()).filter(Boolean);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            items = [];
            return;
        }
        throw err;
    }
}

/** 注册写记忆 / 检索记忆工具。写入仍是整条落盘，chunks 在检索时按需切出。 */
export function setupMemory(changed: () => void): void {
    const tools: Tool[] = [
        {
            name: 'memory_write',
            description: '把值得跨会话保留的用户偏好、项目事实或重要决定写入长期记忆。支持存多段长文，检索时会按块命中、返回相关段落。不要记录临时任务进度或可随时从文件读到的内容。',
            parameters: {
                type: 'object',
                properties: { content: { type: 'string', description: '一条脱离当前对话也能独立理解的事实，可以是一段长文' } },
                required: ['content'],
                additionalProperties: false,
            },
            run: async (args) => {
                const content = String(args.content ?? '').trim();
                if (!content) return '缺少参数 content';
                const entry = content.slice(0, 4000);
                if (items.includes(entry)) return '这条记忆已经存在';
                await saveToDisk([...items, entry]);
                changed();
                return entry.length < content.length ? `已记住（过长已截短）：${entry}` : `已记住：${entry}`;
            },
        },
        {
            name: 'memory_search',
            description: '按 BM25 打分检索长期记忆，返回命中的记忆块（精确到段）。需要回忆用户偏好、项目事实或以前的决定时调用；query 使用一个或多个空格分隔的关键词，如“博客 人称”。',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: '搜索关键词，多个词用空格分隔，关键词越聚焦命中越准' } },
                required: ['query'],
                additionalProperties: false,
            },
            run: (args) => searchMemory(String(args.query ?? '')),
        },
    ];
    tools.forEach(registerTool);
}

/** 记忆块总数，供面板展示「N 条 / M 块」，让人一眼看到分块生效了。 */
export function memoryBlocks(): number {
    return items.reduce((n, item) => n + chunkEntry(item, 0).length, 0);
}

export function listMemories(): readonly string[] {
    return items;
}
