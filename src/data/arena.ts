import type { ArenaDef } from '../core/world/content';

// M1 test arena: endless waves. PROPOSAL numbers.
export const arena: ArenaDef = {
  width: 1600,
  height: 1100,
  spawn: {
    firstDelay: 1.5,
    interval: 3,
    batchStart: 3,
    batchGrowth: 0.5,
    maxAlive: 45,
    mobIds: ['zombie', 'zombie', 'runner'],
  },
};
