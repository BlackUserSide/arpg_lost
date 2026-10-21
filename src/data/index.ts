import type { Content } from '../core/world/content';
import { arena } from './arena';
import { classes } from './classes';
import { combatConfig } from './combat';
import { mobs } from './mobs';
import { progression } from './progression';

export const content: Content = { combat: combatConfig, classes, mobs, arena, progression };
