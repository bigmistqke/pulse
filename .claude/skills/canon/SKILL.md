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

  The canon works in both directions, and the protocol below spells out each one. Downwards, the theory decides the tests and the code ([section 3](#3-adding-or-changing-behaviour)). Upwards, the code tests the theory ([section 4](#4-fixing-a-defect)): you trace a defect up to the spec, axiom or fact that is missing. A more exact theory may also call for a stronger structure of the canon ([structure](writing-units.md#10-structure)).
- Canon: the documents, `CANON.md` by default, that state the theory as units, linked into a derivation graph that tests cite and a checker holds closed.
- Unit: one claim of the canon, with a kind, a stem and a statement. [The kinds](writing-units.md#1-kinds) lists them.
- Derivation: the edge from a unit to the unit it follows from, by nesting or on a `Derives from:` line. Together, the derivations answer the second of the three things above: why each part is the way it is.
- Flow: how directly the units follow from their parents. In a strong flow, few axioms and facts force many specs, and each "This follows because" sentence is short.
- Owner of the design: the person who decides the project's values. You propose, and the owner judges.
- Session: one run of work by an agent, which starts without the theory and must rebuild it from the canon.

## Protocol

This protocol governs all work on the project. Follow it in every session, for every change and every choice.

`CANON.md` is the project. It states what the system does and why, as claims that tests cite. The code and the tests express the canon and follow from it. The canon is not documentation of the code.

Every session starts without the theory. It does not know why the code is the way it is, and the code cannot tell it. The canon holds the theory. Each session rebuilds the theory from the canon, works under it, and writes back what it decided. The canon is how the project keeps its knowledge from one session to the next.

Documentation goes out of date because nothing checks it. The canon cannot go out of date without the checker failing. Every claim has a test, and the checker reports every claim, test or link that goes stale.

This file holds what every session needs. Two files beside it hold the rest:

- [`writing-units.md`](writing-units.md): how to write, place and test units. Read it before you add, change or move a unit.
- [`checker.md`](checker.md): how to configure and run the checker.

## 1. Authority

1. The canon outranks every other source of intent: the code, the tests, the README, glossaries, decision records, memory, and your own assumptions.
2. Only the owner of the design decides values. Ask whenever the canon does not decide a question.
3. Ask one question at a time, and give your recommended answer with it. If the code or the canon can answer a question, read them instead of asking.
4. The owner changes the project through the canon too. When the owner asks for something the canon forbids, do not carry it out. Name the conflict and the units involved.
5. When the code contradicts the canon, the code has a defect. Follow [section 4](#4-fixing-a-defect).
6. When a test asserts something other than the spec it cites, the spec decides. Correct the test, unless the owner rules that the spec is wrong.
7. When two units contradict each other, the canon is wrong. Ask the owner which claim holds.
8. Change the project in one order: the canon first, then the tests, then the code. This holds when the owner confirms a change, and when you correct a canon that is wrong.
9. No change enters the project unless the canon accounts for it.

## 2. The session

1. At the start, read the root axioms and the facts. Then read every unit that covers the area of your task.
2. Use the canon for every choice you make in the system, internal ones included. An internal choice needs the canon most, because nothing outside the system checks it.
3. When you face a choice, find the units that decide it. Choose the option they force, and cite them in your reasoning.
4. When the units do not decide a choice, the canon lacks a value or a spec. Settle it with the owner of the design through the grill-with-canon skill, which writes the answer into the canon.
5. Before you change code, answer three questions from the units that cover it. They are the three things that whoever holds the [theory](#terms) can do:
   1. What does this code match in the world of the people using the system?
   2. Why is each part the way it is? The derivation lines answer this.
   3. How does the requested change fit what is already there?

   If the canon lacks a claim you need, write the unit. If an answer needs a judgement the canon cannot give, ask the owner of the design.
6. Before the session ends, write every decision you made into the canon. The next session knows only what the canon holds.
7. Write each unit for a reader who has none of your context. That reader is the next session.
8. End the session with `pnpm canon check` clean and `pnpm canon log` clean. Run `pnpm canon lint` on the text you wrote, and fix its findings.

## 3. Adding or changing behaviour

1. Name the existing specs that the new behaviour most resembles.
2. Say whether the change extends or refines them.
3. If it does neither, the change is a patch. Ask the owner of the design before you continue.
4. Name the axiom the behaviour follows from and the facts it relies on.
5. If no axiom yields the behaviour, stop. An axiom is missing. Ask the owner of the design.
6. Write the spec. Under it, nest further specs for parts that deserve their own tests.
7. Write the tests, and see them fail.
8. Write the code.

Tests cannot tell an extension from a patch, because many implementations pass the same tests. Only the canon can.

## 4. Fixing a defect

1. Do not change the code first.
2. Write the test that the defect breaks, and see it fail.
3. Find the spec that covers the situation. If none does, a spec is missing or states too much.
4. Find the axiom or fact that decides the spec. If none does, one is missing. Ask the owner of the design.
5. Write what is missing from the top down: axiom or fact, then spec, then test.
6. Fix the code.

## 5. Exploring

1. Explore outside the implementation: in a prototype, a scratch directory or a separate branch.
2. An experiment makes no claim and commits the project to nothing. The canon does not govern it.
3. A result enters the project only through the canon, in the order of [section 1](#1-authority).
4. When the result of an experiment is in the canon, remove the experiment, or keep it only as a record of the exploration.

## 6. Commits

1. In the message of every commit that changes the implementation, name the ids of the units that the commit serves or changes.
2. Name units by id, such as `spec-a-write-is-visible-before-its-flush`. A commit that retires a unit names it too.
3. `pnpm canon log` lists the commits that change the implementation without naming a unit. With no range, it checks the commits not yet pushed.
