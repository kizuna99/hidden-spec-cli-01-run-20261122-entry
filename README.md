# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kizuna99/hidden-spec-cli-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kizuna99/hidden-spec-cli-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line tool that applies an edit an AI model wrote to a tree of text files. Models write edits in
four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and
text-editor tool calls as JSON — and mend reads all four to one written specification, finds the lines an edit
names even when the model drifted their whitespace or indentation, and changes every file or none.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22, standard library only; nothing is installed. `main.ts` is the CLI and `runner.ts` beside it is the kit's
trial runner, kept as the kit hands it out. The specification the CLI is built to is the kit's SPEC.md: invocation
and usage errors, output and exit codes, safe paths, format detection, three-tier line matching (exact, trailing
whitespace drift, indentation drift, with re-indentation of new lines at the loosest tier), unified hunks placed by
nearest-to-the-stated-line, SEARCH/REPLACE blocks, V4A sections with anchored chunks and a cursor, JSON edits with
exact string matching, and all-or-nothing writes across the whole patch.

## What a run is judged on

Each run of the CLI is compared on three things only: the exit code, everything written to standard output, and
every file in the tree afterwards, path by path and byte by byte. Standard error is never compared. A patch that
fails in part writes nothing at all: every failure is reported, one line per failed edit in the patch's order, and
the tree is left exactly as it was found.

## Files

- `main.ts` — the CLI
- `runner.ts` — the kit's trial runner (unmodified)
- `LICENSE` — MIT

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
