# OpenCode PPT Studio (Next.js)

一个最小可跑通的 Demo：

- 前端：Next.js + MUI（Material UI），网页输入 PPT 主题/语言/页数/受众/风格
- 后端：使用 `@opencode-ai/sdk` 创建/连接 opencode server，并驱动 LLM 生成 `deck.pptx`
- 预览：生成 `thumbnails.jpg`，页面直接展示

## 运行

```bash
cd web
npm install
npm run dev
```

打开 http://localhost:3000

生成产物会写到：`web/workspace/jobs/<jobId>/`

生产构建：

```bash
cd web
npm run build
```

## 环境变量（可选）

你可以让 Web 后端连接已有的 opencode server：

- `OPENCODE_BASE_URL=http://localhost:5937`

或者让 Web 后端自动启动一个 opencode server（默认 hostname=127.0.0.1, port=5937）。
如果端口被占用，后端会自动向上递增端口进行重试（例如 5937 -> 5938 -> 5939）。

为了避免服务裸奔，内嵌 server 默认会设置密码：

- `OPENCODE_SERVER_PASSWORD=oc-ppt-agent`

Web 后端会用该密码以 HTTP Basic 的方式访问 opencode server：

- 用户名固定为 `opencode`
- 密码为 `OPENCODE_SERVER_PASSWORD`

你可以通过环境变量覆盖端口/密码：

- `OPENCODE_PORT=5937`
- `OPENCODE_PORT_MAX_TRIES=20`（端口占用时最多重试次数）
- `OPENCODE_SERVER_PASSWORD=oc-ppt-agent`

指定模型（如果你想固定某个 provider/model）：

- `OPENCODE_MODEL_PROVIDER=anthropic`
- `OPENCODE_MODEL_ID=claude-3-5-sonnet-20241022`

## API

- `POST /api/ppt/jobs` -> `{ jobId }`
- `GET /api/ppt/jobs/:jobId` -> 状态/日志/下载链接
- `POST /api/ppt/jobs/:jobId/approve` -> 提交确认（可带编辑后的 outlineMarkdown）并开始生成 PPTX
- `GET /api/ppt/jobs/:jobId/events` -> SSE 推进度
- `GET /api/ppt/jobs/:jobId/pptx` -> 下载 pptx
- `GET /api/ppt/jobs/:jobId/thumbnails` -> 预览缩略图

## 任务恢复与 LLM 会话（sessionId）

每个 PPT 任务会创建 opencode session，并把 `sessionId` 持久化到
`workspace/jobs/<jobId>/job.json`。这意味着：

- 点击“使用该大纲生成 PPT”（approve）时，后端会清空旧的 `sessionId`，并在新的 session 中进行 PPT/HTML slides 生成与自动修复。
- 同一次生成流程内（生成 -> 校验 -> 多轮修复 -> 渲染/调整），默认都会复用同一个 `sessionId`，让 LLM 能延续上下文。
- 在页面里使用“继续之前的任务”加载旧任务后，只要该任务的 `job.json` 里存在 `sessionId`，继续调整/渲染会接着之前的会话继续。
- 只有当 `sessionId` 缺失（例如旧任务未写入、状态文件损坏/被清理）时，后端才会为该 job 创建新的 session。

## LLM 配置

页面右上角导航栏（Nav）提供入口：点击 "LLM 配置" 打开对话框（Dialog）。默认不显示。

- `GET /api/opencode/config` -> 读取（apiKey 会脱敏）
- `POST /api/opencode/config` -> 写入 `web/opencode.json`
- `POST /api/opencode/reload` -> 重载（重启内嵌 opencode server，使配置立即生效）

PPT 生成时使用的模型在页面表单中选择（provider/model），后端会在每次 `session.prompt` 时指定。
