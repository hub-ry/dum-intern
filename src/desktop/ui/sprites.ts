// Dum and the wizard, drawn from the art files the app icon is made from too.

import internArt from "../../art/intern.txt";
import wizardArt from "../../art/wizard.txt";
import { bounds, framesFor, parse, type Frame, type Sprite } from "../../art-parser.ts";
import { h, reducedMotion } from "./dom.ts";

export const SPRITES = { dum: parse(internArt), wizard: parse(wizardArt) };

/** A still portrait of the idle frame, drawn once and reused as a data URL. */
const portraits = new Map<"dum" | "wizard", string>();
export function portrait(who: "dum" | "wizard"): HTMLImageElement {
  let url = portraits.get(who);
  if (!url) {
    const sprite = SPRITES[who];
    const frame = framesFor(sprite, "idle")[0]!;
    const cols = Math.max(...frame.rows.map((r) => r.length));
    const canvas = document.createElement("canvas");
    const px = 4;
    canvas.width = cols * px;
    canvas.height = frame.rows.length * px;
    const ctx = canvas.getContext("2d")!;
    frame.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const hex = sprite.palette.get(row[x]!);
        if (!hex) continue;
        ctx.fillStyle = `#${hex}`;
        ctx.fillRect(x * px, y * px, px, px);
      }
    });
    url = canvas.toDataURL("image/png");
    portraits.set(who, url);
  }
  return h("img", { class: `portrait portrait-${who}`, src: url, alt: "" });
}

export type DumState = "idle" | "asking" | "thinking" | "building" | "blocked";
export type WizardState = "idle" | "talking" | "pondering";

/** A creature on a canvas at a whole-pixel scale. Animates by swapping frames; still when motion is reduced. */
export class Creature {
  readonly canvas: HTMLCanvasElement;
  private sprite: Sprite;
  private state = "";
  private frames: Frame[] = [];
  private index = 0;
  private timer = 0;
  private cols: number;

  constructor(who: "dum" | "wizard", scale: number) {
    this.sprite = SPRITES[who];
    this.canvas = document.createElement("canvas");
    this.canvas.className = `sprite sprite-${who}`;
    this.canvas.setAttribute("aria-hidden", "true");
    const { cols, rows } = bounds(this.sprite);
    this.cols = cols;
    const dpr = Math.max(1, Math.round(devicePixelRatio || 1));
    this.canvas.width = cols * scale * dpr;
    this.canvas.height = rows * scale * dpr;
    this.canvas.style.width = `${cols * scale}px`;
    this.canvas.style.height = `${rows * scale}px`;
    reducedMotion.addEventListener("change", () => this.restart());
    this.set("idle");
  }

  set(state: DumState | WizardState) {
    if (state === this.state) return;
    this.state = state;
    this.frames = framesFor(this.sprite, state);
    this.restart();
  }

  private restart() {
    clearTimeout(this.timer);
    this.index = 0;
    this.draw(this.frames[0]!);
    if (!reducedMotion.matches && this.frames.length > 1) this.tick();
  }

  /** Idle blinks now and then; every other state alternates its frames at a steady beat. */
  private tick() {
    const wait = this.state === "idle" ? (this.index === 0 ? 4000 + Math.random() * 3000 : 140) : 420;
    this.timer = window.setTimeout(() => {
      this.index = (this.index + 1) % this.frames.length;
      this.draw(this.frames[this.index]!);
      this.tick();
    }, wait);
  }

  private draw(frame: Frame) {
    const ctx = this.canvas.getContext("2d")!;
    const px = this.canvas.width / this.cols;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    frame.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const hex = this.sprite.palette.get(row[x]!);
        if (!hex) continue;
        ctx.fillStyle = `#${hex}`;
        ctx.fillRect(x * px, y * px, px, px);
      }
    });
  }
}
