// day10/tui.ts
import {
    HStack,
    Input,
    Key,
    matchesKey,
    ProcessTerminal,
    ScrollView,
    sliceByColumn,
    Text,
    TuiAltScreen,
    truncateToWidth,
    visibleWidth,
    VStack,
    type Component,
    type Focusable,
} from '@earendil-works/pi-tui';
import { paint } from './color.js';

export type Color = 'user' | 'model' | 'tool' | 'sys';

/** 简易 token 估算：中文 1 字约 1 token、英文约 4 字符 1 token，混合取 2 字符 1 token。 */
export function estimateTokens(text: string): number {
    return Math.ceil([...text].length / 2);
}

interface Line {
    text: string;
    color: Color;
}

const PANEL_WIDTH = 28;
const MAX_LINES = 1000;

/** 固定宽度的右侧信息栏；窄终端下由 HStack 自动隐藏。 */
class Panel implements Component {
    constructor(private getLines: () => string[]) {}

    render(width: number): string[] {
        return this.getLines().map((line) => paint('sys', `│ ${truncateToWidth(line, Math.max(1, width - 2))}`));
    }

    invalidate(): void {}
}

/** 输入区把提示符和 pi-tui 的单行 Input 拼在一起，并把焦点传给 Input 以支持中文输入法。 */
class InputRow implements Component, Focusable {
    private input = new Input();
    private prompt: Color = 'user';
    private promptText = 'You › ';

    constructor(onSubmit: (value: string) => void) {
        this.input.onSubmit = onSubmit;
    }

    get focused(): boolean {
        return this.input.focused;
    }

    set focused(value: boolean) {
        this.input.focused = value;
    }

    setPrompt(color: Color, text: string): void {
        this.prompt = color;
        this.promptText = text;
    }

    takeValue(): string {
        const value = this.input.getValue().trim();
        this.input.setValue('');
        return value;
    }

    clear(): void {
        this.input.setValue('');
    }

    handleInput(data: string): void {
        this.input.handleInput(data);
    }

    render(width: number): string[] {
        const prompt = paint(this.prompt, this.promptText);
        const inputWidth = Math.max(1, width - visibleWidth(prompt));
        // Input 自带 "> "，这里切掉后换成项目沿用的提示符。
        const value = sliceByColumn(this.input.render(inputWidth + 2)[0] ?? '', 2, inputWidth, true);
        return [paint('sys', '─'.repeat(width)), `${prompt}${value}`];
    }

    invalidate(): void {
        this.input.invalidate();
    }
}

/**
 * 轻量 TUI：左侧滚动消息流，右侧常驻面板，底部单行输入。
 * 全屏切换、局部刷新、中文宽度、输入编辑与窗口大小变化交给 pi-tui。
 */
export class TUI {
    private terminal = new ProcessTerminal();
    private screen = new TuiAltScreen(this.terminal, true, undefined, { mouse: true });
    private log = new Text('', 1, 0);
    private input: InputRow;
    private lines: Line[] = [];
    private panelLines: string[] = [];
    private busy = false;
    private exiting = false;
    private confirmQuestion: string | null = null;
    private confirmResolve: ((ok: boolean) => void) | null = null;

    constructor(
        private onLine: (line: string) => void,
        private onExit: () => void,
    ) {
        this.input = new InputRow(() => this.submit());
        const body = new HStack([
            {
                component: new ScrollView(this.log, { follow: 'end', primary: true, scrollbar: 'auto' }),
                basis: 0,
                grow: 1,
                minSize: 20,
            },
            {
                component: new Panel(() => this.panelLines),
                basis: PANEL_WIDTH,
                shrink: 0,
                visible: ({ width }) => width >= 60,
            },
        ], { gap: 1 });
        this.screen.setLayoutRoot(new VStack([
            { component: body, basis: 0, grow: 1, minSize: 1 },
            { component: this.input, basis: 2, shrink: 0 },
        ]));
        this.screen.addInputListener((data) => {
            if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
                void this.onExit();
                return { consume: true };
            }
        });
    }

    start(): void {
        this.screen.start();
        this.screen.setFocus(this.input);
    }

    stop(): void {
        if (this.exiting) return;
        this.exiting = true;
        this.screen.stop({ preserveScreen: true });
    }

    append(text: string, color: Color): void {
        for (const line of text.replace(/\r\n/g, '\n').split('\n')) this.lines.push({ text: line, color });
        if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
        this.render();
    }

    appendInline(text: string, color: Color): void {
        const last = this.lines[this.lines.length - 1];
        if (last && last.color === color) last.text += text;
        else this.lines.push({ text, color });
        this.render();
    }

    setPanel(lines: string[]): void {
        this.panelLines = lines;
        this.screen.requestRender();
    }

    setBusy(busy: boolean): void {
        this.busy = busy;
    }

    ready(): void {
        if (!this.busy && this.confirmQuestion === null) this.screen.setFocus(this.input);
    }

    confirm(prompt: string): Promise<boolean> {
        const parts = prompt.replace(/\r\n/g, '\n').split('\n').map((s) => s.trimEnd()).filter(Boolean);
        const question = parts.pop() ?? '确认';
        for (const part of parts) this.append(part, 'tool');
        this.append(question, 'tool');
        this.confirmQuestion = question;
        this.input.setPrompt('tool', '[y/N] ');
        this.input.clear();
        this.screen.setFocus(this.input);
        this.screen.requestRender();
        return new Promise((resolve) => {
            this.confirmResolve = resolve;
        });
    }

    private submit(): void {
        const line = this.input.takeValue();
        if (this.confirmQuestion !== null) {
            const ok = line.toLowerCase() === 'y';
            const question = this.confirmQuestion;
            const resolve = this.confirmResolve;
            this.confirmQuestion = null;
            this.confirmResolve = null;
            this.input.setPrompt('user', 'You › ');
            const last = this.lines[this.lines.length - 1];
            if (last?.color === 'tool' && last.text === question) {
                last.text += ` → ${ok ? 'y' : 'n'}`;
                this.render();
            } else {
                this.append(`${question} → ${ok ? 'y' : 'n'}`, 'tool');
            }
            resolve?.(ok);
            return;
        }
        if (!line || this.busy) return;
        this.append(`You › ${line}`, 'user');
        this.onLine(line);
    }

    private render(): void {
        this.log.setText(this.lines.map((line) => paint(line.color, line.text)).join('\n'));
        this.screen.requestRender();
    }
}
