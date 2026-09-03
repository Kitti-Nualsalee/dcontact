# Domain Docs

How engineering skills should consume this repository's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT-MAP.md` at the repository root, when it exists: it points to one `CONTEXT.md` per relevant context.
- `docs/adr/`: read ADRs that touch the area you are about to work in.
- For a scoped context, read its `CONTEXT.md` and local ADRs when those files exist.

If any of these files do not exist, proceed silently. Do not flag their absence or create them upfront. The domain-modeling skill creates them lazily when terms or decisions are actually resolved.

## File structure

This is a multi-context repository:

```
/
├── CONTEXT-MAP.md                     ← routes to relevant contexts
├── docs/adr/                          ← system-wide decisions
├── apps/
│   └── <app>/                         ← app-specific CONTEXT.md and ADRs when needed
└── packages/
    └── <package>/                     ← package-specific CONTEXT.md and ADRs when needed
```

## Use the glossary's vocabulary

When output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term defined by the relevant `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If the concept is not in a glossary yet, either reconsider invented terminology or note the gap for domain modeling.

## Flag ADR conflicts

If an output contradicts an existing ADR, surface it explicitly rather than silently overriding it.
