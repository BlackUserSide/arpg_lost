---
name: add-skill
description: Add a new active skill or skill modifier (support) to the game from the designer's description — data config, validation test, balance check. Use when the user asks to add/create a skill or skill modifier.
---

# Add a skill or skill modifier

Input: the designer's description (name, class, fantasy, shape, tags, rough numbers). If key info is missing (shape, tags, which class), ask once, briefly, then proceed.

1. Read `docs/design/classes.md` / `docs/design/skill-modifiers.md` and the existing skill data schema in `src/data/`. If the doc lacks this skill, add an entry to the doc marked `> PROPOSAL (agent):` with the user's description.
2. Check whether the skill can be expressed with existing data fields (shape: arc / projectile / area / movement; effects; tags). If it needs a new mechanic, stop and describe the needed core change (that's a task for core-engineer), don't hack it in data.
3. Add the config to `src/data/` following the schema. All numbers go to data.
4. Add or extend the data validation test (id unique, tags valid, references resolve).
5. Delegate a quick balance comparison to balance-analyst (DPS / cost / cooldown vs. other skills of the same class at the same level) or compute it inline if trivial.
6. Run `npm test` and the typecheck.
7. Report to the user in Ukrainian: what was added, key numbers, how it compares to siblings, open questions.
