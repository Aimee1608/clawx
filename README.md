# clawx

把 Claude Code 跑成**持久会话**的编排器:单 agent 会话 + 多 agent 协作房间,从终端、飞书(Lark)、内嵌 web 三端共用同一个会话。

## 是什么

- **`clawx solo`** — 单 agent:把一个 claude(或 codex)会话跑在持久化 tmux 里,从终端、飞书话题、web 三端共用同一个 REPL。带 Stop-hook 回写、reactions 进度提示、cron 定时。
- **`clawx room`** — 多 agent:基于 Claude Code 原生 Agent Teams 的协作房间,多个 agent(各有独立飞书 bot 身份)在飞书话题里对话、辩论,你随时插话。按**场景模板**(开发 / code review / 异常定位 / 头脑风暴 …)定制角色与流程。

## 特性

- 三端互通:终端 tmux ↔ 飞书话题 ↔ web(查看历史)
- 单 + 多 agent 统一在一个 CLI 下
- claude + codex(异质模型)双后端
- 回合内流式(opt-in):claude 的中间叙述块实时投递到飞书,过程块(青绿 💭 卡)与最终答复(蓝色卡)一眼区分
- cron 定时任务(定时跑 prompt / 提醒 / 扫描)
- 场景模板系统(项目级 `.forge/templates/` + 全局)
- DM agent:飞书私聊里直接对话、让 bot 自己管理会话

## 前置

- Node ≥ 20、pnpm、tmux
- [Claude Code CLI](https://claude.com/claude-code)(`claude`)
- 飞书自建应用:`solo` 需 1 个 app;`room` 多 bot 身份需多个(默认 3)个 app。**怎么建 app、开哪些权限、填配置 → 见 [docs/lark-bot-setup.md](./docs/lark-bot-setup.md)**

## 安装

**从 npm(推荐)**

```bash
npm i -g @aimee1608/clawx       # 全局安装,命令为 `clawx`
# 或免安装试用:npx @aimee1608/clawx --help
```

**从源码(开发 / 二次开发)**

```bash
git clone https://github.com/Aimee1608/clawx.git
cd clawx
pnpm install
pnpm build            # tsc → dist/
pnpm link --global    # 装全局 `clawx` 命令
```

装好后配置:

```bash
clawx init          # 交互式配置 solo 的飞书 app / chat / 工作目录
clawx doctor        # 环境自检
clawx room init     # room 多 bot fleet 交互配置(校验 token + 探 open_id → lark-apps.json)
```

## 用法

### 单 agent

```bash
clawx solo [cwd]                # 新建会话并接管当前终端(tmux)
clawx solo --resume <uuid>      # 续接已有 claude 会话
clawx solo --agent codex [cwd]  # 用 codex 作后端
clawx solo ls | kill <id> | prune
clawx daemon start | stop | status | logs   # 后台常驻(飞书长连接)
clawx web                       # 打开 web(查看会话与历史)
```

### 多 agent

```bash
clawx room . --template dev --brief "给 X 模块加缓存"   # 开发房
clawx room . --template code-review --brief-file pr.md  # 代码审查房
clawx room templates            # 列出可用模板
clawx room ls | revive | kill <rid> | prune
clawx room attach <rid>         # 重新进入某房间的 tmux
```

队长(team-lead)收到议题后先发「需求复述 + 方案 + 分工」@你确认,确认后才组队;辩论 / 协作过程镜像到飞书话题,你随时 @ 某个 bot 插话。

## 配置

> 飞书 app 怎么建、权限清单、配置字段 → **[docs/lark-bot-setup.md](./docs/lark-bot-setup.md)**

| 用途 | 位置 |
|---|---|
| 单 app(solo / daemon) | `~/.config/clawx/config.json`(`clawx init` 生成) |
| 多 bot fleet(room) | `~/.config/clawx/lark-apps.json`(手写,见 setup doc) |
| 场景模板 | 项目级 `<cwd>/.forge/templates/<名>.md`,全局 `~/.config/clawx/templates/<名>.md` |
| 代理 | 默认 `http://127.0.0.1:7890`,用 `CLAWX_PROXY_URL` 覆盖 |
| web/daemon 端口 | 默认 `8124`(避开旧版 clawbot 的 `8123`,两者可并存),用 `CLAWX_WEB_PORT` 覆盖 |

**多实例隔离**:设 `CLAWX_BRAND=<名>` 可跑一个完全隔离的实例(独立 config / data / tmux 前缀),和默认实例互不干扰 —— 适合拿一个一次性 brand 做开发 / 测试。

## 环境变量速查

全部可选,代码都有合理默认;个人 / 机器特定的值建议放本地 wrapper 或 shell rc,别写进仓库。

**实例 / 路径**
| 变量 | 作用 | 默认 |
|---|---|---|
| `CLAWX_BRAND` | 实例品牌,隔离 config/data/tmux | `clawx` |
| `CLAWX_DATA_DIR` | 数据根目录 | `~/.local/share/<brand>` |
| `CLAWX_SESSIONS_PATH` | solo 会话存储路径(空串 = 纯内存) | 数据目录下 |

**代理**(claude API 通道)
| 变量 | 作用 | 默认 |
|---|---|---|
| `CLAWX_PROXY_URL` | http(s) 代理目标 | `http://127.0.0.1:7890` |
| `CLAWX_NO_PROXY` | no_proxy 列表 | 含 localhost / 飞书域名 |
| `CLAWX_OVERRIDE_PROXY_PATTERN` | 正则,强制替换匹配到的继承代理(治公司代理漏入) | 空(不强制) |
| `CLAWX_DISABLE_PROXY_INJECT` | `1` = 完全不碰 proxy | — |

**web / daemon**
| 变量 | 作用 | 默认 |
|---|---|---|
| `CLAWX_WEB_PORT` | web / daemon 端口 | `8124` |
| `CLAWX_WEB_HOST` | 绑定地址(设 `127.0.0.1` 限本机) | `0.0.0.0` |
| `CLAWX_WEB_PUBLIC_URL` | DM 深链用的公网 URL | — |

**飞书 / tmux**
| 变量 | 作用 |
|---|---|
| `CLAWX_TMUX_THREAD_CHAT_ID` | solo 新会话默认话题群 chat_id |
| `CLAWX_LARK_CHAT_ID` | room chat_id 兜底(lark-apps 没配时) |
| `CLAWX_USER_OPEN_ID` | 你的 open_id(@ 你用;通常首条 DM 自动学到) |
| `CLAWX_TMUX_PROGRESS_EMOJI` | 进度反应表情(默认 `THINKING`) |
| `CLAWX_TMUX_CMD` | tmux 二进制(默认 `tmux`) |

**回合内流式**(claude 中间块实时投递,默认关)
| 变量 | 作用 | 默认 |
|---|---|---|
| `CLAWX_STREAM_REPLIES` | `1` = 开启回合内流式中间回复 | 关 |
| `CLAWX_STREAM_POLL_MS` | transcript 轮询间隔 | `700` |
| `CLAWX_STREAM_TAIL_BYTES` | 每次只读 transcript 尾部窗口(控内存) | `524288`(512KB) |
| `CLAWX_STREAM_MAX_MS` | 单回合流式兜底上限 | `1800000`(30min) |
| `CLAWX_CARD_TITLE_CELLS` | 飞书回复卡片标题宽度预算(中文/emoji 算 2 宽) | `46` |

**其他**
| 变量 | 作用 |
|---|---|
| `CLAWX_REPL_WATCHDOG_MS` | REPL 看门狗轮询间隔(默认 `60000`) |
| `CLAWX_DISABLE_CRON` | `1` = 关掉 cron 调度 |
| `CLAWX_CODEX_HOOK_DUMP` | codex hook 调试转储(开发用) |

## 许可

[MIT](./LICENSE)
