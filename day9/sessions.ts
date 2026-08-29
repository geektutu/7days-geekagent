import type OpenAI from 'openai';
import { randomUUID } from 'node:crypto';

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer', 'function']);

export interface SessionData {
    current: string;
    sessions: Record<string, Message[]>;
}
/** 多会话集合；Day 6 增加整个集合的序列化与恢复。 */
export class Sessions {
    private items = new Map<string, Message[]>([['default', []]]);
    private current = 'default';

    currentId(): string {
        return this.current;
    }

    nameDefault(currentMessages: Message[]): string | undefined {
        if (this.current !== 'default') return undefined;
        let id: string;
        do id = randomUUID().slice(0, 8); while (this.items.has(id));
        this.items.delete('default');
        this.items.set(id, currentMessages);
        this.current = id;
        return id;
    }

    create(id: string, currentMessages: Message[]): Message[] {
        checkId(id);
        if (this.items.has(id)) throw new Error(`会话 ${id} 已存在`);
        this.items.set(this.current, currentMessages);
        this.items.set(id, []);
        this.current = id;
        return [];
    }

    open(id: string, currentMessages: Message[]): Message[] {
        checkId(id);
        if (id === this.current) {
            this.items.set(id, currentMessages);
            return currentMessages;
        }
        const messages = this.items.get(id);
        if (!messages) throw new Error(`会话 ${id} 不存在`);
        this.items.set(this.current, currentMessages);
        this.current = id;
        return messages;
    }

    list(currentMessages: Message[]): { id: string; count: number; current: boolean }[] {
        this.items.set(this.current, currentMessages);
        return [...this.items]
            .map(([id, messages]) => ({ id, count: messages.length, current: id === this.current }))
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    dump(currentMessages: Message[]): SessionData {
        this.items.set(this.current, currentMessages);
        return { current: this.current, sessions: Object.fromEntries(this.items) };
    }

    restore(data: unknown): Message[] {
        if (!isSessionData(data)) throw new Error('存档不是有效的多会话数据');
        this.items = new Map(Object.entries(data.sessions));
        this.current = data.current;
        return this.items.get(this.current)!;
    }
}

function checkId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new Error('会话 ID 只能包含字母、数字、短横线和下划线');
}

function isSessionData(value: unknown): value is SessionData {
    if (!value || typeof value !== 'object') return false;
    const data = value as Partial<SessionData>;
    if (typeof data.current !== 'string' || !data.sessions || typeof data.sessions !== 'object') return false;
    return Object.entries(data.sessions).every(([id, messages]) =>
        ID_PATTERN.test(id) && Array.isArray(messages) && messages.every(isMessage)
    ) && Object.hasOwn(data.sessions, data.current);
}

function isMessage(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const role = (value as { role?: unknown }).role;
    return typeof role === 'string' && ROLES.has(role);
}
