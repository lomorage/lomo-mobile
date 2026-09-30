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

## Pre-push hook

`npm install` points git at `.githooks/`. The `pre-push` hook runs the same
checks as the `lint-and-test` job (`npm run lint && npm test -- --ci`), so a
red pull request is caught before the push. It takes about 20 seconds.

It does not run the integration tests. To run them locally, see
`integration/README.md`.

Skip the hook once with `git push --no-verify`. CI still gates the merge.

## When CI itself is broken

If a check fails for reasons unrelated to the change (for example the
`lomod-test` image cannot be pulled), a repository admin can tick
"Merge without waiting for requirements to be met" on the pull request. Say
why in the pull request when you do.
