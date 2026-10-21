---
name: add-affix
description: Add a new item affix (prefix or suffix) with tiers, weights and allowed slots from the designer's description, plus validation and drop-rate check. Use when the user asks to add/create an affix or item modifier.
---

# Add an affix

Input: the designer's description (stat, prefix/suffix, slots, rough value range, rarity feel). Ask once if prefix/suffix or slots are missing.

1. Read `docs/design/items.md` and the affix schema in `src/data/`. Record the affix in the doc as `> PROPOSAL (agent):` if it is not there yet.
2. Ensure the stat and its modifier type (flat / increased / more, with tags) are supported by `src/core/stats`. If not, stop and describe the required core change.
3. Add the affix to `src/data/` with tiers ordered by item level (min ilvl, value range per tier), drop weights, allowed slot tags, prefix/suffix group (no duplicate group on one item).
4. Extend the data validation test (tiers monotonic, weights > 0, slots valid, unique id/group).
5. Have balance-analyst (or compute inline) report: chance to roll this affix per slot and ilvl, and value vs. comparable affixes.
6. Run `npm test` and the typecheck.
7. Report to the user in Ukrainian with a short tier table.
