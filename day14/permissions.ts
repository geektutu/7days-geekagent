// day12/permissions.ts
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type Policy = 'ask' | 'allow' | 'deny';

export interface PermissionConfig {
    root: string;
    tools: Record<string, Policy>;
}

const DEFAULT_TOOLS: Record<string, Policy> = {
    get_current_time: 'allow',
    run_shell: 'ask',
    ls: 'allow',
    read: 'allow',
    glob: 'allow',
    search: 'allow',
    fetch: 'ask',
    write: 'ask',
    patch: 'ask',
    todo_write: 'allow',
    delegate_task: 'allow',
    memory_write: 'allow',
    memory_search: 'allow',
    rag_add: 'ask',
    rag_search: 'allow',
};

let config: PermissionConfig = { root: process.cwd(), tools: DEFAULT_TOOLS };
let confirmFn: (prompt: string) => Promise<boolean> = async () => false;

/** 配置不存在时写入 Day 7 的默认权限；存在但写错时直接报错，不静默放宽。 */
export async function loadPermissions(file = '.geekagent/GeekAgent.json'): Promise<PermissionConfig> {
    let raw: string;
    try {
        raw = await readFile(file, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const defaults = { root: '..', tools: { ...DEFAULT_TOOLS } };
        await mkdir(dirname(resolve(file)), { recursive: true });
        await writeFile(file, `${JSON.stringify(defaults, null, 2)}\n`);
        raw = JSON.stringify(defaults);
    }
    const value = JSON.parse(raw) as { root?: unknown; tools?: unknown };
    if (typeof value.root !== 'string' || !value.root.trim()) throw new Error('GeekAgent.json 的 root 必须是非空字符串');
    if (!value.tools || typeof value.tools !== 'object' || Array.isArray(value.tools)) {
        throw new Error('GeekAgent.json 的 tools 必须是对象');
    }
    const tools = { ...DEFAULT_TOOLS };
    for (const [name, policy] of Object.entries(value.tools)) {
        if (policy !== 'ask' && policy !== 'allow' && policy !== 'deny') {
            throw new Error(`工具 ${name} 的策略必须是 ask / allow / deny`);
        }
        tools[name] = policy;
    }
    return { root: resolve(dirname(resolve(file)), value.root), tools };
}

export function setupPermissions(next: PermissionConfig, fn: (prompt: string) => Promise<boolean>): void {
    config = next;
    confirmFn = fn;
}

export function permissionRoot(): string {
    return config.root;
}

export function policyFor(tool: string): Policy {
    return config.tools[tool] ?? 'deny';
}

/** 技能自带的工具不在默认配置里，加载时补一条默认策略（默认 ask），避免被一律 deny 卡死。 */
export function ensureToolPolicy(tool: string, policy: Policy): void {
    if (config.tools[tool] === undefined) config.tools[tool] = policy;
}

export async function authorize(tool: string, prompt = `工具 ${tool} 请求执行`): Promise<boolean> {
    const policy = policyFor(tool);
    if (policy === 'allow') return true;
    if (policy === 'deny') return false;
    return confirmFn(redact(prompt));
}

/** 返回根目录内的绝对路径，并用 realpath 挡住借符号链接越界。 */
export async function safePath(input: string): Promise<string> {
    const root = resolve(config.root);
    const target = resolve(root, input);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`路径越界：${input}`);

    let existing = target;
    while (true) {
        try {
            existing = await realpath(existing);
            break;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            const parent = dirname(existing);
            if (parent === existing) throw err;
            existing = parent;
        }
    }
    const realRoot = await realpath(root);
    const realRel = relative(realRoot, existing);
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error(`路径越界：${input}`);
    return target;
}

/** glob 固定以 root 为 cwd；模式本身只允许根目录内的相对写法。 */
export function safeGlob(pattern: string): string {
    if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) throw new Error(`路径越界：${pattern}`);
    return pattern;
}

/** 只屏蔽敏感环境变量的真实值，普通输出保持原样。 */
export function redact(text: string): string {
    let result = text;
    for (const [name, value] of Object.entries(process.env)) {
        if (!/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) || !value) continue;
        result = result.replaceAll(value, `[REDACTED:${name}]`);
    }
    return result;
}
