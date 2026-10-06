// Runs only in the supervised utility process, never in the renderer or window broker.
import { DesktopController } from "./controller.ts";
import { HostRequestSchema, type HostEvent } from "./host-protocol.ts";

const epoch = process.env.DUM_HOST_EPOCH;
if (!epoch) throw new Error("a teaching host must be started by Dum");
const port = process.parentPort;
const post = (message: HostEvent) => {
  if (port) port.postMessage(message);
  else process.send?.(message);
};
let scheduled = false;
let closing = false;
const controller = new DesktopController(() => {
  if (scheduled || closing) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    if (!closing) post({ type: "state", epoch, state: controller.state, inputToken: controller.inputToken, canAttach: controller.canAttach, tree: controller.tree });
  });
});

async function receive(value: unknown) {
  const parsed = HostRequestSchema.safeParse(value);
  if (!parsed.success || parsed.data.epoch !== epoch || closing) return;
  const request = parsed.data;
  try {
    switch (request.op) {
      case "open": await controller.choose(request.root, request.personal, request.mode); break;
      case "send": await controller.send(request.text, request.inputToken, request.image); break;
      case "command": controller.command(request.name, request.argument); break;
      case "panel": controller.panel(request.panel); break;
      case "interrupt": controller.interrupt(); break;
      case "close": closing = true; await controller.close(); break;
    }
    post({ type: "reply", epoch, id: request.id, ok: true });
  } catch (error) {
    post({ type: "reply", epoch, id: request.id, ok: false, error: error instanceof Error ? error.message : "the teaching host couldn't complete that action" });
  }
  if (closing) setImmediate(() => process.exit(0));
}
if (port) port.on("message", event => void receive(event.data));
else process.on("message", value => void receive(value));
process.on("SIGTERM", () => { closing = true; void controller.close().finally(() => process.exit(0)); });
process.on("disconnect", () => { closing = true; void controller.close().finally(() => process.exit(0)); });
post({ type: "ready", epoch });
