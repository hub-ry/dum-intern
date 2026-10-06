// Renderer entry: `?view=companion` is the floating pair, `?view=panel` the conversation.

import { companion } from "./companion.ts";
import { panel } from "./panel.ts";

const view = new URLSearchParams(location.search).get("view") === "companion" ? "companion" : "panel";
document.documentElement.dataset.view = view;
document.title = view === "companion" ? "dum" : "dum - conversation";
if (view === "companion") companion();
else panel();
