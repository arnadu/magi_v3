# ADR-0004: Tool ACL Enforcement — Operations Hooks

## Status
Accepted

## Context

File and execution tools need workspace path enforcement to prevent agents from reading or
writing outside their permitted directories. The system must:
- Enforce at the application layer (clear, typed policy violations — not silent OS errors)
- Apply as defense-in-depth on top of Linux ACLs (`setfacl`) at the OS layer
- Ensure agents never see tools they cannot use (filtering at registration time)
- Be injectable and testable without spawning real processes

Candidates evaluated:
1. **OS-level enforcement only** — rely on uid/gid + setfacl; application just propagates
   the OS error
2. **Per-tool application-level checks** — each tool has its own path validation logic
3. **Shared Operations hook injected at tool instantiation** — factory pattern; hook
   encapsulates policy; tool implementations are policy-agnostic

## Decision

Use **Operations hooks injected at tool instantiation**, with Linux ACLs as defense-in-depth.

Each file and bash tool receives a `checkPath(path, action)` hook and an `afterWrite(path)`
hook at construction time. These hooks throw a typed `PolicyViolationError` when the path
falls outside the agent's allowed set. The error is distinguishable from OS errors and
produces a clear, actionable message in the agent's tool result.

Tool registration is filtered per role at agent instantiation: the agent loop receives only
the tools its policy permits. The agent never sees — and cannot call — tools outside its
permitted set. This is the primary control; Operations hooks are the secondary control.

This pattern is adapted from pi-mono's coding-agent tool factory (`packages/coding-agent/
src/core/tools/`), which uses the same injection approach for sandboxed code execution.

OS-only enforcement was rejected because OS errors surface as opaque `EACCES` messages that
the LLM cannot reason about effectively and that obscure the policy being enforced.

Per-tool logic was rejected because it scatters enforcement across N tool implementations,
making it easy to miss and hard to audit.

## Consequences

- `PolicyViolationError` is a typed error class distinct from `Error`; tool results include
  the policy denial reason.
- Operations hooks are pure functions; they are injected in tests via stub implementations
  that assert correct call patterns.
- `workspace-manager` provisions real Linux ACLs; `identity-access-service` supplies the
  policy object used to construct the hooks.
- In integration tests, the OS-level rejection and the policy-level rejection are asserted
  to match for the same path (defense-in-depth test).
- Tool registration filtering is a pure function `filterTools(allTools, policy) → AgentTool[]`
  covered by unit tests.
