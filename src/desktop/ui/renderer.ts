// Renderer entry: `?view=window` is the one working window, `?view=circle` the floating circle,
// `?view=bubble` the cursor bubble. Anything else is the working window.

import { windowView } from "./window.ts";
import { circle } from "./circle.ts";
import { bubble } from "./bubble.ts";

const VIEWS = { window: windowView, circle, bubble } as const;
type View = keyof typeof VIEWS;

const asked = new URLSearchParams(location.search).get("view");
const view: View = asked === "circle" || asked === "bubble" ? asked : "window";
document.documentElement.dataset.view = view;
document.title = "Dum";
VIEWS[view]();
