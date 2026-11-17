# BlockJuice implementation plans (docs only)

These documents capture the specialist implementation **plans** for the ranked backlog. They are not code.

Baseline: `main` @ `9efbc61`.

| File | Owner |
|------|--------|
| [00-consolidated-pr-brief.md](./00-consolidated-pr-brief.md) | BJ Team Lead |
| [01-quality-gate-name-contract.md](./01-quality-gate-name-contract.md) | BJ Quality Gate |
| [02-transform.md](./02-transform.md) | BJ Transform |
| [03-skills-and-reports.md](./03-skills-and-reports.md) | BJ Skills & Reports |
| [04-ingestion.md](./04-ingestion.md) | BJ Ingestion |
| [05-orchestration.md](./05-orchestration.md) | BJ Orchestration |
| [2026-11-16-lighter-drain.md](./2026-11-16-lighter-drain.md) | BJ Team Lead |

**Do not implement A–H until Ian says go after the A–H plans** (00 through 05). Prefer local Mac worktrees when cloud agent credits are blocked. Quality Gate reviews before merge-ready.

The Lighter drain plan is separate from A–H. Nothing in it is built until Ian says go. HyperCore and Lighter L2 data in that plan are out of scope: Ian is building those sources separately.
