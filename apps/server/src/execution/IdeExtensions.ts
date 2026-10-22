// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Native editor subprocess and file watcher boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import {
  IdeExtensionInventory,
  IdeExtensionSnapshot as Snapshot,
  IdeExtensionAcknowledgement as Baseline,
  IdeExtensionBuildInput as Build,
  IdeExtensionInstallInput as Install,
  IdeExtensionExportInput as Export,
  IdeExtensionExportReleaseInput as ExportRelease,
} from "@t3tools/contracts";
import { writeIdeFile } from "./IdePreferences.ts";

const NativeIndex = Schema.Array(
  Schema.Struct({
    identifier: Schema.Struct({ id: Schema.String }),
    metadata: Schema.optionalKey(Schema.Struct({ source: Schema.optionalKey(Schema.String) })),
  }),
);
const Inspect = Schema.Struct({ path: Schema.String });
const decodeBaseline = Schema.decodeUnknownSync(Baseline);
const decodeBuild = Schema.decodeUnknownSync(Build);
const decodeExport = Schema.decodeUnknownSync(Export);
const decodeExportRelease = Schema.decodeUnknownSync(ExportRelease);
const decodeIdeExtensionInventory = Schema.decodeUnknownSync(IdeExtensionInventory);
const decodeInspect = Schema.decodeUnknownSync(Inspect);
const decodeInstall = Schema.decodeUnknownSync(Install);
const decodeNativeIndex = Schema.decodeUnknownSync(NativeIndex);
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot);

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

function command(
  binary: string,
  args: string[],
  input?: unknown,
  signal?: AbortSignal,
  timeoutMs = 25 * 60_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("IDE extension executor closed"));
      return;
    }
    const child = NodeChildProcess.spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const terminate = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) reject(error);
        }
      }
    };
    signal?.addEventListener("abort", terminate, { once: true });
    const timeout = setTimeout(terminate, timeoutMs);
    let output = "";
    let diagnostics = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 4 * 1024 * 1024) terminate();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      diagnostics = (diagnostics + chunk).slice(-8192);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", terminate);
      if (code !== 0) reject(new Error(`IDE extension command failed (${code}): ${diagnostics}`));
      else resolve(output);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

export async function openIdeExtensions(directory: string, workerState: string) {
  const record = NodePath.join(directory, "extension-baseline.json");
  const pendingRecord = NodePath.join(directory, "extension-provisioning.json");
  const controller = new AbortController();
  let provisioning = false;
  try {
    await NodeFSP.stat(pendingRecord);
    provisioning = true;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const extensions = NodePath.join(directory, "extensions");
  await NodeFSP.mkdir(extensions, { recursive: true });
  let saved: typeof Baseline.Type | null = null;
  try {
    saved = decodeBaseline(JSON.parse(await NodeFSP.readFile(record, "utf8")));
  } catch (error) {
    if (!missing(error)) throw error;
  }
  let dirty = true;
  let installed: IdeExtensionInventory = {};
  let privateIds: string[] = [];
  let generation = 0;
  let active = 0;
  let queue = Promise.resolve();
  const watcher = NodeFS.watch(extensions, (_event, name) => {
    // Installed package contents don't change the inventory; the native index does.
    if (name === null || name.toString() === "extensions.json" || name.toString() === ".obsolete") {
      dirty = true;
      generation++;
    }
  });
  watcher.on("error", () => {
    dirty = true;
  });
  const native = [
    "--config",
    NodePath.join(directory, "config.yaml"),
    "--user-data-dir",
    NodePath.join(directory, "user-data"),
    "--extensions-dir",
    extensions,
  ];
  const inventory = async () => {
    if (dirty) {
      const before = generation;
      const output = await command("code-server", [
        ...native,
        "--list-extensions",
        "--show-versions",
      ]);
      const next: Record<string, string> = {};
      for (const line of output.split(/\r?\n/)) {
        const match = /^([\w-]+\.[\w-]+)@([^\s]+)$/.exec(line.trim());
        if (match?.[1] && match[2]) next[match[1].toLowerCase()] = match[2];
      }
      installed = decodeIdeExtensionInventory(next);
      try {
        const index = decodeNativeIndex(
          JSON.parse(await NodeFSP.readFile(NodePath.join(extensions, "extensions.json"), "utf8")),
        );
        privateIds = index
          .filter(
            (item) =>
              item.metadata?.source === "vsix" &&
              installed[item.identifier.id.toLowerCase()] !== undefined,
          )
          .map((item) => item.identifier.id.toLowerCase());
      } catch (error) {
        if (!missing(error) || Object.keys(installed).length > 0) throw error;
        privateIds = [];
      }
      dirty = generation !== before;
    }
    return decodeSnapshot({
      provisioning,
      baseline: saved?.baseline ?? null,
      installed,
      privateIds,
      applied: saved?.applied ?? null,
    });
  };
  const stagedPath = async (path: string) => {
    const real = await NodeFSP.realpath(path);
    const root = await NodeFSP.realpath(NodePath.join(workerState, "userdata", "worker-blobs"));
    if (NodePath.dirname(real) !== root)
      throw new Error("Extension input was not staged through the worker");
    return real;
  };
  const python = async (operation: string, input: object): Promise<unknown> =>
    JSON.parse(
      await command(
        "python3",
        ["/opt/t3/ide-extensions/worker.py"],
        {
          ...input,
          operation,
          directory,
        },
        controller.signal,
        operation === "install" ? 60_000 : 25 * 60_000,
      ),
    );
  const execute = async (method: string, input: unknown): Promise<unknown> => {
    if (method === "ide.extensions.read") return inventory();
    if (method === "ide.extensions.acknowledge") {
      const next = decodeBaseline(input);
      saved = next;
      await writeIdeFile(record, JSON.stringify(saved));
      await NodeFSP.rm(pendingRecord, { force: true });
      provisioning = false;
      return inventory();
    }
    if (method === "ide.extensions.build") {
      const request = decodeBuild(input);
      for (const archive of request.archives) await stagedPath(archive.path);
      if (request.previous) await stagedPath(request.previous.path);
      return python("build", request);
    }
    if (method === "ide.extensions.install") {
      const request = decodeInstall(input);
      await stagedPath(request.path);
      await writeIdeFile(pendingRecord, JSON.stringify({ revision: request.revision }));
      provisioning = true;
      const result = await python("install", request);
      dirty = true;
      const current = await inventory();
      saved = { baseline: current.installed, applied: request.revision };
      await writeIdeFile(record, JSON.stringify(saved));
      await NodeFSP.rm(pendingRecord, { force: true });
      provisioning = false;
      return result;
    }
    if (method === "ide.extensions.releaseExport") {
      const request = decodeExportRelease(input);
      const exports = NodePath.resolve(directory, "exports");
      const target = NodePath.resolve(request.path);
      if (
        NodePath.dirname(target) !== exports ||
        !/^vscode-setup-[a-zA-Z0-9_-]+\.tar$/.test(NodePath.basename(target))
      )
        throw new Error("Invalid IDE export path");
      await NodeFSP.rm(target, { force: true });
      return null;
    }
    if (method === "ide.extensions.export") {
      const request = decodeExport(input);
      if (request.bundle) await stagedPath(request.bundle.path);
      return python("export", request);
    }
    if (method === "ide.extensions.inspect") {
      const request = decodeInspect(input);
      await stagedPath(request.path);
      return python("inspect", request);
    }
    throw new Error("Unknown extension operation");
  };
  return {
    execute: (method: string, input: unknown) => {
      const run = queue.then(async () => {
        active++;
        try {
          return await execute(method, input);
        } catch (error) {
          if (method === "ide.extensions.build" || method === "ide.extensions.install")
            await writeIdeFile(
              NodePath.join(directory, "extensions-error.log"),
              error instanceof Error ? error.message.slice(-8192) : "Extension operation failed",
            ).catch(() => {});
          throw error;
        } finally {
          active--;
        }
      });
      queue = run.then(
        () => {},
        () => {},
      );
      return run;
    },
    activity: () => active,
    close: async () => {
      watcher.close();
      controller.abort();
      await queue;
    },
  };
}
