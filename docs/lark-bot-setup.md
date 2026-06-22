# 飞书(Lark)应用配置

clawx 通过飞书自建应用收发消息。**solo / daemon 需要 1 个 app**;**room 每个 bot 身份需要 1 个 app**(默认 3 个:队长 / 主案 / 质询)。

> 飞书平台**不开放用 API 创建应用 / 申请权限**(防滥用),所以下面第 1~4 步必须在开发者后台手动点一遍(约 10 分钟)。建完之后,建群、拉 bot、探测 open_id、写配置都能自动化。

---

## 1. 创建自建应用

1. 打开 [open.feishu.cn](https://open.feishu.cn/app) → **创建企业自建应用**(每个 bot 身份建一个;room 建 3 个,名字随意,如 队长/主案/质询)。
2. 进应用 → **凭证与基础信息** → 记下 **App ID**(`cli_xxx`)和 **App Secret**。

## 2. 开权限(权限管理 → 勾选 → 创建版本发布)

在「权限管理」里搜并勾选(scope 名以后台搜索结果为准,下面是关键词):

| 关键词 | 用途 | solo | room |
|---|---|---|---|
| `im:message` 接收/读取消息 | 收消息 | ✅ | ✅ |
| `im:message:send_as_bot` 以应用身份发消息 | 发消息 | ✅ | ✅ |
| `im:chat` 群组管理 | room 自动建话题群、拉 bot 进群 | — | ✅ |
| `im:resource` 获取消息中的资源 | 图片/文件解析(发图给 agent) | ✅ | ✅ |
| `contact:user.base:readonly` 读用户基本信息 | 可选,@ 用户体验更好 | 可选 | 可选 |

勾完点 **创建版本** → 发布。自建应用通常企业管理员一键通过(或自动)。**权限改了要重新发版本才生效**。

## 3. 开机器人能力

应用能力 → **添加「机器人」**。

## 4. 事件订阅(长连接)

事件与回调 → 订阅方式选 **长连接(WSClient)**。

- **solo / daemon**:必须开(daemon 靠长连接收私聊 DM)。
- **room**:不依赖事件(room 用轮询读话题),开着也无害。

## 5. 建群 + 拉 bot 进群

- **room**:建一个群,群设置里**开启「话题」模式**,把 3 个 bot 全部拉进去。群的 `chat_id`(`oc_xxx`)填到 `lark-apps.json` 的 `topicChatId`。
- **solo**:把 1 个 bot 拉进一个群(或直接私聊),群 `chat_id` 填到 config 的 `tmuxThreadChatId`。

> 拿 `chat_id`:群里 @bot 发条消息,看 clawx 日志里的 chatId;或用飞书「群信息」API。

---

## 6. 写配置

### solo / daemon → `~/.config/clawx/config.json`

跑 `clawx init` 交互生成(会问 App ID / Secret / 群 chat_id / 工作目录),或手写:

```json
{
  "larkAppId": "cli_xxx",
  "larkAppSecret": "xxx",
  "tmuxThreadChatId": "oc_xxx",
  "claudeCwd": "/path/to/workspace"
}
```

### room → `~/.config/clawx/lark-apps.json`

**推荐 `clawx room init` 交互生成**(问 chat_id + 3 个 app secret → 逐个校验 token、探 open_id、写文件);或手写:

```json
{
  "topicChatId": "oc_xxx",
  "reader": "lead",
  "roleMap": {
    "team-lead": "lead",
    "proposer": "proposer",
    "challenger": "challenger"
  },
  "apps": {
    "lead":       { "name": "队长", "appId": "cli_xxx", "appSecret": "xxx" },
    "proposer":   { "name": "主案", "appId": "cli_xxx", "appSecret": "xxx" },
    "challenger": { "name": "质询", "appId": "cli_xxx", "appSecret": "xxx" }
  },
  "userName": "你的飞书名",
  "userAliases": ["你的别名"]
}
```

- `reader`:用哪个 app 轮询读话题消息(填 `lead` 即可)。
- `roleMap`:成员名 → app key 的映射,**键名固定**用 `team-lead` / `proposer` / `challenger`。
- `botOpenIds`(每个 bot 的 open_id)和 `userOpenId`(你本人的 open_id)**不用手填** —— clawx 启动时自动用 bot/v3/info 探测 bot open_id,你给任一 bot 发第一条消息时自动学到你的 open_id 并回写。

## 7. 自检

```bash
clawx doctor        # 检查 claude 二进制、代理、token 是否能换
```

---

## 常见问题

- **bot 收不到消息**:权限改了没重新发版本 / bot 没拉进群 / 长连接没开(solo)。
- **room 起来但 @ 不到人**:`userOpenId` 还没学到 —— 给任一 bot 发条消息即可自动写入。
- **图片解析不工作**:缺 `im:resource` 权限,或没重新发版本。
- **代理**:飞书 API 走直连(不走 mihomo);Claude API 默认走 `http://127.0.0.1:7890`,用 `CLAWX_PROXY_URL` 覆盖。
- **claude 连不上 API / 启动 shell 注入了公司代理**:clawx 默认只在 proxy 为空时填默认值,**不会动你已有的 proxy**。如果你启动的 shell 注入了一个到不了 `api.anthropic.com` 的公司代理(clawx 继承后 claude 就连不上),设 `CLAWX_OVERRIDE_PROXY_PATTERN=<匹配该代理 host/port 的正则>` —— clawx 启动时会把匹配到的继承代理强制替换成目标。**建议放在启动 clawx 的本地 wrapper 或 shell rc 里**(机器特定配置,别提交进仓库)。要整体关掉代理注入用 `CLAWX_DISABLE_PROXY_INJECT=1`。
