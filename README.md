# OpenCode PPT Studio (Next.js)

一个最小可跑通的 Demo：

- 前端：网页输入 PPT 主题/语言/页数/受众/风格
- 后端：使用 `@opencode-ai/sdk` 创建/连接 opencode server，并驱动 LLM 生成 `deck.pptx`
- 预览：生成 `thumbnails.jpg`，页面直接展示

## 运行

```bash
cd web
npm run dev
```

打开 http://localhost:3000

生成产物会写到：`web/workspace/jobs/<jobId>/`

## 环境变量（可选）

你可以让 Web 后端连接已有的 opencode server：

- `OPENCODE_BASE_URL=http://localhost:4096`

或者让 Web 后端自动启动一个 opencode server（默认 hostname=127.0.0.1, port=4096）。

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

## LLM 配置

页面底部提供 LLM 配置表单：

- `GET /api/opencode/config` -> 读取（apiKey 会脱敏）
- `POST /api/opencode/config` -> 写入 `web/opencode.json`
- `POST /api/opencode/reload` -> 重载（重启内嵌 opencode server，使配置立即生效）

PPT 生成时使用的模型在页面表单中选择（provider/model），后端会在每次 `session.prompt` 时指定。
