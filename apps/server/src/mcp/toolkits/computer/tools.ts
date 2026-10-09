import { OrchestratorMcpFailure, McpCapabilityUnavailableError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as C from "../../../../../../packages/contracts/src/sandboxComputer.ts";
import * as SandboxComputer from "../../../computer/SandboxComputer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  SandboxComputer.SandboxComputer,
  ThreadManagementService.ThreadManagementService,
];
const failure = Schema.Union([
  C.SandboxComputerError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
]);
const status = Tool.make("computer_status", {
  description:
    "Inspect the Linux desktop in this thread's sandbox. Descendant threads share their root's desktop. Reports availability, resolution, and supported operations. Requires Agent browser access.",
  parameters: Tool.EmptyParams,
  success: C.SandboxComputerStatus,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
export const ComputerScreenshotTool = Tool.make("computer_screenshot", {
  description:
    "Capture this thread's sandbox desktop as a PNG image. Screen coordinates match the returned width and height. Inspect the image before and after interacting. The desktop is shared with the user and descendant threads.",
  parameters: Tool.EmptyParams,
  success: C.SandboxComputerScreenshot,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
const action = Tool.make("computer_action", {
  description:
    "Control this thread's sandbox desktop. Pass {action:{kind:...}}. Use move/click/drag with screen x,y, type with literal text, press with a key such as enter, hotkey with keys such as ['ctrl','a'], scroll with dx/dy wheel notches (positive dy scrolls up), or wait with seconds up to 10. Drag starts at the current pointer. Keyboard actions target the focused window. Typing non-ASCII text replaces the clipboard. Descendants and the user share this desktop; coordinate actions before changing it. Take a screenshot to verify the result.",
  parameters: Schema.Struct({ action: C.SandboxComputerAction }),
  success: C.SandboxComputerActionResult,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
export const ComputerToolkit = Toolkit.make(status, action);
export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);
