# Shared model runtime and ACP session ownership

## Reproduction

A child Pi session can register a provider with the same ID as its parent's provider while both sessions use one `ModelRuntime`. In the tested Pi versions, binding the child's extensions replaces the parent's native provider. Emitting `session_shutdown` for the child and disposing the child session do not restore the parent registration.

Run `node scripts/reproduce-shared-provider.mjs` to reproduce this using the checkout's installed Pi SDK. Set `PI_RUNTIME_INDEX` to an installed `pi-coding-agent/dist/index.js` to test another version. The script uses temporary directories, a simulated provider, and no network or credentials.

Run `node scripts/reproduce-acp-shared-cwd.mjs` to reproduce the consequence using this checkout's ACP provider and its fake ACP process. It binds parent and child extension instances with different working directories, shuts down the child, and sends a request through the still-registered provider. The fake ACP process reports the child's working directory for the later request, although it is attributed to the parent session. This test creates no real ACP agent session and sends no prompts to a remote service.

Both scripts reproduced the behavior using the checkout's Pi 1.3.0 dependency and installed Pi 1.6.0. A separate live `pi-subagents` experiment with the fake ACP agent started a child in an alternate directory with the provider extension loaded, waited for it to complete, and then started a child in the parent directory with extensions disabled. Both fake ACP processes reported the first child's directory. This confirms that ordering in that setup; it does not establish every possible ordering or lifecycle behavior.

## Why this matters

`pi-subagents` may pass a parent model runtime to child sessions. Pi binds each child's extensions against that shared runtime; a native provider registration for an existing ID replaces the previous provider object. The provider in this repository captures its extension session's working directory, owns ACP clients, and disposes those clients on extension shutdown. Pi's provider request options provide a session ID but not the session's working directory. Loading the extension in each child therefore cannot reliably associate a request with the right working directory: registration can replace another session's provider, and children can disable extension loading entirely.

The provider object in this repository remains callable after its extension's shutdown handler clears its clients. A subsequent request may create a new client with the old extension instance's working directory. No conclusion about runtime behavior after a Pi restart follows from this reproduction.

## Candidate upstream integration

Two independent contracts need examination with Pi maintainers:

1. **Provider request context:** expose the active session's working directory alongside its session ID to provider streams. Pi should source it from the session, not prompt text or process-global `cwd`. The behavior for direct calls without a Pi session, session replacement, relative paths, and directory changes needs an explicit contract.
2. **Provider registration ownership:** define how session-bound extension registrations interact with a shared runtime. A possible design is session-scoped provider overlays with ownership-aware removal; another is a host-owned provider registration shared across sessions. Either design must prevent child binding or shutdown from changing another session's active provider unexpectedly, including overlapping children and non-LIFO shutdown. This is a candidate design, not an asserted requirement of Pi's current API.

Acceptance tests should cover parent plus concurrent children in distinct directories, children that disable extensions, child shutdown in either order, parent requests after child shutdown, cancellation, and provider registration replacement. Verify that the actual ACP process and `session/new` receive the intended cwd. No upstream issue or change has been submitted.

Until a supported integration exists and is tested, ACP subagents using a different working directory or worktree from the provider extension's session are unsupported. The current provider cannot detect all such cases and does not enforce this limitation.
