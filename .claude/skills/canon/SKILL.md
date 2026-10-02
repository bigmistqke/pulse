---
name: canon
description: The methodology that governs all work on a project with a CANON.md — the document of axioms, facts, specs and exceptions that is the project itself, which the code and tests express and a checker holds closed. Load at the start of every session and before any work in such a project. Use it for every choice made in the system, internal ones included; before changing an area of the code (read the theory that covers it first); when adding or changing behaviour (place it against the specs it resembles, then derive it from an axiom before writing code); when fixing a bug (trace it up to the missing spec, axiom or fact before touching code); when writing a test; when editing CANON.md; before ending a session (write every decision back into the canon); and when running the canon checker. For a design question the canon does not decide, use the grill-with-canon skill.
---

# Canon

## Terms

- Theory: the knowledge, held by the people who build a program, of how the program meets the world it serves. Peter Naur names it in [Programming as Theory Building](https://gwern.net/doc/cs/algorithm/1985-naur.pdf). Whoever holds the theory can do three things:
  1. Explain how each part of the program matches some affair of the world of the people using it.
  2. Explain why each part is the way it is, and what it would cost to make it otherwise.
  3. Respond to a proposed change by working out how it fits what is already there, instead of patching the place where the change lands.

  Naur argues that the program text cannot carry the theory. He calls a program dead when its builders have left: it still runs, but nobody can change it well. The canon is a best effort to write the theory down. With every change, the project works towards the theory.

  The canon works in both directions, and the protocol below spells out each one. Downwards, the theory decides the tests and the code ([section 4](#4-adding-or-changing-behaviour)). Upwards, the code tests the theory ([section 5](#5-fixing-a-defect)): you trace a defect up to the spec, axiom or fact that is missing. A more exact theory may also call for a stronger structure of the canon ([section 16](#16-structure)).
- Canon: the documents, `CANON.md` by default, that state the theory as units, linked into a derivation graph that tests cite and a checker holds closed.
- Unit: one claim of the canon, with a kind, a stem and a statement. [Section 2](#2-kinds) lists the kinds.
- Derivation: the edge from a unit to the unit it follows from, by nesting or on a `Derives from:` line. Together, the derivations answer the second of the three things above: why each part is the way it is.
- Flow: how directly the units follow from their parents. In a strong flow, few axioms and facts force many specs, and each "This follows because" sentence is short.
- Owner of the design: the person who decides the project's values. You propose, and the owner judges.
- Session: one run of work by an agent, which starts without the theory and must rebuild it from the canon.

## Protocol

This protocol governs all work on the project. Follow it in every session, for every change and every choice.

`CANON.md` is the project. It states what the system does and why, as claims that tests cite. The code and the tests express the canon and follow from it. The canon is not documentation of the code.

Every session starts without the theory. It does not know why the code is the way it is, and the code cannot tell it. The canon holds the theory. Each session rebuilds the theory from the canon, works under it, and writes back what it decided. The canon is how the project keeps its knowledge from one session to the next.

Documentation goes out of date because nothing checks it. The canon cannot go out of date without the checker failing. Every claim has a test, and the checker reports every claim, test or link that goes stale.

## 0. Authority

1. The canon outranks every other source of intent: the code, the tests, the README, glossaries, decision records, memory, and your own assumptions.
2. Only the owner of the design decides values. You propose, and the owner judges. Ask whenever the canon does not decide a question.
3. Ask one question at a time, and give your recommended answer with it. If the code or the canon can answer a question, read them instead of asking.
4. The owner changes the project through the canon too. When the owner asks for something the canon forbids, do not carry it out. Name the conflict and the units involved.
5. If the owner confirms, change the canon first. Then change the tests, and then the code.
6. When the code contradicts the canon, the code has a defect. Follow section 5.
7. When a test asserts something other than the spec it cites, the spec decides. Correct the test, unless the owner rules that the spec is wrong.
8. When two units contradict each other, the canon is wrong. Ask the owner which claim holds, and correct the canon.
9. When the canon is wrong, correct the canon first. Then correct the tests, and then the code.
10. No change enters the project unless the canon accounts for it.

## 1. The session

1. At the start, read the root axioms and the facts. Then read every unit that covers the area of your task.
2. Use the canon for every choice you make in the system, internal ones included. An internal choice needs the canon most, because nothing outside the system checks it.
3. When you face a choice, find the units that decide it. Choose the option they force, and cite them in your reasoning.
4. When the units do not decide a choice, the canon lacks a value or a spec. Settle it with the owner of the design through the grill-with-canon skill, which writes the answer into the canon.
5. Before the session ends, write every decision you made into the canon. The next session knows only what the canon holds.
6. Write each unit for a reader who has none of your context. That reader is the next session.
7. Name in every commit the units the commit serves or changes. Follow section 7.
8. End the session with `pnpm canon check` clean and `pnpm canon log` clean. Run `pnpm canon lint` on the text you wrote, and fix its findings.

## 2. Kinds

<!-- kinds:begin — generated by `canon generate`; edits are overwritten -->
| tag | what it is | cites |
| --- | --- | --- |
| `@axiom` | a value: how the project wants the world of the people using it to be — never a decision about how to build it | nothing — may narrow `@axiom` |
| `@fact` | how the platform the project is built on is, whatever the project does | nothing |
| `@spec` | what the system does, stated so a test could contradict it, and optionally the place in the code that does it | `@axiom` or `@spec` — may cite `@fact` |
| `@exception` | where a fact keeps a spec from holding fully | `@spec` and `@fact` |
| `@term` | a word of the project's language: what the thing it names is, in one sentence — never what it does | nothing |
<!-- kinds:end -->

Tell the kinds apart with two questions:

1. Does the claim still hold if someone rebuilt the system with different internals? Then it is an axiom.
2. Does the claim still hold if nobody had built the system? Then it is a fact.
3. A claim that fails both questions is a decision or a behaviour: a spec.
4. A definition of a word makes no claim. It is a term.

Axioms state how the world should be. Facts state how the platform is. A spec, together with the facts it cites, must make its axiom hold. The split follows [Zave and Jackson](http://www.pamelazave.com/4dc.pdf).

## 3. Before you change code

1. Read the units that cover the area you will change.
2. Answer three questions from them. They are the three things that whoever holds the [theory](#terms) can do:
   1. What does this code match in the world of the people using the system?
   2. Why is each part the way it is? The derivation lines answer this.
   3. How does the requested change fit what is already there?
3. If the canon lacks a claim you need, write the unit.
4. If an answer needs a judgement the canon cannot give, ask the owner of the design.
5. Do all this before you edit code.

## 4. Adding or changing behaviour

1. Name the existing specs that the new behaviour most resembles.
2. Say whether the change extends or refines them.
3. If it does neither, the change is a patch. Ask the owner of the design before you continue.
4. Name the axiom the behaviour follows from and the facts it relies on.
5. If no axiom yields the behaviour, stop. An axiom is missing. Ask the owner of the design.
6. Write the spec. Under it, nest further specs for parts that deserve their own tests.
7. Write the tests, and see them fail.
8. Write the code.

Tests cannot tell an extension from a patch, because many implementations pass the same tests. Only the canon can.

## 5. Fixing a defect

1. Do not change the code first.
2. Write the test that the defect breaks, and see it fail.
3. Find the spec that covers the situation. If none does, a spec is missing or states too much.
4. Find the axiom or fact that decides the spec. If none does, one is missing. Ask the owner of the design.
5. Write what is missing from the top down: axiom or fact, then spec, then test.
6. Fix the code.

## 6. Exploring

1. Explore outside the implementation: in a prototype, a scratch directory or a separate branch.
2. An experiment makes no claim and commits the project to nothing. The canon does not govern it.
3. A result enters the project only through the canon: first the units, then the tests, then the code.
4. When the result of an experiment is in the canon, remove the experiment, or keep it only as a record of the exploration.

## 7. Commits

1. In the message of every commit that changes the implementation, name the ids of the units that the commit serves or changes.
2. Name units by id, such as `spec-a-write-is-visible-before-its-flush`. A commit that retires a unit names it too.
3. `pnpm canon log` lists the commits that change the implementation without naming a unit. With no range, it checks the commits not yet pushed.

## 8. Units

1. A unit is a heading with the text `@<kind> <stem>` and nothing after the stem. Its id is `<kind>-<stem>`. Text after the stem breaks the anchor (`unreachable`).
2. Write the stem by hand. You may reword the statement at any time, because citations name the stem.
3. Open the body with the statement as a blockquote.
4. Make every claim about the system a unit. Body text explains its unit's claim and adds no new claim.
5. After a change, read each sentence you added to unit bodies and code comments. A sentence that states something the system does needs a unit.
6. Write in the present tense. History belongs in a decision record.
7. Write a decision record only for a choice that is hard to reverse, surprising without its context, and the result of a real trade-off.

```md
### @spec a-write-is-visible-before-its-flush

> A read after a write returns the written value, before any flush has run.

This follows because …
```

## 9. Derivation

1. The canon is a directed acyclic graph. No unit derives from itself, directly or through other units (`cycle`).
2. Nesting is a citation: a unit inside another unit derives from it. Do not link to the unit that holds your unit.
3. List further parents on one `Derives from:` line, right after the statement. Only links on that line are derivation edges. Every other link is a reference.
4. Make the primary parent the axiom that does most of the forcing. Never make a fact a primary parent.
5. Open a spec's body with its `Derives from:` line, if it has one, then one sentence: "This follows because …".
6. If you cannot write that sentence, an axiom is missing. Ask the owner of the design.
7. Place a spec under the axiom that forces it, not under an axiom on the same topic.
8. Never move a spec because an axiom grew large, or to fit the sections of a document.
9. If the givens allow two designs, a value is missing. Do not promote the decision to an axiom.

```md
### @spec a-style-property-is-removed-on-nothing

> A `style:name` prop whose value is `null`, `undefined` or `false` removes the style property.

Derives from: [`spec-a-style-prefix-sets-one-style-property`](#spec-a-style-prefix-sets-one-style-property)

This follows because a missing value sets nothing: …
```

## 10. Nesting

1. A nested axiom narrows its parent. Open its body with "This narrows … to …".
2. If a nested axiom can only say "this follows because", its parent forces it. Make it a spec.
3. A root axiom must decide at least one real choice between two designs that both work.
4. A nested spec refines its parent: it states one part of the parent more concretely.
5. A spec that follows from another spec without refining it sits under its axiom. It names the other spec on its `Derives from:` line.
6. A parent spec owes a test of its own. Its nested specs do not cover it.
7. Use these heading levels: a root `##`, a nested axiom `###`, a spec `####`, its refinements and exceptions `#####`, one level more `######`.
8. A unit that would sit deeper than six levels names its parent on its `Derives from:` line instead.

## 11. Facts and exceptions

1. A fact is a root and holds no units.
2. A spec or exception names each fact it relies on, on its `Derives from:` line.
3. An exception sits inside the spec it narrows and names the fact that forces it. An exception without a fact fails the check (`freelancing`).
4. A carve-out that no fact forces is a choice. Write it as a spec nested in the spec it refines.
5. An exception lasts as long as its fact. When a library defect forces an exception, pin the exception with `test.fails`. Remove the exception when that test starts failing.
6. A spec that keeps collecting exceptions asks more than the platform gives. Restate the spec.

## 12. Terms

1. A term defines one word of the project's language. Its statement says what the thing is, in one sentence. Never say what it does: behaviour is a spec.
2. Write terms in the `## Terms` section of a canon document, as `### @term <stem>`. Join the words of a stem with hyphens, such as `loading-boundary`. No unit sits in a term, and a term sits in no unit (`misnested`).
3. Choose one word for each concept. List the words to avoid on an `_Avoid_:` line under the statement.
4. Define only words specific to the project. General programming concepts get no term.
5. Link a term from the units whose meaning depends on it. A term that no unit links fails the check (`dead`).
6. Write a term the moment a word's meaning is settled. Do not collect terms for later.
7. To settle a vague or contested word, use the grill-with-canon skill.

```md
### @term present

> The state of the system after every write so far, with nothing still on its way.

_Avoid_: current state, now
```

## 13. Places in the code

1. When one place in the code does what a spec states, the spec opens its statement with that place: `` `queue.ts` `drain`. `` The checker confirms the place exists (`stale-site`).
2. Where two modules share a name, give a path that ends in the file, such as `dom/error.ts`.
3. A place that answers for several specs gets one spec under each. The stem states the claim, not the place.
4. Run `tree --suspect`. It lists specs with many tests and no nested specs. Such a spec probably states several claims. Split it into nested specs.

## 14. Tests

1. Cite the narrowest spec or exception that the assertion could contradict.
2. Cite with a `@canon <id>` tag in the JSDoc of a leaf test. A `describe` block never cites.
3. Cite the id alone, without the file. Ids are unique across all canon documents.
4. Never cite an axiom or a fact (`missing-spec`). Write the missing spec instead.
5. The checker cannot see when a test cites a parent spec where a nested spec states the claim. Catch that in review.
6. A unit leaves the coverage backlog only when a test cites it directly.

```ts
/**
 * @canon spec-drain-runs-each-listener-in-its-own-guard
 */
test('a throwing listener does not stop the next one', () => {
```

## 15. Implementation

1. Source code carries no citations.
2. Open each source file with a block comment: what the file is, how its parts fit, and which axiom it serves.
3. Do not add links from code to the canon. The project tried a tag on each symbol and dropped the tags as too messy. Only a test credits a unit.

## 16. Structure

1. The canon is a living document. While you write the code, the project works towards its theory, and the structure of the canon changes as that theory grows.
2. Restructure the canon whenever a new structure makes the derivations flow more strongly. Signs of a stronger flow:
   1. More units follow from fewer parents.
   2. A missing fact or parent spec turns scattered units into refinements of one claim.
   3. A unit that stood alone as a spec becomes an exception, and shows where a fact pinches.
   4. A "This follows because" sentence gets shorter, because its parent now forces it.
3. The canon is a program that you run when you make a decision. A stronger flow gives stronger guidance, in the canon and in the code that expresses it. Treat such a restructure as an optimisation, and look for chances to make one.
4. A restructure removes no test. Each test that cites a moved or renamed unit cites its new id.
5. A restructure changes no behaviour. If it shows a claim that the code breaks, follow section 5.

## 17. Scope

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

## 18. Commands

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
2. `check` fails when a generated region is stale. To fix it, run `generate`. The generated regions are the index of each document and the kinds table in this file.
3. Add the `toc:begin` and `toc:end` markers to each new canon document, once.
4. `lint` reports passive voice, wordy phrases, repeated words, wrong articles, sentences over 25 words and paragraphs over 5 sentences. Its sentence limit follows ASD-STE100, Simplified Technical English.
5. `check`, `generate` and `tree` need Node 22.18 or later and nothing else. `lint` also needs the project's dev dependencies.
