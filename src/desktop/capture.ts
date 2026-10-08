// One explicitly chosen screen or window, captured once, shown locally, and sent at most once.
// The bytes stay in the main process behind an opaque, expiring token bound to the zone, prompt and
// request they were taken for. Nothing here writes them to disk or logs them.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { sameBinding } from "./draft.ts";
import type { RequestBinding } from "../share-types.ts";
import type { SharedImage } from "../store-types.ts";
import type { CapturePreview, CaptureSource } from "./protocol.ts";

/** The operating system side: list what could be captured, and take one native PNG frame of a listed source. */
export type Capturer = {
  list(): Promise<CaptureSource[]>;
  /** A PNG of the source, or null when it closed since it was listed. Throws when the OS refuses. */
  grab(source: CaptureSource): Promise<Buffer | null>;
};

/** Long enough to read the preview and type a question; short enough that a forgotten one goes away. */
export const CAPTURE_TTL_MS = 5 * 60_000;
/** Base64 of this still fits the 5 MB image limit. */
export const MAX_PNG_BYTES = 3_750_000;
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

type Held = { token: Buffer; png: Buffer; name: string; binding: RequestBinding; expiresAt: number; timer: NodeJS.Timeout };

export class Captures {
  private listed = new Map<string, CaptureSource>();
  private held: Held | null = null;
  /** The binding of the capture being taken right now, before it is held. */
  private taken: RequestBinding | null = null;
  /** Bumped by discard, or by an invalidation of the capture being taken: a grab that finishes after one is thrown away. */
  private generation = 0;

  constructor(
    private readonly capturer: Capturer,
    private readonly ttl = CAPTURE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a preview is currently held, for tests and status. Never exposes the bytes. */
  get holding(): boolean {
    return this.held !== null;
  }

  /** The person asked to share something: list sources. Only listed ids can be captured. */
  async sources(): Promise<CaptureSource[]> {
    const list = await this.capturer.list();
    if (!list.length) throw new Error("No screens or windows are available to share. If Screen Recording is off for dum, turn it on in System Settings, then try again.");
    this.listed = new Map(list.map((s) => [s.id, s]));
    return list;
  }

  /** Capture one chosen source for local preview. A second capture while one is being taken is refused; a new one replaces the held preview. */
  async preview(sourceId: string, binding: RequestBinding): Promise<CapturePreview> {
    if (this.taken) throw new Error("A capture is already being taken - wait for it, or discard it");
    const source = this.listed.get(sourceId);
    if (!source) throw new Error("Choose a screen or window from the current list - that one wasn't offered");
    this.release();
    const generation = ++this.generation;
    this.taken = binding;
    try {
      const png = await this.capturer.grab(source);
      if (generation !== this.generation) {
        png?.fill(0);
        throw new Error("The capture was cancelled before it finished - nothing was kept");
      }
      if (!png) throw new Error(`"${source.name}" isn't available any more - choose it again from a fresh list`);
      if (png.length < PNG.length || !png.subarray(0, PNG.length).equals(PNG)) throw new Error("The system returned something that isn't a PNG image - nothing was kept");
      if (png.length > MAX_PNG_BYTES) {
        png.fill(0);
        throw new Error("That capture is too large to send - choose a single window instead");
      }
      const token = randomBytes(24);
      const expiresAt = this.now() + this.ttl;
      const timer = setTimeout(() => this.release(), this.ttl);
      timer.unref();
      this.held = { token, png, name: source.name, binding: { ...binding }, expiresAt, timer };
      return { token: token.toString("base64url"), name: source.name, dataUrl: `data:image/png;base64,${png.toString("base64")}`, expiresAt };
    } finally {
      this.taken = null;
    }
  }

  /**
   * Hand the held image over for a confirmed Send or Do this, exactly once. The token must be the
   * current one, unexpired, and bound to this zone, prompt and request; a stale token releases the bytes.
   */
  take(token: string, binding: RequestBinding): SharedImage {
    const held = this.held;
    const given = Buffer.from(token, "base64url");
    if (!held || given.length !== held.token.length || !timingSafeEqual(given, held.token)) {
      throw new Error("That capture is no longer held - take it again; nothing was sent");
    }
    if (this.now() >= held.expiresAt) {
      this.release();
      throw new Error("That capture expired - take it again; nothing was sent");
    }
    if (!sameBinding(held.binding, binding)) {
      this.release();
      throw new Error("That capture was taken for a different prompt - take it again; nothing was sent");
    }
    const image: SharedImage = { data: held.png.toString("base64"), mimeType: "image/png", label: held.name };
    this.release();
    return image;
  }

  /** Called whenever the zone, prompt or request changes: a capture, held or still being taken, for anything else is dropped. */
  invalidate(binding: RequestBinding | null): void {
    const stale = (b: RequestBinding | null) => b !== null && !sameBinding(b, binding);
    if (stale(this.taken)) this.generation++;
    if (stale(this.held?.binding ?? null)) this.release();
  }

  /** Discard, cancel, zone switch or quit: drop the held image and any capture in flight. */
  discard(): void {
    this.generation++;
    this.release();
  }

  private release(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    clearTimeout(held.timer);
    held.png.fill(0);
    held.token.fill(0);
  }
}
