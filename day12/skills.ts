// day11/skills.ts
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerTool, setVisibleTools, unregisterTool, type Tool } from './tools.js';
import { ensureToolPolicy } from './permissions.js';

const SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'skills');

export interface Skill {
    name: string;
    description: string;
    instructions: string;
    /** 技能自带工具：加载时注册、卸载时移除，只在技能生效期间可调用。 */
    tools: Tool[];
    /** SKILL.md 头部声明的内置工具白名单；空数组 = 不收敛工具。 */
    builtinTools: string[];
}

let skills: Skill[] = [];
let active: Skill | null = null;

/** 解析 SKILL.md：头部 `---` 块里放 description / tools，两条 `---` 之间是指令正文。 */
function parseSkill(dir: string, name: string, raw: string): Skill {
    const lines = raw.split('\n');
    let description = '';
    const builtinTools: string[] = [];
    if (lines[0]?.trim() === '---') {
        let end = 1;
        while (end < lines.length && lines[end]?.trim() !== '---') {
            const line = lines[end].trim();
            if (line.startsWith('description:')) description = line.slice('description:'.length).trim();
            else if (line.startsWith('-')) builtinTools.push(line.replace(/^-\s*/, '').trim());
            end++;
        }
        lines.splice(0, end + (lines[end]?.trim() === '---' ? 1 : 0));
    }
    return { name, description, instructions: lines.join('\n').trim(), tools: [], builtinTools };
}

/** 技能目录里可选 tools.ts：导出 tools: Tool[]，作为该技能的自带工具。 */
async function loadSkillTools(dir: string): Promise<Tool[]> {
    const file = pathToFileURL(join(dir, 'tools.ts')).href;
    try {
        const mod = await import(file);
        return (Array.isArray(mod.tools) && mod.tools) ?? [];
    } catch {
        return [];
    }
}

/** 扫描 skills/ 目录，每个子目录一个技能；解析 / 加载失败的技能直接跳过。 */
export async function loadSkills(): Promise<Skill[]> {
    skills = [];
    let entries;
    try {
        entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return skills;
        throw err;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(SKILLS_DIR, entry.name);
        const name = entry.name;
        try {
            const raw = await readFile(join(dir, 'SKILL.md'), 'utf8');
            const skill = parseSkill(dir, name, raw);
            skill.tools = await loadSkillTools(dir);
            skills.push(skill);
        } catch (err) {
            console.error(`技能 ${name} 加载失败：${(err as Error).message}`);
        }
    }
    return skills;
}

export function listSkills(): readonly Skill[] {
    return skills;
}

export function activeSkill(): Skill | null {
    return active;
}

/** 卸载当前技能自带工具并恢复默认工具可见性；active 置空。 */
function deactivateSkill(): void {
    if (!active) return;
    for (const tool of active.tools) unregisterTool(tool.name);
    active = null;
    setVisibleTools(null);
}

/**
 * 激活技能：先卸掉上一个技能，再注册本技能自带工具，并按 SKILL.md 的白名单
 * 收敛模型可见工具（空名单 = 全部内置工具 + 技能自带工具）。
 */
export function useSkill(name: string): void {
    const skill = skills.find((s) => s.name === name);
    if (!skill) throw new Error(`未知技能：${name}`);
    deactivateSkill();
    for (const tool of skill.tools) {
        ensureToolPolicy(tool.name, 'ask'); // 技能工具默认 ask，用户可自行在配置里改 allow
        registerTool(tool);
    }
    setVisibleTools(skill.builtinTools.length > 0 ? [...skill.builtinTools, ...skill.tools.map((t) => t.name)] : null);
    active = skill;
}

export function unuseSkill(): void {
    deactivateSkill();
}