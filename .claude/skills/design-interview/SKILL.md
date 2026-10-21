---
name: design-interview
description: Interview the game designer (the user) in short rounds of questions and write the answers into docs/design/*.md. Use when the user wants to describe a game system, says "ask me questions", "let's fill the design", or names a system to design (combat, items, passives, maps...).
---

# Design interview

The designer has little time to write docs. You ask, they answer briefly, you write the doc. Talk to the user in Ukrainian; write docs in Ukrainian.

## Pick the topic
- If the user named a system — use it. Otherwise pick the next undocumented system needed for the current milestone (M1: combat, stats → M2: classes, items, mobs → M3: passives, progression, skill-modifiers, crafting, maps, hub-ui → M4: controls).
- Read `CLAUDE.md`, `docs/design/README.md`, `docs/design/_template.md` and the existing doc for this system (if any). Don't ask what is already answered there or in CLAUDE.md.

## Rounds
- 3–4 questions per round. Most important / most blocking first (what blocks code comes before flavour).
- Ask each round with the AskUserQuestion tool (the designer prefers clickable options over text): up to 4 questions per call, 2–4 options each, recommended option first with "(Recommended)" in the label and a one-line reason in its description (genre conventions, 3–5 min sessions, mobile, scope of MVP). Labels and descriptions in Ukrainian. The designer can always pick "Other" for a custom answer.
- Fall back to a text round (numbered questions, options `а) б) в)`, recommended marked) only if a question needs more than 4 options or the tool is unavailable.
- Ask about decisions, not wording. Skip questions whose answer doesn't change implementation or feel.
- If an answer conflicts with an earlier decision or a platform constraint, point it out in one line and ask which wins.

## After each round
1. Immediately update `docs/design/<system>.md` (create from template if missing, status `draft`). Write rules as clear statements with numbers-as-intent; the designer's answers are decisions, not proposals.
2. Things you filled in without an explicit answer go as `> PROPOSAL (agent): ...`.
3. Unanswered or deferred items go to "Відкриті питання".
4. Reply with 2–4 lines of what was recorded, then the next round.

## Finish
When the core decisions for the system are covered (or the user says stop): give a short summary, the list of open questions, and suggest the next system. Mark status `approved` only if the user confirms.
