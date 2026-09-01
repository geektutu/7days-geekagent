// day11/skills/code-review/tools.ts
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '../../tools.js';

const execAsync = promisify(exec);

/** code-review 技能自带工具：拿到当前未提交的改动，供审查时逐 diff 阅读。 */
export const tools: Tool[] = [
    {
        name: 'git_diff',
        description: '获取当前未提交的代码改动（git diff HEAD），输出文件级摘要与逐行 diff。审查代码时必须先用它看改动。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => {
            try {
                const { stdout } = await execAsync('git diff HEAD', { timeout: 10_000, maxBuffer: 1024 * 1024 });
                if (!stdout.trim()) return '（当前没有未提交的改动）';
                const lines = stdout.trim().split('\n');
                const files = lines.filter((l) => l.startsWith('diff --git')).map((l) => l.replace('diff --git a/', '').replace(/ b\/.+$/, ''));
                const head = `改动了 ${files.length} 个文件：${files.join('、')}\n`;
                const diff = stdout.length > 4000 ? `${stdout.slice(0, 4000)}\n...(diff 过长已截断，原 ${stdout.length} 字符)` : stdout;
                return head + diff;
            } catch (err) {
                return `git diff 失败：${(err as NodeJS.ErrnoException).message}`;
            }
        },
    },
];