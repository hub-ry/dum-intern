// Runs only in the supervised utility process, never in the renderer or window broker. Every model
// session lives here; each backend builds its own child environment from this process's
// provider-free one.
import { serve } from "./controller.ts";
import { claudeBackend } from "../agent/claude.ts";
import { chatgptBackend } from "../agent/openai-responses.ts";
import { localBackend } from "../agent/local.ts";

const epoch = process.env.DUM_HOST_EPOCH;
if (!epoch) throw new Error("a teaching host must be started by Dum");

serve({
  epoch,
  backends: ({ claudeExecutable, credential }) => [
    ...(claudeExecutable ? [claudeBackend({ executable: claudeExecutable, credential })] : []),
    chatgptBackend({ credential }),
    localBackend(),
  ],
});
