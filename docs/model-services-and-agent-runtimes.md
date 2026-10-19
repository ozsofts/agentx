# 模型服务与 Coding Agent 的接入边界

## 已实现的模型设置

在“管理 → 模型与服务”中，选择供应商、模型，填写 Base URL 和 API Key 后可以直接“测试当前模型”，无需先保存。测试仅发送一条短文本，不携带项目、历史消息或工具；可能产生少量模型调用费用。留空的 Key 使用 Host 已有认证。测试不会保存配置或切换会话模型，确认后仍需“保存并使用”。

“获取供应商模型”直接请求供应商列表接口并处理分页。目前适配 OpenAI 兼容、Anthropic 和 Gemini 列表协议；具体服务是否实现对应接口，以实际响应为准。未适配服务继续使用 Pi 目录并可测试模型。Key 和供应商请求保留在 Host，错误详情脱敏；浏览器 Mock 会明确提示不能执行真实测试。

列表展示供应商返回的条目，但不能把“远端可见”视为“具备额度”或“Pi 已支持”。目前仅远端列表与 Pi 已适配对话模型的交集可选，其他条目保留供查询。视觉、推理、上下文长度和调用协议沿用 Pi 元数据。自动引入任意新模型需要另外设计自定义模型的协议、能力和参数配置，不能只凭模型名称猜测。

## Coding Plan 和独立 Coding Agent

供应商的 Coding Plan 通常指访问模型的套餐或专用接口。若它兼容现有模型协议，可配置对应 Base URL / Key 后继续由 Pi 执行工具循环；专用地址是否提供模型列表需要分别验证。

独立 Coding Agent 自带会话、工具循环、权限和认证方式，应作为运行引擎接入。建议保留当前页面事件协议，在 Host 下增加 AgentRuntime adapter；Pi 是一个实现，其他引擎单独实现。模型服务配置与引擎选择应独立，不能把独立 Agent 当成另一个模型名称。

优先使用目标 Agent 的结构化协议或 SDK；若支持 ACP，可映射其会话、流式消息、工具状态、审批与取消。只有 CLI 的引擎须使用可解析的结构化输出，通过子进程固定参数启动；不依赖抓取 TUI 屏幕。

| 适配职责 | Desktop 行为 |
| --- | --- |
| 初始化、能力查询、认证 | 显示引擎就绪状态及真实可用功能 |
| 新建/恢复、prompt、取消 | 映射到现有会话与任务操作 |
| 文本、工具、推理、错误事件 | 转成现有聊天过程事件；仅展示引擎实际提供的内容 |
| 权限请求与决定 | 路由回所属 Session；不支持的权限模式明确禁用 |
| 文件与变更 | 复用本地 Git Diff 和预览，不混用其他会话的工作区 |
| 持久化与退出 | 索引保存 runtimeId / runtimeSessionId，按引擎恢复 |

旧 Session 默认 runtimeId=pi；Pi JSONL 不直接交给其他引擎恢复。引擎切换先创建新 Session，各引擎凭据按自己的认证机制管理。第一步应选定一个具体 Agent，验证发送、流式输出、工具审批、取消和恢复后再扩大支持范围。本轮未实现额外引擎适配器。

参考：[ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)、[Anthropic Models](https://platform.claude.com/docs/en/api/models/list)、[Gemini Models](https://ai.google.dev/api/models)。
