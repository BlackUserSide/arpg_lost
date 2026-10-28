import * as Phaser from 'phaser';
import { canActivateAltar, timeLeft } from '../core/run/run';
import type { MapsData, RunState } from '../core/run/types';
import type { Content } from '../core/world/content';
import { getMob, type MobState } from '../core/world/world';
import { t } from '../i18n';
import { mobName } from './contentText';
import { formatCountdown, runInfoLine, urgentFrom } from './runText';
import { touchControlsOn } from './touchMode';
import { densityOf, fitText, label, makeButton, pinToScreen, UI } from './ui';

// Map run HUD (docs/design/maps.md): the countdown (always visible, flashes on time warnings), the line under it
// (map, room, wave / door / altar), the boss life bar, and the "awaken the altar" action button (tap or F).
// Render-only: reads core run state every frame, sends nothing but the button press.

const DEPTH = 10005;
const TIMER_COLOR = '#f3d58a';
const URGENT_COLOR = '#ff6a4a';
const FLASH_TIME = 1.2;
const BOSS_FILL = 0xc0281e;
const BOSS_LAG = 0xffe0c0;
/** How fast the trailing "recent damage" part of the boss bar catches up (1/s, exponential). */
const BOSS_LAG_RATE = 3;
/** Phase thresholds on the boss bar: gold notch ahead, dim once passed. */
const PHASE_MARK = 0xffd36a;
const PHASE_MARK_PASSED = 0x6a5a3a;
/** Immune roar (phase change pause): the bar pulses between these. */
const BOSS_IMMUNE = [0x7a4ac8, 0xb08aff] as const;

export class RunHud {
  private readonly timer: Phaser.GameObjects.Text;
  private readonly info: Phaser.GameObjects.Text;
  private readonly bossBar: Phaser.GameObjects.Graphics;
  private readonly bossName: Phaser.GameObjects.Text;
  private awaken: Phaser.GameObjects.Container | undefined;
  private compact = false;
  private touchClusterTop: number | undefined;
  private width = 0;
  private height = 0;
  private infoMaxW = 0;
  private bossRect = { x: 0, y: 0, w: 0, h: 0 };
  private shownSecond = -1;
  /** The info line is rebuilt only when what it says changes: room, phase or waves spawned (-1: rebuild). */
  private shownRoom = -1;
  private shownPhase = '';
  private shownWaves = -1;
  /** Seconds left from which the timer is urgent (computed once). */
  private readonly urgentAt: number;
  private shownUrgent = false;
  private shownBossDef = '';
  private flash = 0;
  private bossLag = 1;
  private time = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly maps: MapsData,
    private readonly onAwaken: () => void,
    /** Mob defs: the boss bar marks the boss's phase thresholds (MobDef.abilities.phases). */
    private readonly content: Content,
  ) {
    this.timer = pinToScreen(
      scene.add.text(0, 0, '', { fontFamily: UI.headingFont, fontStyle: 'bold', fontSize: '40px', color: TIMER_COLOR, stroke: '#000', strokeThickness: 6 }).setOrigin(0.5),
      DEPTH,
    );
    this.info = pinToScreen(label(scene, 0, 0, '', UI.size.small, UI.text, true).setOrigin(0.5, 0), DEPTH);
    this.info.setStroke('#000', 4);
    this.bossBar = pinToScreen(scene.add.graphics(), DEPTH);
    this.bossName = pinToScreen(label(scene, 0, 0, '', 12, UI.text, true).setOrigin(0.5), DEPTH + 1);
    this.bossName.setStroke('#000', 3);
    this.urgentAt = urgentFrom(maps);
  }

  /**
   * `rightReserved`: screen width taken by the buttons in the top right corner; the centre column stays clear of it.
   * `touchClusterTop`: touch layout, top edge of the skill button cluster in the bottom right (the altar button goes
   * above it); absent in the desktop layout. `top`: px the HUD starts below the screen top (safe area, or under the
   * corner buttons on narrow screens).
   */
  layout(width: number, height: number, rightReserved: number, touchClusterTop?: number, top = 0): void {
    this.width = width;
    this.height = height;
    this.touchClusterTop = touchClusterTop;
    const compact = width < 820 || height < 520;
    this.compact = compact;
    const phone = densityOf(width, height, compact) === 'phone';
    const margin = (phone ? 2 : compact ? 6 : 14) + top;
    // Centred origin: the warning pulse grows the timer both ways instead of into the info line under it.
    this.timer.setFontSize(phone ? 24 : compact ? 30 : 42);
    if (this.timer.text === '') this.timer.setText('0:00');
    this.timer.setPosition(width / 2, margin + this.timer.height / 2);
    this.infoMaxW = Math.max(160, 2 * (width - rightReserved - width / 2) - 24);
    const infoY = margin + (phone ? 27 : compact ? 34 : 48);
    this.info.setFontSize(compact ? 13 : UI.size.small).setPosition(width / 2, infoY);
    this.shownRoom = -1;
    const barW = Math.min(compact ? 300 : 460, this.infoMaxW);
    const barH = compact ? 14 : 18;
    this.bossRect = { x: width / 2 - barW / 2, y: infoY + (phone ? 18 : compact ? 22 : 26), w: barW, h: barH };
    this.bossName.setPosition(width / 2, this.bossRect.y + barH / 2).setFontSize(compact ? 11 : 12);
    this.placeAwaken();
  }

  /** Lowest screen y the HUD uses at the top (things below it, e.g. the points banner, start here). */
  bottom(): number {
    return this.bossRect.y + this.bossRect.h;
  }

  /** A time warning fired: the timer flashes. */
  warn(): void {
    this.flash = FLASH_TIME;
  }

  /** `bossReady`: the boss can appear (its sprites are loaded); until then the awaken button shows dimmed. */
  update(run: RunState, dt: number, bossReady = true): void {
    this.time += dt;
    const left = timeLeft(run, this.maps);
    const second = Math.ceil(left - 1e-6);
    const urgent = left <= this.urgentAt + 1e-6;
    if (second !== this.shownSecond || urgent !== this.shownUrgent) {
      this.shownSecond = second;
      this.shownUrgent = urgent;
      this.timer.setText(formatCountdown(left)).setColor(urgent ? URGENT_COLOR : TIMER_COLOR);
    }
    this.flash = Math.max(0, this.flash - dt);
    // Flash on a warning; in the last 10 seconds the timer beats every second.
    const beat = left <= 10 && run.status === 'active' ? Math.max(0, 1 - (Math.ceil(left) - left) * 4) : 0;
    const flash = this.flash > 0 ? Math.abs(Math.sin((this.flash / FLASH_TIME) * Math.PI * 4)) : 0;
    // Phones: a smaller pulse, so the timer never grows into the info line under it.
    this.timer.setScale(1 + (this.compact ? 0.12 : 0.2) * flash + (this.compact ? 0.06 : 0.1) * beat);
    this.timer.setAlpha(flash > 0 ? 0.6 + 0.4 * (1 - flash) : 1);

    if (run.room !== this.shownRoom || run.phase !== this.shownPhase || run.wavesSpawned !== this.shownWaves) {
      this.shownRoom = run.room;
      this.shownPhase = run.phase;
      this.shownWaves = run.wavesSpawned;
      this.info.setText(runInfoLine(run)).setFontSize(this.compact ? 13 : UI.size.small);
      fitText(this.info, this.infoMaxW);
    }
    this.drawBossBar(run, dt);

    const showAwaken = canActivateAltar(run, this.maps);
    if (showAwaken !== (this.awaken !== undefined)) {
      if (showAwaken) this.createAwaken();
      else {
        this.awaken?.destroy();
        this.awaken = undefined;
      }
    }
    if (this.awaken) this.awaken.setAlpha(bossReady ? 0.85 + 0.15 * Math.sin(this.time * 5) : 0.4);
  }

  private boss(run: RunState): MobState | undefined {
    if (run.bossId === null) return undefined;
    const mobs = run.world.mobs;
    for (let i = 0; i < mobs.length; i++) if (mobs[i]!.id === run.bossId) return mobs[i];
    return undefined;
  }

  private drawBossBar(run: RunState, dt: number): void {
    const g = this.bossBar.clear();
    const boss = this.boss(run);
    if (!boss) {
      this.bossName.setVisible(false);
      this.bossLag = 1;
      return;
    }
    if (boss.defId !== this.shownBossDef) {
      this.shownBossDef = boss.defId;
      this.bossName.setText(mobName(boss.defId));
    }
    this.bossName.setVisible(true);
    const frac = Phaser.Math.Clamp(boss.life / boss.maxLife, 0, 1);
    this.bossLag = frac >= this.bossLag ? frac : this.bossLag + (frac - this.bossLag) * (1 - Math.exp(-BOSS_LAG_RATE * dt));
    const { x, y, w, h } = this.bossRect;
    g.fillStyle(0x000000, 0.75).fillRect(x - 3, y - 3, w + 6, h + 6);
    g.lineStyle(2, 0xc89a3a, 1).strokeRect(x - 3, y - 3, w + 6, h + 6);
    g.fillStyle(0x2a0a08, 1).fillRect(x, y, w, h);
    g.fillStyle(BOSS_LAG, 0.75).fillRect(x, y, w * this.bossLag, h);
    // Immune during a phase change roar: the bar pulses violet.
    const immune = boss.phaseTransition !== undefined;
    g.fillStyle(immune ? BOSS_IMMUNE[Math.floor(this.time * 10) % 2]! : BOSS_FILL, 1).fillRect(x, y, w * frac, h);
    g.fillStyle(0xff8a6a, 0.45).fillRect(x, y, w * frac, Math.max(2, h / 4));
    // Quarter ticks.
    g.fillStyle(0x000000, 0.45);
    for (let i = 1; i < 4; i++) g.fillRect(x + (w * i) / 4, y, 1, h);
    // Phase thresholds: a notch through the bar with small pointers above and below.
    const phases = getMob(this.content, boss.defId).abilities?.phases ?? [];
    for (let i = 0; i < phases.length; i++) {
      const passed = (boss.phase ?? 1) > i + 1;
      const px = Math.round(x + w * phases[i]!.lifeBelow);
      const color = passed ? PHASE_MARK_PASSED : PHASE_MARK;
      g.fillStyle(0x000000, 0.8).fillRect(px - 2, y - 2, 4, h + 4);
      g.fillStyle(color, 1).fillRect(px - 1, y - 2, 2, h + 4);
      g.fillTriangle(px - 4, y - 7, px + 4, y - 7, px, y - 2);
      g.fillTriangle(px - 4, y + h + 7, px + 4, y + h + 7, px, y + h + 2);
    }
  }

  /** Bottom right, above the resource orb: under the right thumb on phones, clear of the hero in the centre. */
  private awakenRect(): { x: number; y: number; w: number; h: number } {
    const compact = this.compact;
    const phone = densityOf(this.width, this.height, compact) === 'phone';
    const w = phone ? 170 : compact ? 190 : 250;
    const h = phone ? 38 : compact ? 40 : 48;
    const margin = phone ? 8 : compact ? 12 : 22;
    // Touch layout: just above the skill buttons.
    if (this.touchClusterTop !== undefined) return { x: this.width - margin - w / 2, y: this.touchClusterTop - (phone ? 10 : compact ? 12 : 18) - h / 2, w, h };
    const orbTop = this.height - margin - (compact ? 38 : 54) * 2 - 12;
    return { x: this.width - margin - w / 2, y: orbTop - (compact ? 18 : 26) - h / 2, w, h };
  }

  private createAwaken(): void {
    const r = this.awakenRect();
    // Touch controls have no F key: the caption only names it with the desktop controls.
    const caption = touchControlsOn(this.scene.game) ? t('run.awaken') : t('run.awakenKey');
    this.awaken = pinToScreen(makeButton(this.scene, r.x, r.y, r.w, r.h, caption, this.onAwaken, 'primary'), DEPTH + 5);
  }

  private placeAwaken(): void {
    if (!this.awaken) return;
    this.awaken.destroy();
    this.createAwaken();
  }
}
