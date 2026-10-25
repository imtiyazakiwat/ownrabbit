# Contributing to OwnRabbit

Thanks for helping. This guide gets you from clone to merged PR.

## Setup

Requirements: Node 22+, pnpm 10+.

```bash
git clone https://github.com/imtiyazakiwat/ownrabbit && cd ownrabbit
pnpm install
pnpm test
pnpm typecheck
```

Most work needs no cloud credentials. The review pipeline (`apps/worker/src/orchestrator.ts`) is tested end to end with fake GitHub and LLM ports, and the UI can be built with `pnpm --filter @ownrabbit/web build`.

## Where things live

| Area | Path |
| --- | --- |
| Settings schema, presets, trigger rules | `packages/core/src` |
| Prompts (master + specialists + judge) | `apps/worker/src/prompts.ts` |
| Pipeline orchestration | `apps/worker/src/orchestrator.ts` |
| Diff parsing / line anchoring | `apps/worker/src/diff.ts`, `findings.ts` |
| Agent tool loop | `apps/worker/src/reviewer.ts`, `repo.ts` |
| Dashboard UI | `apps/web/app/dashboard` |
| Webhook | `apps/web/app/api/github/webhook/route.ts` |

## Making a change

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Create a branch: `feat/…`, `fix/…`, or `docs/…`.
3. Add or update tests. Bug fixes should include a test that fails without the fix.
4. Run `pnpm test && pnpm typecheck` before pushing.
5. Open a PR using the template. OwnRabbit will review it, which is a good dogfooding check.

## Guidelines

- **Match existing style.** Small, single-purpose functions; comments explain *why*, not *what*.
- **Validate at boundaries.** Webhook payloads, LLM output, and URL params are untrusted. Parse with zod.
- **Treat PR content as hostile.** Anything from a pull request must reach prompts wrapped with `untrusted()`, and must never reach a shell.
- **Pin dependencies** to exact versions.
- **Prompt changes** should explain the failure they fix, ideally with a before/after example in the PR description.

## Commit messages

Short imperative subject (`fix: anchor multi-line suggestions to a single hunk`), with a body explaining why when it isn't obvious.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
