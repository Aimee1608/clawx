import chalk from 'chalk'

const ts = (): string => new Date().toISOString().slice(11, 23)

function fmtMeta(meta: unknown): string {
  if (meta === undefined || meta === null) return ''
  try {
    return ' ' + chalk.gray(JSON.stringify(meta))
  } catch {
    return ' ' + chalk.gray(String(meta))
  }
}

export const log = {
  info(msg: string, meta?: unknown): void {
    console.log(chalk.cyan(`[${ts()}] INFO`), msg + fmtMeta(meta))
  },
  warn(msg: string, meta?: unknown): void {
    console.log(chalk.yellow(`[${ts()}] WARN`), msg + fmtMeta(meta))
  },
  error(msg: string, meta?: unknown): void {
    console.log(chalk.red(`[${ts()}] ERR `), msg + fmtMeta(meta))
  },
  debug(msg: string, meta?: unknown): void {
    console.log(chalk.gray(`[${ts()}] DBG `), msg + fmtMeta(meta))
  },
  task(event: string, taskId: string, detail?: string): void {
    const tag = event.toUpperCase().padEnd(8)
    console.log(
      chalk.green(`[${ts()}] ${tag}`),
      chalk.bold(taskId),
      detail ? chalk.gray(detail) : '',
    )
  },
}
