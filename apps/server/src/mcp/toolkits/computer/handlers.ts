import * as Effect from "effect/Effect";
import * as SandboxComputer from "../../../computer/SandboxComputer.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerToolkit, ComputerScreenshotToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ComputerToolkit, {
  computer_status: McpToolAccess.readsAsCaller(() =>
    Effect.flatMap(SandboxComputer.SandboxComputer, (computer) => computer.status),
  ),
  computer_action: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(SandboxComputer.SandboxComputer, (computer) => computer.action(input.action)),
  ),
});
export const layerScreenshot = McpToolAccess.toLayer(ComputerScreenshotToolkit, {
  computer_screenshot: McpToolAccess.readsAsCaller(() =>
    Effect.flatMap(SandboxComputer.SandboxComputer, (computer) => computer.screenshot),
  ),
});
