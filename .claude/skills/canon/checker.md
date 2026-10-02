# The checker

How to configure and run the canon checker. [`SKILL.md`](SKILL.md) holds the protocol, and `pnpm canon --help` is the manual of the tool.

## 1. Scope

Declare the scope in the `canon` field of `package.json`:

```json
{
  "scripts": { "canon": "node .claude/skills/canon/cli.ts" },
  "canon": {
    "documents": ["CANON.md"],
    "suites": "test/canon",
    "sources": ["src", "test"],
    "references": [],
    "command": "pnpm canon"
  }
}
```

- `documents`: the canon documents. Default `["CANON.md"]`.
- `suites`: the declared suite directory. Every test in it must cite a unit. Default `test/canon`. Keep it flat: a suite answers to a claim, not to a module.
- `sources`: the trees the checker reads for other citations and for the places specs name. Default `["src", "test"]`.
- `references`: prose documents whose links must resolve but credit no unit. Default none.
- `command`: how the project runs the checker, for the advice in findings.

## 2. Commands

```bash
pnpm canon check              # every finding; exits 1 on a finding
pnpm canon generate           # rewrite the generated regions
pnpm canon tree               # the terms, then the facts, then the derivation tree of the axioms
pnpm canon tree -v            # the same, with each unit's statement
pnpm canon tree --gaps        # only the branches that lead to an untested claim
pnpm canon tree --suspect 3   # specs with no nested specs and three or more tests
pnpm canon lint               # language checks on the prose of the documents
pnpm canon log                # commits that change the implementation without naming a unit
```

The examples use `pnpm canon`, the command this project declares in its scope.

1. `pnpm canon --help` lists every finding `check` reports.
2. `check` fails when a generated region is stale. To fix it, run `generate`. The generated regions are the index of each document and the kinds table in [`writing-units.md`](writing-units.md).
3. Add the `toc:begin` and `toc:end` markers to each new canon document, once.
4. `lint` reports passive voice, wordy phrases, repeated words, wrong articles, sentences over 25 words and paragraphs over 5 sentences. Its sentence limit follows ASD-STE100, Simplified Technical English.
5. `check`, `generate` and `tree` need Node 22.18 or later and nothing else. `lint` also needs the project's dev dependencies.
