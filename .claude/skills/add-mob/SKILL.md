---
name: add-mob
description: Add a new monster or boss from the designer's description — data config, behaviour from existing AI building blocks, validation, time-to-kill check. Use when the user asks to add/create a mob, enemy or boss.
---

# Add a mob or boss

Input: the designer's description (role: melee/ranged/caster/swarm/boss, attacks, resistances, rough toughness, which maps). Ask once if the role is unclear.

1. Read `docs/design/mobs.md` and the mob schema in `src/data/`. Record the mob in the doc as `> PROPOSAL (agent):` if missing.
2. Express behaviour through existing AI behaviours and skill data. If a new behaviour is needed, stop and describe it as a core task.
3. Add the config to `src/data/` (life, damage, resistances, speed, XP, loot table reference, sprite key). Numbers only in data.
4. Extend the data validation test.
5. Have balance-analyst (or compute inline) report time-to-kill for each class at the intended map level, damage taken per second, and whether a run still fits 3–5 minutes.
6. Run `npm test` and the typecheck. If a sprite is needed, note the placeholder used.
7. Report to the user in Ukrainian.
