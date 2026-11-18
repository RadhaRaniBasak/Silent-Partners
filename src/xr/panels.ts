import { Vector3 } from '@iwsdk/core';
import type { HandId } from '../core/game';
import { COLOR, CanvasPlane, FONT, fitSize, plate, textBlock } from './draw';

export interface Button {
  id: string;
  label: string;
  /** Grid cell: column, row, and how many columns it spans. */
  col: number;
  row: number;
  span?: number;
  on?: boolean;
}

export interface PanelContent {
  title: string;
  lines?: string[];
  /** Big centred word, for the end card's stamp. */
  stamp?: string;
  buttons: Button[];
}

const PX_PER_M = 1500;

/**
 * A flat panel you press by poking it with a fingertip. A press fires when a
 * fingertip crosses the surface over a button, then re-arms once it pulls
 * back. Buttons are at least 4 cm tall with 1 cm between them.
 */
export class TouchPanel {
  readonly plane: CanvasPlane;
  private content: PanelContent = { title: '', buttons: [] };
  private readonly armed: Record<HandId, boolean> = { left: true, right: true };
  private readonly hover: Record<HandId, string | null> = { left: null, right: null };
  private readonly local = new Vector3();
  private readonly cols: number;
  private readonly rowH = 0.05;
  private readonly top: number;

  constructor(
    readonly widthM: number,
    readonly heightM: number,
    cols = 2,
    top = 0.075,
  ) {
    this.plane = new CanvasPlane(widthM, heightM, PX_PER_M);
    this.plane.mesh.renderOrder = 15;
    this.cols = cols;
    this.top = top;
    this.plane.mesh.visible = false;
  }

  get visible() {
    return this.plane.mesh.visible;
  }

  show(content: PanelContent | null) {
    this.plane.mesh.visible = !!content;
    if (!content) return;
    this.content = content;
    this.redraw();
  }

  private rect(b: Button) {
    const pad = 0.01;
    const cw = (this.widthM - pad) / this.cols;
    const x = pad + b.col * cw;
    const y = this.top + (this.content.lines?.length ? this.content.lines.length * 0.022 + 0.008 : 0) + (this.content.stamp ? 0.05 : 0) + b.row * this.rowH;
    return { x, y, w: cw * (b.span ?? 1) - pad, h: this.rowH - pad };
  }

  /** Feed a fingertip in world space (or null). Returns a pressed button's id. */
  poke(hand: HandId, tip: Vector3 | null): string | null {
    if (!this.visible || !tip) {
      this.hover[hand] = null;
      // A press only counts after the fingertip has been in front of the panel,
      // so a panel that appears under a finger (record and settings share a
      // spot) can't fire the button the finger is already in.
      this.armed[hand] = false;
      return null;
    }
    const p = this.plane.mesh.worldToLocal(this.local.copy(tip));
    const u = p.x + this.widthM / 2;
    const v = this.heightM / 2 - p.y;
    let hit: Button | null = null;
    for (const b of this.content.buttons) {
      const r = this.rect(b);
      if (u >= r.x && u <= r.x + r.w && v >= r.y && v <= r.y + r.h) hit = b;
    }
    const before = this.hover[hand];
    this.hover[hand] = hit && p.z < 0.07 && p.z > -0.04 ? hit.id : null;
    if (before !== this.hover[hand]) this.redraw();
    if (p.z > 0.02) this.armed[hand] = true;
    if (this.armed[hand] && hit && p.z < 0.006 && p.z > -0.04) {
      this.armed[hand] = false;
      return hit.id;
    }
    return null;
  }

  private redraw() {
    const c = this.content;
    const key = JSON.stringify(c) + this.hover.left + this.hover.right;
    this.plane.draw(key, (ctx, w, h) => {
      const k = PX_PER_M;
      plate(ctx, w, h, 0.86, 0.06);
      ctx.fillStyle = COLOR.text;
      ctx.font = `700 ${fitSize(ctx, c.title, w * 0.9, 0.03 * k, 700)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.title, w / 2, 0.035 * k);
      let y = this.top * k;
      if (c.stamp) {
        ctx.font = `700 ${0.042 * k}px ${FONT}`;
        ctx.fillStyle = c.stamp === 'GHOST' ? COLOR.lark : c.stamp === 'PRO' ? COLOR.rook : COLOR.dim;
        ctx.fillText(c.stamp, w / 2, y + 0.022 * k);
        y += 0.05 * k;
      }
      for (const line of c.lines ?? []) {
        textBlock(ctx, line, w, y + 0.011 * k, fitSize(ctx, line, w * 0.86, 0.017 * k, 400), 400, COLOR.dim);
        y += 0.022 * k;
      }
      // The lines above leave left alignment behind; labels sit centred.
      ctx.textAlign = 'center';
      for (const b of c.buttons) {
        const r = this.rect(b);
        const hot = this.hover.left === b.id || this.hover.right === b.id;
        ctx.fillStyle = hot ? 'rgba(127, 220, 255, 0.45)' : b.on ? 'rgba(46, 196, 182, 0.35)' : 'rgba(255, 255, 255, 0.1)';
        ctx.strokeStyle = hot ? '#ffffff' : 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.roundRect(r.x * k, r.y * k, r.w * k, r.h * k, 0.01 * k);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = COLOR.text;
        ctx.font = `700 ${0.016 * k}px ${FONT}`;
        ctx.fillText(b.label, (r.x + r.w / 2) * k, (r.y + r.h / 2) * k);
      }
    });
  }
}
