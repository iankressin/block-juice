# Notes for Claude Code

## Commits and pull requests

- Never put the Claude session link in a commit message or a pull request description: no `Claude-Session:` trailer and no `claude.ai/code/session_…` URL. Keep the `Co-Authored-By:` trailer on commits.

## Agent skills

### Factory

Analysis tickets become pipeline PRs through two GitHub Actions runs, scope then build. Labels `scope` and `ready-for-agent` start them. See `docs/agents/factory.md` and `docs/adr/0001-software-factory.md`.
