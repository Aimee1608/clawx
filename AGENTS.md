# AGENTS.md

> 这份文件是给 **agent** 看的:如果用户把 clawx 仓库交给你、让你帮他配置上手,**按本文从头到尾走一遍**。需要用户提供的信息(飞书 app 凭据等)就停下来问他,其余能自动做的你直接做。
> 人类读者要分步手册请看 [README.md](./README.md) 和 [docs/lark-bot-setup.md](./docs/lark-bot-setup.md)。

## 这是什么

clawx 把 Claude Code 跑成**持久会话**,从终端 tmux、飞书(Lark)话题、内嵌 web 三端共用同一个会话。两种形态:

- **solo** — 单 agent:一个 claude(或 codex)会话跑在持久化 tmux 里,需要一个常驻 **daemon**(靠飞书长连接收私聊/事件)。
- **room** — 多 agent 协作房间(基于 Claude Code 原生 Agent Teams),每个 bot 一个独立飞书身份,**不需要 daemon**(每个房间是独立 bridge 进程)。

**开工前先问用户:要 solo、room、还是都要?** —— 这决定需要几个飞书 app(见第 3 步)。

## 配置 SOP(按顺序执行)

### 第 0 步:认清你能做 / 不能做
- ✅ 你能自动做:检查/装依赖、`pnpm build`、写 config 文件、装 hook、跑 `clawx doctor`、起 daemon、验证连通。
- ❌ 你**不能**做:**在飞书后台创建 app、申请权限** —— 飞书平台不开放用 API 建应用(防滥用)。这步只能用户手动去 [open.feishu.cn](https://open.feishu.cn/app) 点。你的职责是告诉他**建几个、开哪些权限**,然后**等他把 App ID / Secret / 群 chat_id 给你**,再继续。

### 第 1 步:环境前置(你执行)
逐项检查并报告结果,缺什么指导用户装什么:
```bash
node -v              # 需 ≥ 20
pnpm -v              # 需要 pnpm
tmux -V              # 需要 tmux
claude --version     # 需要 Claude Code CLI;没有 → https://claude.com/claude-code
```

### 第 2 步:装 clawx(你执行)
```bash
pnpm install
pnpm build           # tsc → dist/
```
让 `clawx` 成为全局命令,**二选一**:
- **(推荐)本地 wrapper** `~/.local/bin/clawx`(保证 PATH 里能直接 `clawx`,且方便挂机器特定环境变量):
  ```sh
  #!/bin/sh
  exec node "$HOME/<clawx 仓库路径>/dist/cli.js" "$@"
  ```
  `chmod +x ~/.local/bin/clawx`,确保 `~/.local/bin` 在 PATH。
- 或 `pnpm link --global`。

> ⚠️ **代理坑(中国大陆 / 公司内网常见)**:clawx 默认只在 proxy 变量为空时填默认值、**不会动用户已有的 proxy**。如果用户启动的 shell 注入了一个**到不了 `api.anthropic.com` 的代理**(clawx 继承后 claude 就连不上),在**本地 wrapper 或 shell rc** 里设 `CLAWX_OVERRIDE_PROXY_PATTERN=<匹配那个代理 host 或端口的正则>`,clawx 启动时会把匹配到的继承代理强制替换成可用目标(默认 `http://127.0.0.1:7890`,可用 `CLAWX_PROXY_URL` 改)。**这是机器特定配置,放本地、绝不提交进仓库。**

### 第 3 步:飞书 app(用户手动建,你负责引导)
按第 0 步 —— app 只能用户手动建。告诉他:
- **solo** 需 **1 个** app;**room** 每个 bot 身份 1 个 app(默认 3 个:队长 / 主案 / 质询)。
- 建 app → 开权限 → 开机器人能力 → 开长连接(事件订阅) → 建群拉 bot 的**完整步骤 + 权限清单**都在 **[docs/lark-bot-setup.md](./docs/lark-bot-setup.md)**。让用户照着做,做完把这些交给你:
  - 每个 app 的 **App ID(`cli_...`)+ App Secret**
  - 话题群的 **chat_id(`oc_...`)**

### 第 4 步:写配置(你执行)
拿到凭据后,**直接写 config 文件**(比交互式 `clawx init` 更可控、可复核):

**solo / daemon → `~/.config/clawx/config.json`**
```json
{
  "larkAppId": "cli_xxx",
  "larkAppSecret": "xxx",
  "tmuxThreadChatId": "oc_xxx",
  "claudeCwd": "/绝对路径/默认工作目录"
}
```
可选字段:
- `tmuxThreadChats` — 命名群组,如 `{"dev":"oc_aaa","life":"oc_bbb"}`,起会话时用 `--group <名>` 选哪个群。
- `userOpenId` — 你的 open_id(@ 你用;通常首条私聊会自动学到、回写,可不填)。
- `tmuxProgressEmoji` — 进度反应表情。

**room → `~/.config/clawx/lark-apps.json`** — schema 见 [docs/lark-bot-setup.md](./docs/lark-bot-setup.md) 第 6 步;或让用户跑交互式 `clawx room init`(会逐个校验 token、探 bot open_id 并写文件)。

> 文件权限设 `0600`(含 secret)。**不要把这些 config 提交进任何仓库。**

### 第 5 步:装 hook(你执行)
claude 每次回复后,靠这个 hook 把结果回写给 daemon、fanout 到飞书:
```bash
clawx install-tmux-hook       # 注册 Stop / UserPromptSubmit hook 到 ~/.claude/settings.json
clawx install-codex-hook      # 仅当用户要用 codex 后端
```
> ⚠️ **`install-tmux-hook` 的 hook 管理有两个坑,装完务必核对 `~/.claude/settings.json`:**
> 1. **不覆盖旧 hook**:如果已有别的 tmux-hook(旧版本 / 同机另一个类似工具),它出于幂等**不替换** —— 跑了也没用,claude 还在调旧的。
> 2. **会叠加重复**:如果已有一条指向本仓库的 hook、又用不同路径写法(如 `~/...` vs 绝对路径软链)再装一次,它会**再加一条** —— 两条都执行,结果**飞书每条回复发两遍**。
>
> 所以装完**一定要核对**:`hooks.Stop` 和 `hooks.UserPromptSubmit` 下,各应**只有一条** `command` 指向**本仓库的 `dist/cli.js tmux-hook`**。多了删到只剩一条、没有就加、指错(指向别的工具)就改。改 settings.json 前先备份。

### 第 6 步:验证 + 起会话(你执行)
```bash
clawx doctor          # 自检:claude CLI / 代理 / config 文件
```
> `doctor` 里 `OAUTH_TOKEN` 那个 `!` 只影响**已废弃的 web chat**,对 solo/room/飞书用法无影响,可忽略。

- **solo**:`clawx daemon start` → `clawx daemon logs` 里出现 `ws connect success` = 飞书长连接通了 → `clawx solo [cwd]` 起会话。
- **room**:`clawx room . --template dev --brief "你的议题"`(`clawx room templates` 看可用模板)。
- **最终验证**:在飞书对应群里 @ bot 说句话 —— **收到回复 = 全链路打通**。

## 常见坑(配置时最容易卡的)
- **claude 连不上 API / shell 注入了公司代理** → 第 2 步的 `CLAWX_OVERRIDE_PROXY_PATTERN`;或用 `CLAWX_DISABLE_PROXY_INJECT=1` 完全不碰 proxy。
- **飞书收不到消息** → 权限改了没**重新发版本** / bot 没拉进群 / solo 没开长连接(事件订阅)。
- **hook 装了飞书还是不回复** → 多半 hook 没指向本仓库(第 5 步的覆盖问题),或 daemon 没起。
- **要和已有实例并存**(用户已经在跑另一套 clawx/类似工具) → 设 `CLAWX_BRAND=<名>` 跑完全隔离的实例(独立 config / data / tmux 前缀),端口用 `CLAWX_WEB_PORT` 错开(默认 `8124`)。
- 全部环境变量见 [README.md](./README.md) 的「环境变量速查」。
