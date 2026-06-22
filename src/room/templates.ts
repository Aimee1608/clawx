// Room templates: build the lead's opening prompt as a SANDWICH —
//   ① mechanism header (code-fixed, shared by every template): team name,
//      the two teammate names proposer/challenger, model tier, language.
//      Users can't touch this, so a custom template can't break the bridge's
//      jsonl matching or the Feishu bot mapping.
//   ② scene layer (the template FILE the user writes): what proposer /
//      challenger actually do in this scenario, the flow, the deliverable,
//      and what counts as done.
//   ③ universal discipline footer (code-fixed): the kick-off confirmation
//      gate, verbatim-requirement, @-attention convention, stay-idle rule.
//
// Templates resolve by name, project dir first then global:
//   <cwd>/.forge/templates/<name>.md          (per content repo)
//   ~/.config/clawx/templates/<name>.md (cross-project)
//   built-in 'design'                          (last-resort fallback)
import fs from 'node:fs'
import path from 'node:path'

import { configDir } from '../config.js'

export interface TemplateInfo {
  name: string
  source: 'project' | 'global' | 'builtin'
  path?: string
  description: string
  /** the scene-layer body (placeholders not yet substituted) */
  body: string
  /** frontmatter `codexReview: true` — after claude converges, codex does
   * a heterogeneous review (借质询身份发), BLOCK 打回再议。 */
  codexReview?: boolean
}

// Built-in default: open discussion / decision debate. Kept in code so a
// room can always launch even with zero template files on disk.
const BUILTIN_DESIGN = `本场景是开放式讨论 / 方案拍板:
- proposer(主案):给出完整提案,立场明确、理由有分量,用 SendMessage 发给 challenger;
- challenger(质询):至少两轮认真、有技术含量的反驳,目标是把提案锤扎实,而不是为反对而反对;
- proposer 逐条回应(该认的认、该守的守),持续到双方达成一致(可以是修正方案或带条件的结论);
- 达成一致后,由 proposer 用 SendMessage 把最终结论(含双方各自被采纳的关键论点)发给你,你再用一段话总结。`

const BUILTIN_DESIGN_DESC = '通用协作 / 方案拍板(内置默认)'

function templateDirs(cwd: string): { dir: string; source: 'project' | 'global' }[] {
  return [
    { dir: path.join(cwd, '.forge', 'templates'), source: 'project' },
    { dir: path.join(configDir(), 'templates'), source: 'global' },
  ]
}

/** Parse an optional `--- description / codexReview ---` frontmatter. */
export function parseTemplate(raw: string): { description: string; codexReview: boolean; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (m && m[1] && m[2] !== undefined) {
    const dm = m[1].match(/description:\s*(.+)/)
    const codexReview = /codexReview:\s*true/i.test(m[1])
    return { description: dm?.[1]?.trim() ?? '', codexReview, body: m[2].trim() }
  }
  return { description: '', codexReview: false, body: raw.trim() }
}

/** Resolve a template by name. Returns null if a named (non-design) template
 * isn't found anywhere — callers surface that as an error. `design` always
 * resolves (built-in fallback when no file overrides it). */
export function loadTemplate(name: string, cwd: string): TemplateInfo | null {
  for (const { dir, source } of templateDirs(cwd)) {
    const file = path.join(dir, `${name}.md`)
    if (fs.existsSync(file)) {
      const { description, codexReview, body } = parseTemplate(fs.readFileSync(file, 'utf8'))
      return { name, source, path: file, description: description || `(${source})`, body, codexReview }
    }
  }
  if (name === 'design') {
    return { name: 'design', source: 'builtin', description: BUILTIN_DESIGN_DESC, body: BUILTIN_DESIGN }
  }
  return null
}

/** All available templates: project + global files, plus built-in design
 * if no file overrides it. Project shadows global on name collision. */
export function listTemplates(cwd: string): TemplateInfo[] {
  const byName = new Map<string, TemplateInfo>()
  // Iterate global first, then project, so project overwrites on collision.
  for (const { dir, source } of [...templateDirs(cwd)].reverse()) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const name = f.slice(0, -3)
      const { description } = parseTemplate(fs.readFileSync(path.join(dir, f), 'utf8'))
      byName.set(name, { name, source, path: path.join(dir, f), description: description || `(${source})`, body: '' })
    }
  }
  if (!byName.has('design')) {
    byName.set('design', { name: 'design', source: 'builtin', description: BUILTIN_DESIGN_DESC, body: BUILTIN_DESIGN })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function fill(text: string, teamName: string, userName: string): string {
  return text.replace(/\{\{\s*teamName\s*\}\}/g, teamName).replace(/\{\{\s*userName\s*\}\}/g, userName)
}

function mechanismHeader(teamName: string): string {
  return [
    `你是一个多 agent 协作房间的 team-lead。`,
    ``,
    `【组队机制 · 不可更改】`,
    `- 创建 agent team,团队名必须叫「${teamName}」,用 split panes 模式;`,
    `- 固定 spawn 两个 teammate,名字必须叫 proposer 和 challenger(就用这两个名字,不要改名,否则身份与消息路由会错乱);`,
    `- teammate 必须使用与你相同(或 opus 级)的模型,不要用 Explore/haiku 等轻量类型;`,
    `- 全程用中文。`,
  ].join('\n')
}

function disciplineFooter(userName: string): string {
  return [
    `【通用纪律 · 不可更改】`,
    `1. 开工确认门:收到议题后不要直接组队。先发一段话给用户——①你理解的需求复述;②打算怎么做;③准备怎么分工——正文写「@${userName}」,等她确认或纠正后才 spawn teammate。**确认门要快**:只扫一眼议题本身就发,不要在确认前深读情报库/大文件、不要长时间分析(那是组队后 teammate 的活,你越权深读只会拖死自己);几句话说清你的理解和分工即可。只有议题里明确写了「免确认」才可跳过。`,
    `2. 派活带原话:spawn teammate 或派任务时,必须附上用户需求的原文全文,你的理解附在原文之后,原文不能省。`,
    `3. 成员间用 SendMessage 直接互发消息推进协作,不要事事经你中转;阶段性关键进展要汇总让用户知道。`,
    `4. 总结 / 交付后不要清理团队、不要让 teammate 退出,保持 idle 待命,等用户检查或追问。`,
    `5. 用户(飞书名 ${userName})可能随时插话,消息会标「来自 ${userName}」,她的意见优先级最高;标「来自 ${userName}·群发」是发给所有人的,与你角色直接相关才详细回应,否则简短知会或保持安静,避免抢答。`,
    `6. @提醒约定:需要 ${userName} 本人介入(确认需求、看结论、验收产物、补充信息、拍板分歧)时,正文必须写「@${userName}」;阶段性节点和最终交付的汇报也要带;不需要她看的过程消息不要写,避免打扰。`,
  ].join('\n')
}

export interface LeadPromptOpts {
  /** the template's scene-layer body */
  sceneBody: string
  teamName: string
  userName?: string
  /** the brief; empty/undefined = standby (user describes the topic later) */
  topic?: string
}

/** Assemble the full lead prompt: mechanism + scene + discipline, wrapped
 * in either a with-topic opener or the standby preamble. */
export function buildLeadPrompt(opts: LeadPromptOpts): string {
  const userName = opts.userName ?? '用户'
  const scene = fill(opts.sceneBody, opts.teamName, userName).trim()
  const sandwich = [
    mechanismHeader(opts.teamName),
    ``,
    `【本场景的协作方式】`,
    scene,
    ``,
    disciplineFooter(userName),
  ].join('\n')

  if (opts.topic && opts.topic.trim()) {
    return [
      `议题:${opts.topic.trim()}`,
      ``,
      sandwich,
      ``,
      `现在从【开工确认门】开始:先发「需求复述 + 方案 + 分工」给用户确认,不要直接组队。`,
    ].join('\n')
  }
  return [
    sandwich,
    ``,
    `【当前状态:待命】`,
    `议题还没定。用户(飞书名 ${userName})接下来会用标「来自 ${userName}」的消息描述议题。`,
    `- 议题不清晰就先提问澄清(直接文本回复即可,不要调用任何交互式提问工具);`,
    `- 议题明确后走上面的【开工确认门】:先发需求复述 + 方案 + 分工,她确认后才组队;`,
    `- 在她确认之前,绝对不要 spawn 任何 teammate。`,
  ].join('\n')
}
