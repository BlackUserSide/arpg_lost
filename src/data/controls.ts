// Mobile touch controls tunables (docs/design/controls.md, approved 2026-10-26). Read by render only (input feel, not
// combat rules); PROPOSAL numbers, to be tuned on real phones.

export interface TouchControlsTuning {
  /**
   * Auto-aim "nearby" radius in world units: a tap / held basic attack aims at the nearest living enemy whose body is
   * within max(this, the action's own reach); none in range → forward (movement / facing). ~ a phone screen's half.
   */
  readonly autoAimRadius: number;
  /** Share of the stick radius (0..1) the finger must leave the centre by before the hero moves. */
  readonly stickDeadZone: number;
  /** Screen px a finger must drag from where it pressed a skill button before the press becomes manual aiming. */
  readonly aimDragThreshold: number;
}

export const touchControls: TouchControlsTuning = {
  autoAimRadius: 420,
  stickDeadZone: 0.18,
  aimDragThreshold: 22,
};
