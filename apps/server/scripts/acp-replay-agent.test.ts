// @effect-diagnostics nodeBuiltinImport:off -- Exercise the replay subprocess and its real filesystem writes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

it("commits replay status before the client can close the agent after its final response", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-acp-status-"));
  try {
    const statusPath = NodePath.join(directory, "status.json");
    const preloadPath = NodePath.join(directory, "shutdown-on-status-write.mjs");
    // Observe status at the response boundary, then model a shutdown during any later write.
    NodeFS.writeFileSync(
      preloadPath,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const writeFile = fs.writeFileSync;
const writeOutput = process.stdout.write;
let replied = false;
process.stdout.write = function(chunk, ...args) {
  if (String(chunk).includes('"id":1')) {
    writeFile(process.env.T3_ACP_REPLAY_STATUS_PATH + ".at-response", fs.readFileSync(process.env.T3_ACP_REPLAY_STATUS_PATH));
    replied = true;
  }
  return writeOutput.call(this, chunk, ...args);
};
fs.writeFileSync = function(path, ...args) {
  if (String(path) === process.env.T3_ACP_REPLAY_STATUS_PATH && replied) {
    writeFile(path, "");
    process.exit(0);
  }
  return writeFile(path, ...args);
};
syncBuiltinESMExports();
`,
    );
    const transcript = {
      scenario: "final-response-status",
      entries: [
        { type: "expect_outbound", frame: { kind: "request", method: "initialize", params: {} } },
        { type: "emit_inbound", frame: { kind: "response", method: "initialize", result: {} } },
      ],
    };
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--import",
        preloadPath,
        NodeURL.fileURLToPath(new URL("./acp-replay-agent.ts", import.meta.url)),
      ],
      {
        input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          T3_ACP_REPLAY_TRANSCRIPT: Buffer.from(JSON.stringify(transcript)).toString("base64"),
          T3_ACP_REPLAY_TRANSCRIPT_PATH: undefined,
          T3_ACP_REPLAY_STATUS_PATH: statusPath,
        },
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ id: 1, result: {} });
    for (const path of [statusPath, `${statusPath}.at-response`]) {
      expect(JSON.parse(NodeFS.readFileSync(path, "utf8"))).toEqual({
        scenario: transcript.scenario,
        cursor: 2,
        total: 2,
      });
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
