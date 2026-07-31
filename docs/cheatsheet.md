# clawx 操作速查

三端(飞书话题 / 终端 CLI / web 看板)共用同一个会话。下面按「你在哪」分组。

> 约定:`<sid>` = 会话 id(形如 `cli-tmux-1a2b3c4d`);`<别名>` = 你在 config 里配的目录别名。

## 一、飞书「话题内」控制词

在某个会话的话题里发。**必须整条消息就是这个词、且不带图片**才触发,否则当普通 prompt。

| 发送 | 作用 |
|---|---|
| `esc` | 中断当前回合(等价终端按 Esc),打断跑飞了的一轮 |
| `/kill` | 关闭该会话(= `clawx kill <sid>`:杀 tmux + 删记录 + 话题发 🧹) |
| 其它文字 / 图片 | 作为 prompt 发给这个会话的 claude / codex |

## 二、飞书「私聊 bot」建 / 管理会话

| 发送 | 作用 |
|---|---|
| `/new <别名> [label]` | 用目录别名建会话,如 `/new riff 修登录bug` |
| `/new` | 列出所有目录别名 + 对应路径 |
| `/new-tmux <完整路径> [label]` | 用完整路径建会话 |
| 自然语言(如「起个 xxx 会话 / 清理某会话」) | 交给 DM agent 处理 |

目录别名在 `~/.config/clawx/config.json` 的 `tmuxDirs` 里配:

```json
"tmuxDirs": {
  "riff":   "/path/to/agent-monorepo",
  "bridge": "/path/to/migrate-tools"
}
```

## 三、终端 CLI(`clawx …`)

### 建会话

```
clawx solo <别名|cwd>          起会话并 attach(Ctrl-b d 退出)
  --label "标题"               话题标题
  --group <名>                 话题落到命名群(config.tmuxThreadChats)
  --agent codex                用 codex 而非默认 claude
  --effort <level>             claude 思考等级(仅 claude,见下)
  --resume <uuid>              恢复被杀的会话,保留上下文
```

`--effort` 取值(浅 → 深):`low` / `medium` / `high` / `xhigh` / `max` / `ultracode`
按会话生效、结束即失效,不改全局 settings。codex 会话忽略此参数。

### 管理

```
clawx kill <sid|rid>           关会话或 room(统一入口)
clawx tmux ls                  列出所有 tmux 会话
clawx tmux kill <sid>          杀单个
clawx tmux prune               清理已失效的记录
```

### daemon / 诊断

```
clawx daemon start|stop|status|logs   常驻进程(飞书长连接靠它)
clawx doctor                          自检:claude CLI / 代理 / config
clawx install-tmux-hook               装回写 hook(claude 答完回写飞书)
clawx install-codex-hook              codex 后端的 hook
```

### room(多 agent 协作,基于 Agent Teams)

```
clawx room . --template <名> --brief "议题"
clawx room ls | kill <rid> | revive | templates | prune
```

## 四、tmux 快捷键(终端 attach 后)

| 按键 | 作用 |
|---|---|
| `Ctrl-b` `d` | detach —— 退出终端但会话继续后台跑(最常用) |
| `Ctrl-b` `[` | 进滚动 / 复制模式看历史(`q` 或 `Enter` 退出) |
| `Esc` | 中断 claude 当前回合 |

## 五、web 看板(`http://<主机ip>:8124`)

- 会话卡片 / 详情抽屉里的芯片:点一下**复制** session id、`tmux attach` 命令、或飞书 thread_id。
- 详情页 **Raw** 按钮:切换查看该会话 tmux pane 的实时画面(`capture-pane` 快照)。

## 一句话对照:三端等价操作

| 操作 | 飞书 | 终端 |
|---|---|---|
| 建会话 | `/new <别名>` | `clawx solo <别名>` |
| 关会话 | 话题里发 `/kill` | `clawx kill <sid>` |
| 中断当前回合 | 话题里发 `esc` | pane 里按 `Esc` |
