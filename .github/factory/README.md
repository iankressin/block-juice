# Factory workflows

The code behind [docs/agents/factory.md](../../docs/agents/factory.md): two workflows, their prompts and the glue between them.

| File | What it is |
|---|---|
| `../workflows/factory-scope.yml` | The scope run. Starts when a ticket gets `scope`. Posts one scope comment. |
| `../workflows/factory-build.yml` | The build run. Starts when a ticket gets `ready-for-agent`. Opens or updates a draft PR. |
| `scope.md`, `build.md` | The prompts. Model and turn caps are in each workflow's `env`. |
| `factory.py` | Checks and assembles the scope comment, reads it back, renders the ticket, reads the verdict, masks secrets. Tested in `orchestration/tests/test_factory.py`. |

## What runs when

Each run is one job in a queue per ticket. A run in progress is never cancelled. GitHub keeps one waiting run per queue, so a newer label replaces a waiting run, whose label then stays on the ticket. Remove that label and add it again. A run's first write removes the label that started it, and a run that finds the label gone exits. The model writes files under `.factory/` and in the checkout. Workflow steps make every GitHub write with the App's token. The model gets the read-only `GITHUB_TOKEN`, which claude-code-action writes into the checkout's git config, so it holds nothing that can push.

- **Scope run**: claim, write `.factory/issue.md` and `.factory/open-issues.json`, run the model, check `scope.yaml` and `reference.csv`, post the comment. If the check fails, it posts what the model wrote for the human and adds `ready-for-human`.
- **Build run**: claim, extract the newest scope comment from the App, check out `factory/<issue>-<slug>`, run the model, then run the reference test as the verdict, record it with `bj check`, run the repo's checks, commit, push and open the draft PR. It labels the PR `reference-mismatch` on a failed verdict, and adds `ready-for-human` to the ticket when the verdict or a check failed.

Both upload the transcript, with secrets masked, for seven days. The build run also uploads `answers/<slug>/`.

claude-code-action stops before the model runs when the person who added the label has no write access. So a stranger's Analysis ticket ends with `ready-for-human`. Read it, then add `scope` yourself to run it. The model reads comments only from people with write access and from Apps installed on the repo.

## Secrets

| Secret | Used by |
|---|---|
| `FACTORY_APP_CLIENT_ID`, `FACTORY_APP_PRIVATE_KEY` | both, to mint the App token |
| `ANTHROPIC_API_KEY` | both. Take it from a Console workspace with a monthly spend limit |
| `DUNE_API_KEY` | scope, in the Dune MCP config the workflow writes to the runner's temp folder |
| `EVM_RPC_URL` | scope, for block-pinned reads. An Ethereum archive node |

## The App

Create a GitHub App with no webhook and these repository permissions: Contents read and write, Issues read and write, Pull requests read and write, Metadata read. Install it on this repo only. It has no Workflows permission, so a build run that edits `.github/workflows/` fails its push.

## Tool rules

The model's tools come from `--allowedTools` in `claude_args`. Claude Code's [permission docs](https://code.claude.com/docs/en/permissions) say what these rules rely on:

- `Bash(uv run *)`: "Claude Code matches everything before the first `*` as written", and "a `*` at the end, with a space before it, also matches the bare command".
- Compound commands: "Every subcommand must be allowed for a compound command to run without a prompt." So the build run allows `set -a *`, `set +a *` and `. ./.env *` for the skill's dbt prefix. A `cd` inside the checkout needs no rule.
- `mcp__sqd-portal__*` "matches every tool from" that server. The repo's `.mcp.json` registers it, and claude-code-action's docs say such tools "still need to be explicitly allowed".
- `--disallowedTools "Bash(git push *),Bash(gh *)"`: a deny rule wins over any allow rule. It "isn't a security boundary around the program", which is why the model also gets no token that can write.

## Dry run

1. Check the glue and the workflows:

   ```sh
   (cd orchestration && uv run pytest tests/test_factory.py)
   uvx --from actionlint-py actionlint -ignore 'create-github-app-token@v3' .github/workflows/factory-*.yml
   ```

   The `-ignore` is there because actionlint 1.7.12 knows an old `create-github-app-token` that had no `client-id`. v3 takes it.
2. File an Analysis ticket whose answer the repo already holds; `first-ticket.md` has the text for one. Read the scope comment and check its oracle, window and rows.
3. Add `ready-for-agent`. Review the draft PR: the comparison table, the factory checks, the files. Read the transcript in the run's artifacts.
4. Close the PR without merging and delete its `factory/<issue>-<slug>` branch.
