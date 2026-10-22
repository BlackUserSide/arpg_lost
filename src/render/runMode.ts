// Game-mode rules the run screen follows. Solo pauses the simulation while a hero menu (passive tree)
// is open; a future party mode will not (other players keep playing), so screens must not hardcode it.

export interface RunMode {
  readonly id: 'solo' | 'party';
  /** The simulation stops while a hero menu is open over the run. */
  readonly pauseOnMenus: boolean;
}

export const SOLO_MODE: RunMode = { id: 'solo', pauseOnMenus: true };
