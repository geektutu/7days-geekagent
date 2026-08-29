/** 终端着色：非 TTY（管道 / 重定向）时自动关闭，避免污染日志。 */
export const useColor = process.stdout.isTTY;

export const C = {
    reset: '\x1b[0m',
    user: '\x1b[36m', // 青色：用户输入
    model: '\x1b[32m', // 绿色：模型回复
    tool: '\x1b[33m', // 黄色：工具调用进度
    sys: '\x1b[90m', // 灰色：系统提示
};

/** 给字符串包上指定颜色并在末尾复位。 */
export function paint(color: keyof typeof C, s: string): string {
    return useColor ? `${C[color]}${s}${C.reset}` : s;
}

/** 按颜色写一段到 stdout；nl 为 true 时末尾补换行（用于整条消息）。 */
export function out(color: keyof typeof C, s = '', nl = false): void {
    process.stdout.write(paint(color, s) + (nl ? '\n' : ''));
}

/** 按颜色向 stderr 写一行（补换行），用于报错。 */
export function err(color: keyof typeof C, s: string): void {
    process.stderr.write(paint(color, s) + '\n');
}
