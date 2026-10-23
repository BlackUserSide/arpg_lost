import { ESSENCE_CURRENCY, type CraftingRules } from '../core/items/craft';
import { SALVAGE_CURRENCY } from '../core/items/inventory';

// See docs/design/crafting.md. PROPOSAL numbers from the balance pass (tools/sim/crafting.sim.ts, 2026-10-23);
// BALANCE-TBD until the designer signs off.
//
// Shard income per arena run (3 items + ~0.84 supports; salvage 1 / 3 / 8 per item, 3 / 5 / 10 per support tier):
// ~5 at hero level 1 (most magic / rare items and every support kept), ~8 at level 10, ~10 at level 20; ~11 if
// everything is salvaged. Item count, not level, sets the income, so it stays ~10 per run past level 20.
// Targets: the first crafts cost about one run of shards; a 6-affix rare from a normal base ≈ 8 runs at L20; a ring
// with all 6 wanted affixes (any tier) ≈ 35 runs (p50) / 80 (p90), half that from a dropped rare; all 6 wanted at
// tier ≤ 3 (item level 30) ≈ 350 runs, at tier ≤ 2 ≈ 2400: possible, but a long chase. Tiers are capped by item
// level, which only drops raise, so the best bases still have to drop.
// Essence has no source until maps (0.4), so the essence operations stay visible but unaffordable.
// BALANCE-TBD (0.4 maps, no code yet): essence in the end-of-run chest = 0.1 per elite killed + 0.5 per boss kill,
// i.e. 3–6 elites + boss ≈ 0.8–1.1 per cleared map (~0.95), a failed run keeps only the elite share. The "all 6
// wanted" chase needs ~28 essence (p50) next to ~360 shards, so essence and shards run out at about the same pace
// (~30–35 runs each); revisit if essence should be the tighter gate (0.05 per elite + 0.3 per boss ≈ 0.5 per run).

export const craftingRules: CraftingRules = {
  ops: {
    // Keyed by the item's current rarity (designer decision 2026-10-23: magic → rare costs more than normal → magic).
    // BALANCE-TBD: normal → magic 5 (≈ 1 run at L1), magic → rare 12 (≈ 2.4 / 1.5 / 1.2 runs at L1 / L10 / L20; it adds
    // 1–2 affixes, so it stays above one add). `cost` is the fallback.
    upgradeRarity: { cost: { [SALVAGE_CURRENCY]: 5 }, costByRarity: { normal: { [SALVAGE_CURRENCY]: 5 }, magic: { [SALVAGE_CURRENCY]: 12 } }, counted: true },
    // BALANCE-TBD: ≈ 1 run at L10 at counter 0.
    addAffix: { cost: { [SALVAGE_CURRENCY]: 8 }, counted: true },
    // BALANCE-TBD: the chase operation; ~10 of 14 counted crafts on the "all 6 wanted" ring are affix rerolls.
    rerollAffix: { cost: { [SALVAGE_CURRENCY]: 10, [ESSENCE_CURRENCY]: 1 }, counted: true },
    // Designer decision 2026-10-23: value rerolls do not count and never get dearer. BALANCE-TBD: 4 (< 1 run).
    rerollValues: { cost: { [SALVAGE_CURRENCY]: 4 }, counted: false },
    // BALANCE-TBD: remove + add is two counted crafts, so it stays dearer than one reroll for the same result.
    removeAffix: { cost: { [SALVAGE_CURRENCY]: 8, [ESSENCE_CURRENCY]: 1 }, counted: true },
  },
  // BALANCE-TBD: +25% of the base cost per counted craft (the draft +50% put the "all 6 wanted" ring at 56 / 142 runs
  // p50 / p90). An affix reroll costs ≥ 5 runs of L20 income from counter 17 on; geometric growth was rejected: at
  // ×1.1 the tier ≤ 3 chase's p90 explodes to ~100 000 runs, an invisible wall instead of a steady price.
  growth: { kind: 'linear', perCraft: 0.25 },
};
