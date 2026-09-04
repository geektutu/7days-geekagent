// day16/plugin.ts
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Color, TUI } from './tui.js';
import { registerTool as registerToolGlobal, unregisterTool as unregisterToolGlobal, type Tool } from './tools.js';

export interface PluginCommand {
    /** 命令名（不含 `/`），如 `echo` 对应 `/echo`。 */
    name: string;
    description: string;
    /** 处理函数：接收命令后的整段参数，返回要展示给用户的文本。 */
    handler: (args: string) => Promise<string> | string;
}

/** 注入给插件钩子的运行时上下文。 */
export interface PluginContext {
    tui: Pick<TUI, 'append' | 'appendInline'>;
    /** 主入口（index.ts）导出的对话处理函数：普通消息走 reply，斜杠命令走 handleCommand。服务插件（web 等）按需调用。 */
    reply: (line: string) => Promise<void>;
    handleCommand: (line: string) => Promise<void>;
    /** 运行模式：'tui' = 终端界面，'web' = Web 对话界面。 */
    mode: 'tui' | 'web';
    /** 注册工具并计入本插件账上：onStart 失败时自动回滚该插件注册的工具。 */
    registerTool(tool: Tool): void;
}

/** 主程序提供的公共上下文；registerTool 由框架按插件注入。 */
export type PluginBaseContext = Omit<PluginContext, 'registerTool'>;

/** 服务模式不创建真实终端，只保留主程序会调用的同名方法。 */
export function createHeadlessTui() {
    const noop = () => {};
    return {
        start: noop,
        stop: noop,
        append: (text: string, _color: Color) => console.log(text),
        appendInline: (text: string, _color: Color) => process.stdout.write(text),
        setPanel: (_lines: string[]) => {},
        setBusy: (_busy: boolean) => {},
        ready: noop,
        confirm: async (_prompt: string) => true,
    };
}

/**
 * 插件 = 一个 plugins/<name>/ 目录，目录里的 plugin.ts 导出此接口。
 * 三种能力：commands 在加载时注册（进命令表）；onStart/onExit 拿到 ctx，
 * 可以在里面起 HTTP 服务、注册工具。
 */
export interface Plugin {
    name: string;
    description: string;
    commands?: PluginCommand[];
    onStart?: (ctx: PluginContext) => Promise<void> | void;
    onExit?: (ctx: PluginContext) => Promise<void> | void;
}

const PLUGINS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'plugins');

let plugins: Plugin[] = [];
/** 命令注册表：插件命令全量进表，内置命令优先级高于插件命令。 */
const commands = new Map<string, PluginCommand>();
/** 每个插件注册的工具名，onStart 失败时按此回滚。 */
const ownedTools = new Map<Plugin, string[]>();

/** 执行插件命令：返回展示文本；命令不存在返回 null。 */
export async function execPluginCommand(name: string, args: string): Promise<string | null> {
    const cmd = commands.get(name);
    if (!cmd) return null;
    return await cmd.handler(args);
}

/** 列出已注册的插件命令（供 /help 和 /plugins 展示）。 */
export function listPluginCommands(): readonly PluginCommand[] {
    return [...commands.values()];
}

/** 扫描 plugins/ 目录：每个子目录一个插件，动态 import 其中的 plugin.ts；加载失败的插件跳过。 */
export async function loadPlugins(): Promise<Plugin[]> {
    plugins = [];
    commands.clear();
    ownedTools.clear();
    let entries;
    try {
        entries = await readdir(PLUGINS_DIR, { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return plugins;
        throw err;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(PLUGINS_DIR, entry.name);
        try {
            const mod = await import(pathToFileURL(join(dir, 'plugin.ts')).href);
            const plugin = mod.default as Plugin;
            if (!plugin?.name) throw new Error('plugin.ts 未导出 default Plugin 对象');
            if (plugins.some((item) => item.name === plugin.name)) throw new Error(`插件名 ${plugin.name} 已注册`);
            const seen = new Set<string>();
            const duplicate = (plugin.commands ?? []).find((cmd) => {
                if (commands.has(cmd.name) || seen.has(cmd.name)) return true;
                seen.add(cmd.name);
                return false;
            });
            if (duplicate) throw new Error(`插件命令 /${duplicate.name} 已注册`);
            for (const cmd of plugin.commands ?? []) commands.set(cmd.name, cmd);
            plugins.push(plugin);
        } catch (err) {
            console.error(`插件 ${entry.name} 加载失败：${(err as Error).message}`);
        }
    }
    return plugins;
}

export function listPlugins(): readonly Plugin[] {
    return plugins;
}

/** 为该插件构建带账本的上下文：registerTool 记录到回滚清单。 */
function contextFor(base: PluginBaseContext, p: Plugin): PluginContext {
    return {
        ...base,
        registerTool: (tool: Tool) => {
            registerToolGlobal(tool);
            const list = ownedTools.get(p) ?? [];
            list.push(tool.name);
            ownedTools.set(p, list);
        },
    };
}

/** 依次执行所有插件的启动钩子；某个插件抛错就回滚它的命令与工具，不阻断其余插件。 */
export async function runPluginStart(base: PluginBaseContext): Promise<readonly string[]> {
    const failed: string[] = [];
    const failedPlugins = new Set<Plugin>();
    for (const p of plugins) {
        try {
            await p.onStart?.(contextFor(base, p));
            base.tui.append(`[${p.name} 插件] 已加载`, 'sys');
        } catch (err) {
            for (const cmd of p.commands ?? []) commands.delete(cmd.name);
            for (const name of ownedTools.get(p) ?? []) unregisterToolGlobal(name);
            failed.push(p.name);
            failedPlugins.add(p);
            console.error(`插件 ${p.name} onStart 失败，已回滚：${(err as Error).message}`);
        }
    }
    plugins = plugins.filter((p) => !failedPlugins.has(p));
    return failed;
}

/** 退出钩子：同样逐个执行、隔离失败。 */
export async function runPluginExit(base: PluginBaseContext): Promise<void> {
    for (const p of plugins) {
        try {
            await p.onExit?.(contextFor(base, p));
        } catch (err) {
            console.error(`插件 ${p.name} onExit 失败：${(err as Error).message}`);
        }
    }
}
