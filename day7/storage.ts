import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { SessionData } from './sessions.js';

const SESSION_FILE = resolve('.geekagent/sessions.json');

export async function saveSessions(data: SessionData): Promise<string> {
    await mkdir(dirname(SESSION_FILE), { recursive: true });
    await writeFile(SESSION_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return SESSION_FILE;
}

export async function loadSessions(): Promise<{ data: unknown; file: string }> {
    return { data: JSON.parse(await readFile(SESSION_FILE, 'utf8')), file: SESSION_FILE };
}
