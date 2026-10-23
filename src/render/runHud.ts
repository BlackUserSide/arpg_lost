import * as Phaser from 'phaser';
import { canActivateAltar, timeLeft } from '../core/run/run';
import type { MapsData, RunState } from '../core/run/types';
import type { MobState } from '../core/world/world';
import { t } from '../i18n';
import { mobName } from './contentText';
import { formatCountdown, runInfoLine, timerUrgent } from './runText';
import { fitText, label, makeButton, pinToScreen, UI } from './ui';

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

export class RunHud {
  private readonly timer: Phaser.GameObjects.Text;
  private readonly info: Phaser.GameObjects.Text;
  private readonly bossBar: Phaser.GameObjects.Graphics;
  private readonly bossName: Phaser.GameObjects.Text;
  private awaken: Phaser.GameObjects.Container | undefined;
  private compact = false;
  private width = 0;
  private height = 0;
  private infoMaxW = 0;
  private bossRect = { x: 0, y: 0, w: 0, h: 0 };
  private shownSecond = -1;
  private shownInfo = '';
  private shownUrgent = false;
  private shownBossDef = '';
  private flash = 0;
  private bossLag = 1;
  private time = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly maps: MapsData,
    private readonly onAwaken: () => void,
  ) {
    this.timer = pinToScreen(
      scene.add.text(0, 0, '', { fontFamily: UI.headingFont, fontStyle: 'bold', fontSize: '40px', color: TIMER_COLOR, stroke: '#000', strokeThickness: 6 }).setOrigin(0.5, 0),
      DEPTH,
    );
    this.info = pinToScreen(label(scene, 0, 0, '', UI.size.small, UI.text, true).setOrigin(0.5, 0), DEPTH);
    this.info.setStroke('#000', 4);
    this.bossBar = pinToScreen(scene.add.graphics(), DEPTH);
    this.bossName = pinToScreen(label(scene, 0, 0, '', 12, UI.text, true).setOrigin(0.5), DEPTH + 1);
    this.bossName.setStroke('#000', 3);
  }

  /** `rightReserved`: screen width taken by the buttons in the top right corner; the centre column stays clear of it. */
  layout(width: number, height: number, rightReserved: number): void {
    this.width = width;
    this.height = height;
    const compact = width < 820 || height < 520;
    this.compact = compact;
    const margin = compact ? 6 : 14;
    this.timer.setFontSize(compact ? 30 : 42).setPosition(width / 2, margin);
    this.infoMaxW = Math.max(160, 2 * (width - rightReserved - width / 2) - 24);
    const infoY = margin + (compact ? 34 : 48);
    this.info.setFontSize(compact ? 13 : UI.size.small).setPosition(width / 2, infoY);
    this.shownInfo = '';
    const barW = Math.min(compact ? 300 : 460, this.infoMaxW);
    const barH = compact ? 14 : 18;
    this.bossRect = { x: width / 2 - barW / 2, y: infoY + (compact ? 22 : 26), w: barW, h: barH };
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

  update(run: RunState, dt: number): void {
    this.time += dt;
    const left = timeLeft(run, this.maps);
    const second = Math.ceil(left - 1e-6);
    const urgent = timerUrgent(left, this.maps);
    if (second !== this.shownSecond || urgent !== this.shownUrgent) {
      this.shownSecond = second;
      this.shownUrgent = urgent;
      this.timer.setText(formatCountdown(left)).setColor(urgent ? URGENT_COLOR : TIMER_COLOR);
    }
    this.flash = Math.max(0, this.flash - dt);
    // Flash on a warning; in the last 10 seconds the timer beats every second.
    const beat = left <= 10 && run.status === 'active' ? Math.max(0, 1 - (Math.ceil(left) - left) * 4) : 0;
    const flash = this.flash > 0 ? Math.abs(Math.sin((this.flash / FLASH_TIME) * Math.PI * 4)) : 0;
    this.timer.setScale(1 + 0.25 * flash + 0.12 * beat);
    this.timer.setAlpha(flash > 0 ? 0.6 + 0.4 * (1 - flash) : 1);

    const info = runInfoLine(run);
    if (info !== this.shownInfo) {
      this.shownInfo = info;
      this.info.setText(info).setFontSize(this.compact ? 13 : UI.size.small);
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
    if (this.awaken) this.awaken.setAlpha(0.85 + 0.15 * Math.sin(this.time * 5));
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
    g.fillStyle(BOSS_FILL, 1).fillRect(x, y, w * frac, h);
    g.fillStyle(0xff8a6a, 0.45).fillRect(x, y, w * frac, Math.max(2, h / 4));
    // Quarter ticks.
    g.fillStyle(0x000000, 0.45);
    for (let i = 1; i < 4; i++) g.fillRect(x + (w * i) / 4, y, 1, h);
  }

  /** Bottom right, above the resource orb: under the right thumb on phones, clear of the hero in the centre. */
  private awakenRect(): { x: number; y: number; w: number; h: number } {
    const compact = this.compact;
    const w = compact ? 190 : 250;
    const h = compact ? 40 : 48;
    const margin = compact ? 12 : 22;
    const orbTop = this.height - margin - (compact ? 38 : 54) * 2 - 12;
    return { x: this.width - margin - w / 2, y: orbTop - (compact ? 18 : 26) - h / 2, w, h };
  }

  private createAwaken(): void {
    const r = this.awakenRect();
    // Touch devices have no F key: the caption only names it on desktops.
    const caption = this.scene.sys.game.device.os.desktop ? t('run.awakenKey') : t('run.awaken');
    this.awaken = pinToScreen(makeButton(this.scene, r.x, r.y, r.w, r.h, caption, this.onAwaken, 'primary'), DEPTH + 5);
  }

  private placeAwaken(): void {
    if (!this.awaken) return;
    this.awaken.destroy();
    this.createAwaken();
  }
}
