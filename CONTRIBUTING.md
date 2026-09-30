# Contributing

## Changes go through pull requests

`master` is protected by a repository ruleset. Direct pushes are rejected for
everyone, admins included. A pull request can be merged once both CI jobs in
`.github/workflows/ci.yml` pass:

- `lint-and-test`: ESLint and the Jest unit tests
- `integration`: the service layer against a real `lomod` (see `integration/README.md`)

No review approval is required, so you can merge your own pull request.

```bash
git switch -c fix/short-description origin/master
# ...commit...
git push -u origin HEAD
gh pr create --fill
gh pr merge --auto --squash   # merges by itself once CI is green
```

The remote branch is deleted automatically when the pull request merges.

## Branches by default, worktrees for parallel work

Work on a branch in your main checkout. That checkout already has
`node_modules` and the generated `android/` and `ios/` projects, which are slow
to recreate.

Use `git worktree` only when two changes must be in progress at once and the
main checkout cannot be switched, for example it has uncommitted work or a
native build is using it. A new worktree has none of the installed or
generated files, so run `npm install` in it before pushing; the pre-push hook
needs it. Keep worktrees outside the repository directory and remove them when
the branch merges (`git worktree remove <path>`).

## Pre-push hook

`npm install` points git at `.githooks/`. The `pre-push` hook runs the same
checks as the `lint-and-test` job (`npm run lint && npm test -- --ci`), so a
red pull request is caught before the push. It takes about 20 seconds. It
prints errors only, and is skipped when a push only deletes branches.

It does not run the integration tests. To run them locally, see
`integration/README.md`.

Skip the hook once with `git push --no-verify`. CI still gates the merge.

## When CI itself is broken

If a check fails for reasons unrelated to the change (for example the
`lomod-test` image cannot be pulled), a repository admin can tick
"Merge without waiting for requirements to be met" on the pull request. Say
why in the pull request when you do.
