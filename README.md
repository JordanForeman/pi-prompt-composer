# pi-prompt-composer

A Pi extension that composes contextual skill guidance into the runtime system prompt.

`pi-prompt-composer` discovers Pi skills that opt into automatic injection, selects the ones relevant to the current prompt/tool mode, and appends their `SKILL.md` bodies to Pi's system prompt for that turn.

## Why

Pi already exposes skills as discoverable resources. This extension adds a lightweight policy layer for skills that should be injected automatically rather than only listed for manual `/skill:name` loading.

## Install

Local development:

```bash
pi -e /Users/jordan/Developer/pi-prompt-composer/src/index.ts
```

As a Pi package:

```bash
pi install git:github.com/JordanForeman/pi-prompt-composer
```

Or add it to `settings.json`:

```json
{
  "packages": ["git:github.com/JordanForeman/pi-prompt-composer"]
}
```

## Skill frontmatter

Add `injection` metadata to any `SKILL.md`:

```yaml
---
name: typescript
description: TypeScript/Node project guidance
injection: detect
detect:
  files: [package.json, tsconfig.json]
---
```

Supported `injection` modes:

- `always` — inject every turn.
- `detect` — inject when a declarative rule matches.
- `classify` — when classifier support is enabled, ask a small classifier model whether the skill is relevant to the user's prompt. If the skill also has `detect` rules, matching rules can inject it without classifier use.
- `explicit` — never auto-inject; Pi can still expose the skill normally.

Optional `priority` metadata controls ordering and pressure-based gating:

```yaml
priority: 0.8 # 0..1; higher survives prompt budget/pressure first
```

Defaults are `always: 1.0`, `classify: 0.7`, and `detect: 0.5`.

Supported `detect` rules:

- `files: [...]` — any listed file exists in the current working directory.
- `dependencies: [...]` — any listed dependency appears in `package.json` dependency fields.
- `platform: darwin | linux | win32 | ...` — current Node platform matches.
- `mode: read-only | write` — active Pi tools imply read-only or write-capable work.

Frontmatter parsing is intentionally narrow for now: simple scalar values, inline arrays (`[a, b]`), and one-level nested `detect:` maps are supported.

## Commands

- `/prompt-debug` — show the last composition summary.
- `/prompt-debug full` — include injected skill bodies.

## Discovery and privacy

By default the extension reads Pi's already-loaded skills from `event.systemPromptOptions.skills`. It does not scan arbitrary skill roots unless you pass `skillRoots` or set `includeDefaultSkillRoots: true`.

Classifier calls are disabled by default. Enabling `classifier` sends the current user prompt and classify-skill descriptions to the configured classifier model provider.

If a compatible session health monitor publishes `health-checkpoint` custom entries with `data.relevanceFloor`, the extension reads the latest floor and drops selected skills below that priority. This lets prompt composition shrink under context pressure without coupling packages together. Set `healthCheckpointType: false` to disable that seam, or `relevanceFloor` to force a fixed floor.

## Programmatic API

The default export registers the extension with default behavior:

```ts
import promptComposer from "pi-prompt-composer";
```

For custom options:

```ts
import { createPromptComposer } from "pi-prompt-composer";

export default createPromptComposer({
  commandName: "prompt-debug",
  maxInjectedChars: 20_000,
  skillRoots: [],
  includeDefaultSkillRoots: false,
  // Optional context-pressure controls.
  // relevanceFloor: 0.6, // fixed override; omit to read health checkpoints
  healthCheckpointType: "health-checkpoint",
  // Disabled by default; enabling this sends prompt text to the classifier provider.
  classifier: {
    modelCandidates: [{ provider: "anthropic", id: "claude-haiku-4-5" }],
  },
});
```

Core utilities are exported from `pi-prompt-composer/core` for tests or custom composition flows.

## Development

```bash
npm install
npm run check
npm pack --dry-run
```

## Status

Initial extraction. The package is usable locally, but dotfiles integration and publishing are intentionally separate follow-up steps.
