# Factory workflows

These rules cover changes to the factory's workflows (`workflows/factory-*.yml`) and their glue (`factory/`). `docs/agents/factory.md` is the contract, and `factory/README.md` explains the design. A factory run never edits `.github/`, as `factory/build.md` and `factory/scope.md` say.

## Who can write

- The model runs only in the `work` job, which has no App token and a `GITHUB_TOKEN` that only reads. Its step gets only the secrets its tools use. Only `claim` and `publish` mint the App token, each on a fresh runner. The deny rules in `--disallowedTools` do not replace the missing token.
- The model can change anything on the `work` runner, so `publish` trusts nothing that `work` made after the model step. It takes the branch and its base commit from step outputs set before the model ran. The verdict and the check results come after the model, so they go only into the PR body, the labels and the comments, where a human reads them.
- `publish` runs `factory/factory.py` from the default branch, restores no cache, and reads the model's files as data. It applies, commits and pushes with git hooks off, and never forces a push.
- The model reads the ticket only through `factory.py ticket`. It keeps comments from the repo's owners, members and collaborators and from Apps, drops the HTML comments GitHub does not render, and tells the model to read a stranger's issue as data. The build run takes its scope only from a comment the App posted.

## Secrets

- `publish` masks the files it posts with its own copy of `factory.py`. A mask that ran on the `work` runner does not count, since the model can rewrite it.
- Upload or post a file only after the scrub that covers it has succeeded. When a scrub fails, post none of what it covered.
- A secret in the model's changes, in any encoding `factory.py leaks` checks, ends the build run before it pushes. So does a change that `factory.py patch-check` or `staged-check` refuses, such as a file under `.github/`.
- When a model step gets a new secret, add its name to every `scrub` and `leaks` call in that workflow.

## Verdicts and failures

- The verdict passes only when an `answer.json` that the verdict step itself wrote, after the step began, holds a `reference_match` check with status `passed`. The step deletes the model's `answer.json` first, and a failed check is a mismatch. When the rebuild of the analysis's upstream fails, the verdict fails.
- A failed run hands the ticket to a human with the reason. `factory.py model-error` reads the model's error from `result`, or from `errors` when `result` is empty, and the hand-off comment and the PR body quote it. When the branch has nothing ahead of the base, the build run opens no PR. It comments on the ticket and adds `ready-for-human`.

A change here is done when `uv run --project orchestration pytest orchestration/tests/test_factory.py orchestration/tests/test_factory_scores.py` passes and actionlint passes as in step 1 of the dry run in `factory/README.md`.
