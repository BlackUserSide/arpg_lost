import { describe, expect, it } from 'vitest';
import { applyRunResult, createCharacter, createProfile, deleteCharacter, validateName, type ProfileRules } from './profile';

const rules: ProfileRules = { maxCharacters: 2, nameMinLength: 2, nameMaxLength: 8 };
const classes = ['warrior', 'mage'];

describe('profile', () => {
  it('creates characters with sequential ids up to the limit', () => {
    const p = createProfile();
    const a = createCharacter(p, { name: 'Aria', classId: 'mage' }, rules, classes);
    const b = createCharacter(p, { name: 'Bob', classId: 'mage' }, rules, classes);
    const c = createCharacter(p, { name: 'Cid', classId: 'warrior' }, rules, classes);
    expect(a.ok && a.character.id).toBe('c1');
    expect(b.ok && b.character.id).toBe('c2');
    expect(c).toEqual({ ok: false, error: 'limit' });
    expect(p.characters).toHaveLength(2);
  });

  it('never reuses ids after deletion', () => {
    const p = createProfile();
    createCharacter(p, { name: 'Aria', classId: 'mage' }, rules, classes);
    expect(deleteCharacter(p, 'c1')).toBe(true);
    const next = createCharacter(p, { name: 'Bea', classId: 'mage' }, rules, classes);
    expect(next.ok && next.character.id).toBe('c2');
    expect(deleteCharacter(p, 'missing')).toBe(false);
  });

  it('validates names', () => {
    expect(validateName('A', rules)).toBe('name-length');
    expect(validateName('TooLongName', rules)).toBe('name-length');
    expect(validateName('Ab<>', rules)).toBe('name-chars');
    expect(validateName('Олег', rules)).toBeNull();
    expect(validateName('  Ok  ', rules)).toBeNull();
  });

  it('rejects unknown classes and trims names', () => {
    const p = createProfile();
    expect(createCharacter(p, { name: 'Aria', classId: 'bard' }, rules, classes)).toEqual({ ok: false, error: 'unknown-class' });
    const r = createCharacter(p, { name: '  Aria ', classId: 'mage' }, rules, classes);
    expect(r.ok && r.character.name).toBe('Aria');
  });

  it('applies run results to character stats and account records', () => {
    const p = createProfile();
    createCharacter(p, { name: 'Aria', classId: 'mage' }, rules, classes);
    applyRunResult(p, 'c1', { kills: 30, duration: 120, died: true });
    applyRunResult(p, 'c1', { kills: 10, duration: 200, died: false, bossKilled: true, mapLevel: 3, clearTime: 190 });
    applyRunResult(p, 'c1', { kills: 5, duration: 150, died: false, bossKilled: true, mapLevel: 2, clearTime: 140 });
    const c = p.characters[0]!;
    expect(c.stats).toEqual({ runs: 3, deaths: 1, kills: 45, longestRun: 200 });
    expect(p.records).toEqual({ bestMapLevel: 3, bossKills: 2, bestClearTime: 140, mostKillsInRun: 30 });
  });

  it('keeps level and XP from the run, also after death', () => {
    const p = createProfile();
    createCharacter(p, { name: 'Aria', classId: 'mage' }, rules, classes);
    applyRunResult(p, 'c1', { kills: 30, duration: 120, died: true, progress: { level: 3, xp: 42 } });
    expect(p.characters[0]).toMatchObject({ level: 3, xp: 42 });
  });
});
