# CI and deploys

`ci.yml` is the release gate. It runs on every push to any branch and on every
pull request.

| Job | Runs on | What it does |
|---|---|---|
| `gate` | macOS | `./sim/run-tests.sh` (every golden/regression suite + `deno lint`), then `./sim/run-fuzz.sh` (500 1v1 + 60 2v2 seeded games, invariant checks) |
| `deploy` | Ubuntu | Only for pushes to `main`, and only after `gate` passes: publishes the repo root to GitHub Pages |

So **the live site is always the last green commit on `main`**. A commit that
fails the gate stays on `main` (and in the Actions tab, marked red) but never
reaches players; fix it with a new commit and the next green run deploys.

macOS because the suites call JavaScriptCore at its macOS path — CI runs the
same `jsc` the maintainers run locally, with no install step to break.

## Working on a branch

`main` is still where finished work lands (the post-commit hook pushes it).
For anything risky, work on a branch instead:

```sh
git switch -c my-change
# ...commit as usual; the hook skips the auto-push off main...
git push -u origin my-change
```

The branch gets the same gate in the Actions tab. Open a pull request into
`main` when it's green; merging it is what deploys.

## Requirements

- Settings → Pages → Build and deployment → Source: **GitHub Actions**.
  With the old "Deploy from a branch" source, GitHub also deploys every push
  to `main` directly, skipping the gate.

## Running the gate locally

```sh
./sim/run-tests.sh
./sim/run-fuzz.sh
```
