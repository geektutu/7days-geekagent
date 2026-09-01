import { registerTool, type Tool } from './tools.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
    content: string;
    status: TodoStatus;
}

let items: TodoItem[] = [];
let onChange: () => void = () => {};

/** 注册规划与委派工具；状态变化通过监听器立即同步到 TUI。 */
export function setupPlanning(delegate: (task: string) => Promise<string>, changed: () => void): void {
    onChange = changed;
    const tools: Tool[] = [
        {
            name: 'todo_write',
            description: '写入完整 TODO 列表，用于规划和更新任务进度。开始一项时标为 in_progress，完成后标为 completed；同一时间只保留一个 in_progress。',
            parameters: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                content: { type: 'string', description: '简短、可执行的任务描述' },
                                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                            },
                            required: ['content', 'status'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['todos'],
                additionalProperties: false,
            },
            run: (args) => {
                const next = Array.isArray(args.todos) ? args.todos as TodoItem[] : [];
                if (next.some((todo) => !todo.content?.trim() || !['pending', 'in_progress', 'completed'].includes(todo.status))) {
                    return 'TODO 格式无效';
                }
                if (next.filter((todo) => todo.status === 'in_progress').length > 1) {
                    return '同一时间只能有一个进行中的 TODO';
                }
                items = next.map((todo) => ({ content: todo.content.trim(), status: todo.status }));
                onChange();
                return `已更新 ${items.length} 项 TODO`;
            },
        },
        {
            name: 'delegate_task',
            description: '把一个边界清楚的子任务交给隔离上下文的子 Agent，等待它完成后返回结果。适合分析、设计和审查；多个子任务应逐个调用。',
            parameters: {
                type: 'object',
                properties: { task: { type: 'string', description: '完整、自包含的子任务说明' } },
                required: ['task'],
                additionalProperties: false,
            },
            run: async (args) => {
                const task = String(args.task ?? '').trim();
                return task ? delegate(task) : '缺少参数 task';
            },
        },
    ];
    tools.forEach(registerTool);
}

export function listTodos(): readonly TodoItem[] {
    return items;
}

export function formatTodos(): string[] {
    const mark = { pending: '[ ]', in_progress: '[>]', completed: '[x]' };
    return items.map((todo) => `${mark[todo.status]} ${todo.content}`);
}
