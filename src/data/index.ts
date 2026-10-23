import type { Content } from '../core/world/content';
import { arena } from './arena';
import { classes } from './classes';
import { combatConfig } from './combat';
import { mobs } from './mobs';
import { progression } from './progression';
import { skillLevels } from './skillLevels';
import { supportsData } from './supports';

export const content: Content = { combat: combatConfig, classes, mobs, arena, progression, skillLevels, supports: supportsData };
