// Mobile touch controls tunables (docs/design/controls.md, approved 2026-10-26). Read by render only (input feel, not
// combat rules); PROPOSAL numbers, to be tuned on real phones.

export interface TouchControlsTuning {
  /**
   * Auto-aim "nearby" radius in world units: a tap / held basic attack aims at the nearest living enemy whose body is
   * within max(this, the action's own reach); none in range → forward (movement / facing). ~ a phone screen's half.
   * World units at camera zoom 1; a zoomed run view (phoneLayout.runZoom) divides it by the zoom (same screen share).
   */
  readonly autoAimRadius: number;
  /** Share of the stick radius (0..1) the finger must leave the centre by before the hero moves. */
  readonly stickDeadZone: number;
  /** Screen px a finger must drag from where it pressed a skill button before the press becomes manual aiming. */
  readonly aimDragThreshold: number;
  /**
   * Screen px of drag that means full range for distance-aimed skills (traps, Teleport): a shorter drag throws /
   * teleports proportionally closer (designer decision 2026-10-26).
   */
  readonly aimDragRadius: number;
}

export const touchControls: TouchControlsTuning = {
  autoAimRadius: 420,
  stickDeadZone: 0.18,
  aimDragThreshold: 22,
  aimDragRadius: 120,
};

/** Phone detection (designer decision 2026-10-27: phones play in landscape only; tablets and desktops in any). */
export interface PhoneLayoutTuning {
  /**
   * The one "phone-sized" threshold: a shorter side (CSS px) at most this is phone-sized. Phones: ~320..450 (the
   * largest, ~430..450); small tablets (iPad mini 744, Android 7" ~600) stay above. Used for
   * - the phone (device): a touch device whose *screen* is phone-sized (render/touchMode.ts isPhone): landscape lock
   *   and the run zoom;
   * - the phone UI density: a *canvas* that is phone-sized (render/ui.ts densityOf), so a short desktop window gets
   *   the compact phone layout too (designer accepted).
   */
  readonly maxShortSide: number;
  /**
   * World camera zoom in a run on a phone (render/touchMode.ts isPhone: a touch device with a phone-sized screen), so
   * a landscape phone shows more of the room (designer decision 2026-10-27). Desktops (also in a short window or a
   * small portal iframe) and tablets stay at 1. World-space text (damage numbers, names) keeps its screen size; the
   * auto-aim radius scales to stay "about half a phone screen".
   */
  readonly runZoom: number;
}

export const phoneLayout: PhoneLayoutTuning = {
  maxShortSide: 480,
  runZoom: 0.65,
};
