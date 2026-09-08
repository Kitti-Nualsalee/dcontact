# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. Create it with `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues are not enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels are `wayfinder:<type>`: `research`, `prototype`, `grilling`, or `task`. Once claimed, assign the ticket to the driving developer.
- **Blocking**: use GitHub's native issue dependencies. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` comes from `gh api repos/<owner>/<repo>/issues/<n> --jq .id`. If dependencies are unavailable, add `Blocked by: #<n>, #<n>` at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, excluding tickets with an open blocker or an assignee; the first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: post the answer with `gh issue comment <n> --body "<answer>"`, close the issue, then append a context pointer to the map's Decisions-so-far.

## Work stage

Tracked work has exactly one active `stage:*` label on its primary artifact. The primary artifact is
the Wayfinder map while planning, the implementation issue while building, and the pull request while
reviewing or accepting.

- `stage:wayfinding` — destination/frontier is still being charted.
- `stage:decision` — an explicit architecture, domain, security, or product decision is being resolved.
- `stage:phase-spec` — decisions are sufficient to produce an implementation-ready phase specification.
- `stage:implementation` — code is being written against an accepted specification.
- `stage:review` — a pull request exists and is being checked against the specification and ADRs.
- `stage:acceptance` — review is clear and the required integration/release evidence is being collected.
- `stage:complete` — the change is merged and its completion evidence is recorded.
- `stage:conflict` — issue, branch, pull request, or evidence disagree; reconcile before mutation.

Put the following block inside the Wayfinder map's **Notes** section and update it whenever the stage
changes:

```markdown
### Current work state

- Stage: `<STAGE>`
- Active phase: `<phase or program>`
- Active artifact: `[<issue or PR title>](<url>)` or `ยังไม่มี`
- Recommended model tier: `<ARCHITECT | IMPLEMENTER | MECHANICAL>`
- Next gate: `<observable condition required to advance>`
```

Do not infer stage from labels alone. Verify the linked issue, branch, pull request, CI, and acceptance
comment before updating the state.
