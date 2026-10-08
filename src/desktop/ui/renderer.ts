// Renderer entry: `?view=panel` is the full panel, `?view=command` the command bar, `?view=bubble` the cursor bubble.

import { panel } from "./panel.ts";
import { command } from "./command.ts";
import { bubble } from "./bubble.ts";

const VIEWS = { panel, command, bubble } as const;
const TITLES: Record<keyof typeof VIEWS, string> = { panel: "Dum", command: "Dum - command bar", bubble: "Dum" };

const asked = new URLSearchParams(location.search).get("view");
const view = asked === "command" || asked === "bubble" ? asked : "panel";
document.documentElement.dataset.view = view;
document.title = TITLES[view];
VIEWS[view]();
