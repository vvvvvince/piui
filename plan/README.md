# plan/ — implementation plan for piui

Working plan derived from `spec/`. Not normative: `spec/decisions.md` (binding) and
`spec/*.md` (normative) win over anything here; pi's own docs win over the spec on pi's API.

Start with [`00-plan.md`](00-plan.md), then the milestone file you are working on.

- [00-plan.md](00-plan.md) — strategy, ground rules, sequencing, estimates, DoD
- [01-m0-skeleton.md](01-m0-skeleton.md) — repo, DB, config, Docker, **test harness**
- [02-m1-auth.md](02-m1-auth.md) — auth, CSRF, step-up, authorization matrix
- [03-m2-chat.md](03-m2-chat.md) — credentials, pi bridge, SessionHub/SSE, chat UI
- [04-m3-m4-search-workspaces.md](04-m3-m4-search-workspaces.md) — web search, workspaces
- [05-m5-profiles-agent.md](05-m5-profiles-agent.md) — profiles, memory, agent mode
- [06-m5b-m5c-commands-extensions.md](06-m5b-m5c-commands-extensions.md) — slash commands, extensions
- [07-m6-m7-management-hardening.md](07-m6-m7-management-hardening.md) — skills/tools UI, hardening, docs
- [08-risks-and-spikes.md](08-risks-and-spikes.md) — **read before M0**: pi-API spikes + risk register
- [09-checklist.md](09-checklist.md) — flat tickable work order

`plan/spikes/` holds the written outcome of each spike (question, verified answer, typing
excerpt, consequence).

## Plan frontmatter

Every file here carries YAML frontmatter, mirroring the spec convention so the same tooling can
navigate both — but with a **separate schema**, because a plan file is not a spec file:

```yaml
---
id: plan-03                      # stable id, plan-NN
title: M2 — Credentials, pi bridge, streaming, chat mode
status: plan                     # never 'normative' or 'binding' — the plan cannot outrank a spec
summary: >-
  One paragraph of what this file plans.
read_first: true                 # optional
milestone: M2                    # or a list, or 'all'
est_days: "5–7"                  # optional
risk: high                       # optional
covers: [credentials, session-hub, sse]   # topic tags
spec_refs: [14-credentials, 09-api]       # spec ids to LOAD for this task
depends_on: [plan-02]            # plan-internal only
blocks: [plan-04, plan-05]       # plan-internal only
plan_version: 1
updated: 2026-02-20
---
```

Rules:

- `status` is always `plan`. Precedence is `spec/decisions.md` > `spec/*.md` > plan.
- **Spec ids are referenced through `spec_refs`, never `depends_on`.** `depends_on` / `blocks`
  stay inside the plan namespace, so plan files never enter the spec's
  `depends_on` / `required_by` symmetry rule and never need a `required_by` entry in a spec file.
- `spec_refs` is the context budget for the task: load those files and nothing else.
- Validate with:
  `python3 -c "import glob,yaml;[yaml.safe_load(open(f).read().split(chr(10)+'---'+chr(10),1)[0][4:]) for f in glob.glob('plan/*.md')]"`

Three rules that everything else depends on:

1. Tests first — every acceptance criterion is a tagged test (`[<spec id>#<section>.<item>]`).
2. No pi import outside `server/src/pi/**`.
3. No raw SQL against owned tables outside the repository layer.
