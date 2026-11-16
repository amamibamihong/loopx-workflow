---
name: mem0-memory
description: Project-integrated Mem0 long-term memory system for auto-recall, auto-capture, deduplication, conflict updates, token budgeting, and secret redaction across Codex and loopx-flow.
---

# mem0-memory：项目级长期记忆治理技能

## 适用场景
- 在开启新任务、特性（`feature`）或缺陷排查（`issue`）前自动检索历史架构、技术决策、代码规范、业务规则与排错方案。
- 在完成关键决策、契约冻结、质量门禁或对话结束时自动提炼并去重写入长期记忆。

## 5 类标准化记忆分类
1. `architecture`：项目架构、模块边界、数据流与组件职责
2. `decisions`：技术决策、ADR、方案取舍与约束
3. `conventions`：代码规范、门禁约定、测试准则与反模式
4. `business_rules`：业务规则、`REQ-*` 需求、Fail-Closed 门禁与审批流转
5. `troubleshooting`：历史问题根因、修复方案与踩坑经验

## 常用命令
- `loopx-flow memory doctor --live`：校验密钥（脱敏预览）、存储权限与向量连接
- `loopx-flow memory sync`：增量同步 `AGENTS.md` / PRD / 设计 / ADR / 胶囊到 mem0
- `loopx-flow memory search "<query>"`：检索高相关记忆（带相关性阈值与 Token 上限）
- `loopx-flow memory add "<fact>" --category decisions`：手动沉淀并自动去重/更新冲突记忆
- `loopx-flow memory setup-codex`：为 Codex 注册 `mem0` MCP Server 与生命周期 Hooks

## 安全与 Token 约束
- 所有输入与输出必须经 `redactSecrets()` 脱敏，默认强制 `MEM0_TELEMETRY=false`。
- 检索严格受 `MEM0_MIN_SEMANTIC_SCORE`（默认 `0.42`）与 `MEM0_MAX_CONTEXT_TOKENS`（默认 `800`）约束，避免无关记忆污染上下文。
