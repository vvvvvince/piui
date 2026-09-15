# piui — Web UI for the `pi` coding agent

This repository currently contains **only specifications**. It is meant to be handed to a
coding agent (or a developer) to implement.

`piui` is a self-hosted web front end for [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
(`@earendil-works/pi-coding-agent`). pi ships no web UI; it exposes an in-process TypeScript
SDK and a JSONL RPC mode. piui wraps the SDK in an HTTP/SSE server plus a browser client.

## Feature summary

| # | Feature | Spec |
|---|---------|------|
| 1 | **Profiles** — AGENTS.md + skills + tools + opt-in persistent memory | [spec/03-profiles.md](spec/03-profiles.md) |
| 2 | **Authentication** — hardcoded `test`/`test`, pluggable later | [spec/06-auth.md](spec/06-auth.md) |
| 3 | **Workspaces** — a folder the agent works in | [spec/04-workspaces.md](spec/04-workspaces.md) |
| 4 | **Chat mode** — model only, web search, no memory/profile/persona | [spec/07-chat-mode.md](spec/07-chat-mode.md) |
| 5 | **Agent mode** — model + profile + workspace, full agentic loop | [spec/08-agent-mode.md](spec/08-agent-mode.md) |
| 6 | **Skills & tools management UI** | [spec/05-skills-and-tools.md](spec/05-skills-and-tools.md) |

> **Start here:** [spec/00-overview.md](spec/00-overview.md), then the
> "Context budget" table below — it tells you which files a given milestone needs so you do
> not load 55k tokens of spec to write a route.

> **Development method: test-driven.** Read
> [spec/20-development-method.md](spec/20-development-method.md) before writing any code. The
> acceptance criteria in these specs are the test backlog, and a `spec-coverage` test fails the
> build if any of them lacks a tagged test.

## Context budget: what to load, and when

The corpus is ~55k tokens. **Do not load it all.** Every file's frontmatter carries
`summary`, `covers` and `depends_on` so you can load a subtree. Per-task budgets:

| Task | Load | ≈ tokens |
|------|------|----------|
| Orientation (once) | `00-overview`, `12-milestones` §milestone list, `20-development-method` | ~6k |
| **M0** skeleton + test harness | + `01-architecture`, `02-data-model`, `19-deployment` | ~14k |
| **M1** auth | `06-auth`, `18-multi-user`, `09-api` §§0–2, `14-credentials` §5 | ~7k |
| **M2** chat mode | `07-chat-mode`, `09-api`, `10-frontend`, `14-credentials`, `15-commands-and-input` §4 | ~13k |
| **M3** web search / tools | `05-skills-and-tools` §B, `11-security` §2 | ~4k |
| **M4** workspaces | `04-workspaces`, `09-api` §5 | ~2k |
| **M5** profiles + agent mode | `03-profiles`, `05-skills-and-tools`, `08-agent-mode`, `17-memory` | ~9k |
| **M5b** slash commands | `15-commands-and-input` | ~3.5k |
| **M5c** extensions | `16-extensions` | ~3.6k |
| **M6** skills/tools UI | `05-skills-and-tools`, `10-frontend` | ~4.5k |
| **M7** hardening | `11-security`, `19-deployment`, `10-frontend` §4 | ~6k |
| A single bug fix | the one file that `covers` the topic | ~2–3k |

Two files are **not** implementation input:

- `decisions.md` (7k) — rationale and history. Outcomes are already merged into the normative
  files. Read its summary table only, unless you want to challenge a requirement.
- `13-open-questions.md` (1k) — answered questions and the deliberate `[LATER]` list. Consult
  when scoping, not when building.

Within a file, blocks introduced by **"Rationale:"**, **"Reasoning:"** or **"Why:"** are
non-normative. Skip them while implementing; read them before proposing a change.

## Read the specs in this order

1. [spec/00-overview.md](spec/00-overview.md) — goals, non-goals, glossary, architecture
2. [spec/01-architecture.md](spec/01-architecture.md) — stack, processes, repo layout, pi integration
3. [spec/02-data-model.md](spec/02-data-model.md) — storage layout, DB schema, TypeScript types
4. [spec/03-profiles.md](spec/03-profiles.md)
5. [spec/04-workspaces.md](spec/04-workspaces.md)
6. [spec/05-skills-and-tools.md](spec/05-skills-and-tools.md)
7. [spec/06-auth.md](spec/06-auth.md)
8. [spec/07-chat-mode.md](spec/07-chat-mode.md)
9. [spec/08-agent-mode.md](spec/08-agent-mode.md)
10. [spec/09-api.md](spec/09-api.md) — REST + SSE contract (authoritative)
11. [spec/10-frontend.md](spec/10-frontend.md) — screens, components, UX states
12. [spec/11-security.md](spec/11-security.md)
13. [spec/12-milestones.md](spec/12-milestones.md) — build order + acceptance criteria
14. [spec/13-open-questions.md](spec/13-open-questions.md)
15. [spec/14-credentials.md](spec/14-credentials.md) — provider credential management (Q1 = B)
16. [spec/15-commands-and-input.md](spec/15-commands-and-input.md) — slash commands, prompt
    templates, pi-TUI input parity (Q2)
17. [spec/16-extensions.md](spec/16-extensions.md) — extensions: global install, per-profile
    disable, no approval gates (Q3)
18. [spec/17-memory.md](spec/17-memory.md) — memory file format + phased evolution (Q4 = D)
19. [spec/18-multi-user.md](spec/18-multi-user.md) — authorization model: ownership + roles
    enforced from V1, real multi-user in V2 (Q7 = C)
20. [spec/19-deployment.md](spec/19-deployment.md) — Dockerfile + docker-compose stack; the
    container is the isolation model (Q10 = A)
21. [spec/20-development-method.md](spec/20-development-method.md) — **test-driven development**
    (requirement R1): the loop, spec-as-test-backlog, and the M0 test seams

**[spec/decisions.md](spec/decisions.md)** — binding answers to the open questions. Read this
first; it overrides anything it contradicts.

## Spec frontmatter

Every file in `spec/` starts with YAML frontmatter so a tool or an agent can navigate without
reading everything:

```yaml
---
id: 03-profiles                  # stable id, equals the filename without .md
title: Profiles
status: normative                # normative | informative | binding
feature: "1 — Profiles"          # optional: which numbered feature this specifies
authoritative_for: http-contract # optional: this file wins on that topic
read_first: true                 # optional: read before implementing anything
summary: >-
  One paragraph of what this file decides.
covers: [profiles, memory]       # topic tags — grep these to find the right file
depends_on: [02-data-model]      # read these first
required_by: [08-agent-mode]     # files that rely on this one
decisions: [Q2, Q4]              # decision-log entries that changed this file
milestones: [M5]                 # where the work lands in 12-milestones.md
spec_version: 1
updated: 2026-02-20
---
```

Rules for whoever edits these specs:

- Keep `depends_on` / `required_by` symmetric, and keep every id resolvable.
- When a decision changes a file, add its `Qn` to `decisions` and update `decisions.md`.
- `status: binding` (only `decisions.md`) overrides `normative` files on conflict;
  `normative` overrides `informative` (only `13-open-questions.md`).
- Validate with:
  `python3 -c "import glob,yaml;[yaml.safe_load(open(f).read().split(chr(10)+'---'+chr(10),1)[0][4:]) for f in glob.glob('spec/*.md')]"`

## Conventions used in these specs

- **MUST / SHOULD / MAY** follow RFC 2119.
- Acceptance criteria are numbered because tests reference them as `[<spec id>#<section>.<item>]`
  (see requirement R1). Renumbering an acceptance list means updating its test tags.
- `[V1]` = required for the first release. `[LATER]` = designed for, not built now.
- Any place the spec says "pluggable", the implementation MUST define a TypeScript interface
  with exactly one implementation, so a second one can be dropped in without touching callers.
- When the spec and pi's own docs disagree, pi's docs win — read
  `node_modules/@earendil-works/pi-coding-agent/docs/{sdk,rpc,extensions,skills,settings,session-format}.md`.
