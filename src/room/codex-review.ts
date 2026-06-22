// codex 异质审查:claude 们(Agent Teams)辩论收敛后,把结论喂给 codex
// (不同训练的模型)做一次异质把关,破 claude 的同质盲区。
//
// codex 进不了 Claude Agent Teams,所以这里不维护 codex 会话 —— 直接
// `codex exec` 一次性调用,最终回答用 `-o <file>` 落盘读回(stdout 混了
// 版本/workdir/tokens 等元信息,不可靠)。--ephemeral 不留 session,
// --skip-git-repo-check 容忍非 git 的内容仓。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const REVIEW_PROMPT = `你是一个异质审查者,用的是和 claude 不同训练的模型(gpt 系)。下面是一组 claude agent 辩论 / 协作后得出的结论或方案。请用你的视角审查,重点找 claude 们可能因为同质思维一起漏掉的东西:
1. 关键漏洞 / 站不住脚的假设;
2. 边界、失败、并发、错误处理上的坑;
3. 是否真的满足了原始需求(而不是答了个相近但不对的问题)。
要求:具体、指得到哪一条,别空泛附和;只挑真问题,没问题就说没问题。

最后必须单独起一行给裁决(二选一):
- 没有必须修正的硬伤 → 写 \`VERDICT: PASS\`
- 有 P0 级硬伤(会导致错误结果 / 不满足需求)→ 写 \`VERDICT: BLOCK\`

待审内容:
`

export interface CodexReviewResult {
  ok: boolean
  /** codex 的审查意见全文 */
  text: string
  verdict: 'PASS' | 'BLOCK' | 'UNKNOWN'
  error?: string
}

export interface CodexReviewOpts {
  codexCmd?: string
  timeoutMs?: number
}

/** Parse the trailing VERDICT line of a codex review. BLOCK wins over PASS
 * when both somehow appear; neither present → UNKNOWN. */
export function parseVerdict(text: string): CodexReviewResult['verdict'] {
  if (/VERDICT:\s*BLOCK/i.test(text)) return 'BLOCK'
  if (/VERDICT:\s*PASS/i.test(text)) return 'PASS'
  return 'UNKNOWN'
}

/** Run a one-shot heterogeneous review of `content` via `codex exec`.
 * Resolves (never rejects) with the review text + parsed verdict. */
export async function runCodexReview(
  cwd: string,
  content: string,
  opts: CodexReviewOpts = {},
): Promise<CodexReviewResult> {
  const codexCmd = opts.codexCmd ?? process.env.CODEX_CMD ?? 'codex'
  const outFile = path.join(os.tmpdir(), `clawx-codex-review-${randomUUID().slice(0, 8)}.txt`)
  const prompt = REVIEW_PROMPT + content

  return new Promise<CodexReviewResult>((resolve) => {
    let settled = false
    const finish = (r: CodexReviewResult): void => {
      if (settled) return
      settled = true
      try {
        fs.rmSync(outFile, { force: true })
      } catch {
        /* best-effort */
      }
      resolve(r)
    }

    const child = spawn(
      codexCmd,
      [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '--ephemeral',
        '-C',
        cwd,
        '-o',
        outFile,
        prompt,
      ],
      // stdin ignored so codex doesn't block waiting on it; stdout carries
      // noisy progress we don't read (answer comes from -o); stderr kept
      // for diagnostics.
      { cwd, env: process.env, stdio: ['ignore', 'ignore', 'pipe'] },
    )

    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ ok: false, text: '', verdict: 'UNKNOWN', error: 'codex 审查超时' })
    }, opts.timeoutMs ?? 300_000)

    child.stderr?.on('data', (d) => (err += String(d)))
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, text: '', verdict: 'UNKNOWN', error: e.message })
    })
    child.on('close', () => {
      clearTimeout(timer)
      let text = ''
      try {
        text = fs.readFileSync(outFile, 'utf8').trim()
      } catch {
        /* no output file */
      }
      if (!text) {
        finish({ ok: false, text: '', verdict: 'UNKNOWN', error: err.trim().slice(-400) || 'codex 无输出' })
        return
      }
      finish({ ok: true, text, verdict: parseVerdict(text) })
    })
  })
}
