// The canonical draft (docs/circle-design.md §9): one per zone, plus the first-run goal draft under a
// null-zone binding. Main owns them in memory only; nothing is written on exit. Every edit is a
// compare-and-swap on the revision, and a draft only sends under the binding it was last edited for:
// a prompt that changed under it keeps the text but has to be looked at again. Send and Do this
// consume it the same way, so one revision commands at most once. Debug chat never uses it.

import type { InputBinding } from "../share-types.ts";
import type { DraftState } from "./protocol.ts";

/** The draft for the goal question, before any zone exists. */
const GOAL = "";

export function sameBinding(a: InputBinding | null, b: InputBinding | null): boolean {
  if (a === null || b === null) return a === b;
  return a.zoneId === b.zoneId && a.zoneEpoch === b.zoneEpoch && a.inputToken === b.inputToken && a.requestId === b.requestId;
}

export class Drafts {
  private readonly drafts = new Map<string, DraftState>();

  /** The draft for whatever `live` belongs to; a fresh empty one when there's none yet. */
  current(live: InputBinding | null): DraftState {
    const draft = this.drafts.get(live?.zoneId ?? GOAL);
    return draft ? structuredClone(draft) : { binding: live, revision: 0, text: "", source: "keyboard", shareIds: [] };
  }

  /**
   * A keyboard edit, compare-and-swap on the revision. It is kept under the binding they edited
   * for: an edit made as the prompt moved stays unsendable until they see it under the new one.
   */
  set(text: string, expectedRevision: number, binding: InputBinding | null, live: InputBinding | null): DraftState {
    if ((binding?.zoneId ?? null) !== (live?.zoneId ?? null)) throw new Error("That draft belongs to a zone that isn't open now - nothing was changed");
    const draft = this.entry(live);
    if (draft.revision !== expectedRevision) throw new Error("The draft changed while you were typing - check it and try again");
    draft.binding = binding;
    draft.text = text;
    draft.source = "keyboard";
    draft.revision++;
    return structuredClone(draft);
  }

  /** Voice fills an empty draft for the binding it was recorded under, and nothing else. */
  voice(text: string, binding: InputBinding, live: InputBinding | null): DraftState {
    if (!sameBinding(binding, live)) throw new Error("The zone or prompt changed while you were talking - that transcript was discarded");
    const draft = this.entry(live);
    if (draft.text.trim()) throw new Error("Your draft isn't empty - that transcript was discarded");
    draft.binding = live;
    draft.text = text;
    draft.source = "voice";
    draft.revision++;
    return structuredClone(draft);
  }

  /**
   * The draft a Send or Do this may consume: the live binding, the revision they saw, and the binding
   * the draft was edited under. A draft whose prompt moved is rebound and refused once, so they see it first.
   */
  ready(binding: InputBinding, revision: number, live: InputBinding | null): DraftState {
    if (!sameBinding(binding, live)) throw new Error("That prompt changed before your message arrived - nothing was sent");
    const draft = this.entry(live);
    if (draft.revision !== revision) throw new Error("The draft changed after you pressed Send - check it and send again");
    if (!sameBinding(draft.binding, live)) {
      draft.binding = live;
      draft.revision++;
      throw new Error("Dum moved on after you wrote this - check your draft and send it again");
    }
    return structuredClone(draft);
  }

  /** A share chosen for this draft's request, or one taken back. */
  share(live: InputBinding, shareId: string, add: boolean): void {
    const draft = this.entry(live);
    draft.shareIds = add ? [...new Set([...draft.shareIds, shareId])] : draft.shareIds.filter((id) => id !== shareId);
    draft.revision++;
  }

  /** The held capture this draft would send, or none. */
  capture(live: InputBinding | null, token: string | null): void {
    const draft = this.drafts.get(live?.zoneId ?? GOAL);
    if (!draft && token === null) return;
    const d = draft ?? this.entry(live);
    if (token === null) delete d.captureToken;
    else d.captureToken = token;
    d.revision++;
  }

  /** After a Send or Do this: the text, shares and capture are gone; the revision keeps counting. */
  sent(live: InputBinding | null): void {
    const draft = this.entry(live);
    draft.text = "";
    draft.source = "keyboard";
    draft.shareIds = [];
    delete draft.captureToken;
    draft.revision++;
  }

  /**
   * The live binding moved: request shares and captures from the old one are void. The text stays,
   * bound to the old prompt until they edit it.
   */
  invalidate(zoneId: string | null): void {
    const draft = this.drafts.get(zoneId ?? GOAL);
    if (!draft || (!draft.shareIds.length && draft.captureToken === undefined)) return;
    draft.shareIds = [];
    delete draft.captureToken;
    draft.revision++;
  }

  /** A zone (and its subtree) was deleted, or the goal draft became a zone. */
  drop(zoneIds: readonly (string | null)[]): void {
    for (const id of zoneIds) this.drafts.delete(id ?? GOAL);
  }

  private entry(live: InputBinding | null): DraftState {
    const key = live?.zoneId ?? GOAL;
    let draft = this.drafts.get(key);
    if (!draft) {
      draft = { binding: live, revision: 0, text: "", source: "keyboard", shareIds: [] };
      this.drafts.set(key, draft);
    }
    return draft;
  }
}
