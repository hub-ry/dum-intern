// Dum's actions as provider function definitions, and the names coming back.

import { z } from "zod";
import type { DumAction, WireAction } from "./types.ts";

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Bare names and JSON Schema parameters. A backend that namespaces the wire form does so in its client. */
export function toWireActions(actions: readonly DumAction[]): WireAction[] {
  const seen = new Set<string>();
  return actions.map((action) => {
    if (!NAME.test(action.name)) throw new Error(`Action name ${JSON.stringify(action.name)} isn't a valid function name`);
    if (seen.has(action.name)) throw new Error(`Action ${action.name} is defined twice`);
    seen.add(action.name);
    const { $schema: _, ...parameters } = z.toJSONSchema(z.object(action.schema)) as Record<string, unknown>;
    return { name: action.name, description: action.description, parameters };
  });
}

/** Strips `prefix` from a namespaced wire name; null when the name lacks it or nothing is left. */
export function bareName(wireName: string, prefix: string): string | null {
  if (!wireName.startsWith(prefix)) return null;
  const bare = wireName.slice(prefix.length);
  return NAME.test(bare) ? bare : null;
}
