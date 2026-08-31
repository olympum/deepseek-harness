# Agent Note: Model tool-call and launch-environment resilience

Status: implemented

English | [中文](2026-08-31-model-tool-call-launch-environment.zh.md)

## Problem

Model-generated `run_code` and `bash` calls can omit the UI-only `description` field. Strict validation then rejects executable code before dispatch. Some GLM 5.3 Flash responses also encode native tool calls as assistant text containing XML-like argument tags. A daemon launched by launchd can lack user-installed executable directories, so bare `cargo` resolution fails.

## Decision

`run_code` and `bash` treat `description` as optional metadata. Their executors still reject an explicitly supplied empty description, and their presenters use a stable fallback label when the field is absent.

The agent loop detects assistant text containing `</tool_call>` and at least one native argument tag. It discards that attempt and retries the same step once. A second matching response closes the turn with an explicit error. The retry budget belongs to one step and does not affect provider error recovery.

`dsh-subprocess` appends the standard Cargo and local-user tool directories, plus platform host tool directories, to the scrubbed child PATH. An explicit child environment can still replace PATH after the scrub.

The API gateway already owns the configurable WebSocket heartbeat, and the subagent runtime already carries role-specific reasoning effort. This change preserves those implementations without adding duplicate paths.

## Verification

The PTC and Bash suites cover omitted descriptions, fallback presentation, and empty-description rejection. The agent-loop suite covers one retry, omitted failed assistant history, and the bounded second failure. The subprocess suite covers Cargo resolution from a sparse PATH. The gateway heartbeat suite remains the owner of WebSocket behavior.

## Alternatives considered

**Keep UI metadata required.** Rejected because a missing presentation label must not prevent a valid command or program from executing.

**Retry malformed text indefinitely.** Rejected because repeated model output must produce a bounded, actionable turn error.

**Source a login shell profile.** Rejected because launchd does not provide a stable interactive shell contract, and profile code can change execution semantics.

**Reimplement the WebSocket heartbeat or Codex effort propagation.** Rejected because the current source already owns both behaviors and their tests.

## Consequences

Model calls remain executable when a provider drops display metadata. The host UI receives a deterministic label for those calls. A repeated text-encoded native call fails explicitly after one recovery attempt. Host child processes can resolve Cargo and standard local tools from launchd while credential-shaped environment names remain scrubbed.
