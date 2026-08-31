# Agent Note: 模型工具调用与启动环境的韧性

Status: implemented

[English](2026-08-31-model-tool-call-launch-environment.md) | 中文

## Problem

模型生成的 `run_code` 和 `bash` 调用可能省略仅用于 UI 的 `description` 字段。严格校验会在分派前拒绝可执行代码。部分 GLM 5.3 Flash 响应还会把原生工具调用编码成包含 XML 风格参数标签的 assistant 文本。launchd 启动的 daemon 可能缺少用户安装的可执行文件目录，因此无法解析裸的 `cargo`。

## Decision

`run_code` 和 `bash` 将 `description` 视为可选元数据。执行器仍拒绝显式提供的空描述，展示器在字段缺失时使用稳定的回退标签。

agent loop 检测包含 `</tool_call>` 且至少包含一个原生参数标签的 assistant 文本。它丢弃该次尝试，并对同一步重试一次。第二个匹配响应会以明确错误结束轮次。重试预算属于单个 step，不影响提供方错误恢复。

`dsh-subprocess` 会把标准 Cargo、用户本地工具目录以及平台主机工具目录追加到清洗后的子进程 PATH。显式子进程环境仍可在清洗之后替换 PATH。

API gateway 已经拥有可配置的 WebSocket heartbeat，subagent runtime 已经传递角色专属的 reasoning effort。本变更保留这些实现及其测试，不增加重复路径。

## Verification

PTC 与 Bash 套件覆盖缺失描述、回退展示和空描述拒绝。agent-loop 套件覆盖一次重试、从历史中省略失败的 assistant，以及第二次失败的有界行为。subprocess 套件覆盖稀疏 PATH 下的 Cargo 解析。gateway heartbeat 套件继续拥有 WebSocket 行为。

## Alternatives considered

**继续要求 UI 元数据。** 拒绝，因为缺失展示标签不应阻止有效命令或程序执行。

**无限重试格式错误的文本。** 拒绝，因为重复的模型输出必须在有限次数后产生可操作的轮次错误。

**加载 login shell 配置。** 拒绝，因为 launchd 不提供稳定的交互式 shell 契约，配置脚本也可能改变执行语义。

**重新实现 WebSocket heartbeat 或 Codex effort 传递。** 拒绝，因为当前源代码已经拥有这两种行为及其测试。

## Consequences

提供方丢弃展示元数据时，模型调用仍可执行。主机 UI 会为这些调用显示确定的标签。重复的文本编码原生调用在一次恢复尝试后明确失败。launchd 下的主机子进程可以解析 Cargo 和标准本地工具，同时凭据形状的环境变量名称仍会被清洗。
