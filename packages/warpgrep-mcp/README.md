# @prophey/warpgrep-mcp

WarpGrep 风格的**自然语言代码搜索子代理**，做成独立的标准 MCP 服务（stdio、零依赖）。
模型不再自己瞎翻文件，而是告诉它"HTTP 路由在哪校验的？"，它去 grep / 列目录 / 读指定行，
几轮之后只返回**验证过存在**的 `path:start-end` 列表（可选附代码）。

后端默认 **DeepSeek**（`deepseek-flash`），任何 OpenAI 兼容 + 支持 function calling 的端点都能用。

```
模型 ──tools/call codebase_search──> warpgrep-mcp ──/chat/completions(tools)──> DeepSeek
                                        │  grep / glob / list / read（只在 --path 内）
                                        └─ finish → 校验路径 → path:start-end
```

## 为什么不是让模型自己搜索

一次 DeepSeek 搜索实测（本仓库、`deepseek-flash`）：

| 指标 | 值 |
|---|---|
| 轮数 / 耗时 | 4 轮 / 4.9s |
| tokens | prompt 7,662（缓存命中 4,096）+ completion 759 |
| 成本 | ≈ $0.002（≈ ¥0.015）/ 次 |
| 结果 | 只给 4 个 `path:line`，伪造路径被丢弃 |

省的是主对话的上下文：模型看到的是结论不是过程。搜索过程里读到的代码片段会发给
`--base-url` 指向的服务（和 Morph 版同样的语义，UI / README 都要如实说明）。

## 用法

```bash
# 直接跑（MCP 客户端会这样启动它）
node packages/warpgrep-mcp/server.mjs --path /path/to/repo

# 看一眼参数
node packages/warpgrep-mcp/server.mjs --help
```

写进 `~/.pi/agent/mcp.json`（或任何 MCP 客户端的 stdio 配置）：

```json
{
  "mcpServers": {
    "warpgrep": {
      "command": "node",
      "args": ["D:/projects/js/pi-mcps/packages/warpgrep-mcp/server.mjs", "--path", "D:/projects/js/my-repo"]
    }
  }
}
```

Key 不需要写进配置：服务按以下顺序找

1. `WARPGREP_API_KEY`
2. `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`
3. `WARPGREP_KEY_FILE`（JSON，取 `key` / `apiKey` / 首个 `*.key`）
4. pi 自己的凭据库：`$PI_CODING_AGENT_DIR/auth.json` 或 `~/.pi/agent/auth.json` 里该服务商的 `{type:"api_key", key}`

第 4 条是刻意设计的：桌面应用里已经登录过 DeepSeek，就不该再让人粘一遍 Key。

## 选项

| 参数 / 环境变量 | 默认 | 说明 |
|---|---|---|
| `--path` / `WARPGREP_PATH` | cwd | 搜索根目录，所有路径都被限制在它里面 |
| `--model` / `WARPGREP_MODEL` | `deepseek-flash` | 需要支持 function calling（`deepseek-reasoner` 不行） |
| `--base-url` / `WARPGREP_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `--max-turns` / `WARPGREP_MAX_TURNS` | `6` | 工具调用预算 |
| `--max-chars` / `WARPGREP_MAX_CHARS` | `12000` | 返回给模型的字符预算 |
| `WARPGREP_TURN_TIMEOUT_MS` | `45000` | 单次模型调用超时 |
| `WARPGREP_TOTAL_TIMEOUT_MS` | `100000` | 整次搜索超时（客户端一般 120s 超时，留余量） |

## 工具

`codebase_search`（与桌面内置 WarpGrep 同名同参，可随时互换）：

| 参数 | 类型 | 说明 |
|---|---|---|
| `search_string` | string | 具体问题，不是关键词 |
| `includeSource` | bool | 是否附上列出范围的代码 |
| `maxChars` | int | 返回预算，1000–48000 |

返回 `content[0].text` + `structuredContent { files, answer, dropped, turns, usage, model }`。
失败不抛 JSON-RPC 错误，而是 `isError: true` 且正文是 `CODE: message`：

| 码 | 含义 |
|---|---|
| `NO_KEY` | 没找到可用的 API Key |
| `INPUT` | `search_string` 为空 |
| `UNAUTHORIZED` / `REJECTED` | 401/403、402/400 |
| `RATE_LIMITED` | 429（已自动重试一次） |
| `TIMEOUT` | 单次调用或整体超时 |
| `NETWORK` | 端点不可达 |
| `PROTOCOL` | 响应里没有 `choices[0].message` |

## 可靠性细节（都是踩过的坑）

- **工具预算只在回合之间生效**：一次回复里带 3 个 `tool_calls` 时中途截断，下一轮请求就少了对应的
  `tool` 消息，DeepSeek 直接 400（`tool_calls must be followed by tool messages`）。
- **`finish` 不轻信**：路径必须真实存在才会出现在结果里（`dropped` 里是丢掉的）；模型写成
  `App.tsx:1184` 再单起一行 `1233` 时，第二行按"同一文件的另一个范围"续上。
- **模型忘了 `finish`**：先追问一次（`Call finish now…`），再不行就从正文里解析 `path:line`。
- **不执行 shell**：只有 grep / glob / list / read 四个只读原语，越界路径返回
  `error: path outside the workspace`，符号链接指出去也一样。
- **跳过垃圾目录**：`node_modules` / `dist` / `.git` 等，grep 单次扫描上限 20k 行。

## 测试

```bash
node --test tests/warpgrep-mcp.test.cjs     # 12 条：协议、循环、沙箱、错误码、预算
node artifacts/warpgrep-mcp-live.cjs        # 真实 DeepSeek 跑本仓库（用 pi 里的 Key）
```
