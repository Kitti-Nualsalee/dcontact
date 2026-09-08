## Agent skills

### Issue tracker

Issues and specs for this repo live as GitHub issues. See `docs/agents/issue-tracker.md`.

### Work stage routing

Before acting on tracked work, determine the current work stage from the linked Wayfinder map,
issue, branch, pull request, and acceptance evidence. Follow `docs/agents/work-stage.md`.

In the first user-facing update, report the scope and the provisional stage from available context,
then say which evidence you will inspect. After the minimum read-only inspection and before any
mutation, report the confirmed stage, active artifact, recommended model tier, and next gate. Treat
the tracker as the source of truth instead of relying on chat history. If the evidence conflicts,
report `STATE_CONFLICT` and reconcile it before changing code or tracker state.

### Domain docs

This is a multi-context repository. `CONTEXT-MAP.md` points to the relevant per-context `CONTEXT.md` files, while `docs/adr/` holds system-wide decisions. See `docs/agents/domain.md`.

## Language

Use Thai for user-facing responses and for repository or tracker artifacts created for people, including GitHub issue titles, issue bodies, comments, specifications, tickets, ADRs, and handoffs. Preserve established code identifiers, API names, event names, commands, product names, and technical terms in English where translating them would make the artifact ambiguous or incorrect.
