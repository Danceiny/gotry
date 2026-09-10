[English](hotelbyte-skills-design.md) | [简体中文](hotelbyte-skills-design.zh-CN.md)

# hotelbyte-skills Architecture Design (issue #5)

> Status: frozen (design memo, 2026-08-25; issue #5)
> One sentence: move the hotelbyte CLI's capability knowledge out of gotry code into a **dedicated skills repo**,
> making it the single source of truth reused by all agents (dsh users/cis-cli-style internal tools/the future hotel-fe side);
> gotry keeps only a thin execution surface.

## Motivation (the three problems #5 called out)

1. **Scattered knowledge**: gotry's `capabilities/hbcli.ts`/`anything.ts` hard-code the
   hbcli subcommand shapes (`search anything`/hotel search) and degradation strategies — the hotelbyte CLI's
   capability knowledge lives in gotry's TypeScript.
2. **Not reusable**: other dsh users/agents who want hotel-domain search have no choice but to re-read gotry source.
3. **Upgrade coupling**: when hbcli adds a subcommand or changes a parameter, gotry has to cut a release.

## Target shape

`Danceiny/hotelbyte-skills` (private, MIT like gotry):

```
hotelbyte-skills/
├── SKILL.md            # Capability declaration: name/description/when_to_use (hotel domain /
│                       # destination catalog / Anything travel-domain search) + the domain
│                       # boundary with agent-reach (mirror of gotry persona contracts 16/17)
├── contracts/          # Tool contracts: hbcli subcommand ↔ input/output JSON Schema ↔
│   ├── anything.md     #   degradation semantics (not installed / timeout / private-repo 401 → three-valued)
│   └── hotels.md
├── examples/           # 2-3 real call samples per contract (with evidence-chain annotation format)
└── CHANGELOG.md        # Versioned; hbcli breaking changes are declared here
```

## Relationship to gotry (two-step migration)

- **Step one (establish the repo, zero risk)**: create the repo + reverse-extract SKILL.md/contracts from gotry's existing
  `hbcli.ts`/`anything.ts` and the hotel-be `/api/search/anything` annotations.
- **Step two (alignment verification)**: align gotry's tool descriptions with the contract documents — add one lightweight test:
  the parameter shapes in gotry tool descriptions must have a matching entry findable in contracts/
  (anti-drift; akin to the agent-reach wrapper's "single source of truth for knowledge" philosophy).
- **Do not migrate the execution surface**: the `capabilities/*.ts` hbcli spawn/degradation/evidence-chain logic stays in gotry
  (in-process performance + L4 contract-test coverage); the skills repo carries **knowledge**, not runtime.

## Domain boundaries (linked with #4/#6)

| Domain | Home |
|---|---|
| Hotel inventory/destination catalog/Anything travel-domain search | hotelbyte-skills → hbcli → hotel-be |
| General external facts/content platforms/market data | agent-reach (upstream registry) |
| Company systems (travel orders/leave) | cis-cli and other host skills (persona contract 16) |

## Open questions (founder can decide in one sentence)

1. Distribution form: git clone to `~/.claude/skills/hotelbyte-skills` (simplest) vs an npm package
   (gotry dependency coupling) — recommend the former first;
2. Repo visibility: private (current recommendation) vs public (it can go public if the hotel-be OpenAPI is public).
