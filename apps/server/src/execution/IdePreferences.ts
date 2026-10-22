// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Native IDE file watching and atomic file publication.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  SandboxIdePreferenceFiles,
  SandboxIdePreferenceReplaceInput,
  SandboxIdePreferencePath,
  SandboxIdePreferenceSnapshot,
  type SandboxIdePreferenceStatus,
} from "@t3tools/contracts";
import {
  portableIdePreference,
  restoreIdePreference,
} from "../agentRuntime/portableIdePreferences.ts";

const decodeReplace = Schema.decodeUnknownSync(SandboxIdePreferenceReplaceInput);
const decodeFiles = Schema.decodeUnknownSync(SandboxIdePreferenceFiles);
const validPath = Schema.is(SandboxIdePreferencePath);
const Read = Schema.Struct({
  after: Schema.optionalKey(Schema.String),
  force: Schema.optionalKey(Schema.Boolean),
});
const Initialize = Schema.Struct({ files: SandboxIdePreferenceFiles });
const EnrollmentIssues = Schema.Array(
  Schema.Struct({ path: Schema.String, reason: Schema.Literals(["conflict", "import_required"]) }),
);
const Acknowledge = Schema.Struct({
  baseline: SandboxIdePreferenceFiles,
  files: SandboxIdePreferenceFiles,
  issues: EnrollmentIssues,
});
const Resolve = Schema.Struct({
  path: SandboxIdePreferencePath,
  choice: Schema.Literals(["workspace", "saved"]),
  files: SandboxIdePreferenceFiles,
});
const decodeEnrollmentIssues = Schema.decodeUnknownSync(EnrollmentIssues);
const decodeRead = Schema.decodeUnknownSync(Read);
const decodeInitialize = Schema.decodeUnknownSync(Initialize);
const decodeAcknowledge = Schema.decodeUnknownSync(Acknowledge);
const decodeResolve = Schema.decodeUnknownSync(Resolve);
const missing = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

export async function writeIdeFile(path: string, text: string) {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

/** Watch portable native files; a read returns cached state unless explicitly refreshed. */
export async function openIdePreferences(directory: string) {
  const user = NodePath.join(directory, "user-data", "User");
  const record = NodePath.join(directory, "preferences-baseline.json");
  await NodeFSP.mkdir(NodePath.join(user, "snippets"), { recursive: true, mode: 0o700 });
  let baseline: SandboxIdePreferenceFiles | null = null;
  try {
    baseline = decodeFiles(JSON.parse(await NodeFSP.readFile(record, "utf8")));
  } catch (cause) {
    if (!missing(cause)) throw cause;
  }
  let snapshot: SandboxIdePreferenceSnapshot = { baseline, files: {}, issues: [] };
  const conflictRecord = NodePath.join(directory, "preference-conflicts.json");
  let conflicts: SandboxIdePreferenceStatus["issues"] = [];
  try {
    conflicts = decodeEnrollmentIssues(JSON.parse(await NodeFSP.readFile(conflictRecord, "utf8")));
  } catch (cause) {
    if (!missing(cause)) throw cause;
  }
  let watcherFailed = false;
  let lastEditAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  const serialize = <A>(run: () => Promise<A>) => {
    const result = queue.then(run);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const revision = () =>
    NodeCrypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const refresh = async () => {
    const files: Record<string, string> = {};
    const issues: Array<(typeof snapshot.issues)[number]> = [];
    let bytes = 0;
    const names = ["settings.json", "keybindings.json"];
    const snippets = await NodeFSP.lstat(NodePath.join(user, "snippets"));
    if (!snippets.isDirectory() || snippets.isSymbolicLink())
      throw new Error("Invalid IDE snippets directory");
    for (const name of (await NodeFSP.readdir(NodePath.join(user, "snippets"))).sort()) {
      const relative = `snippets/${name}`;
      if (validPath(relative)) names.push(relative);
    }
    if (names.length > 128) throw new Error("Too many IDE preference files");
    for (const path of names) {
      try {
        const file = NodePath.join(user, path);
        const stat = await NodeFSP.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid IDE preference file");
        bytes += stat.size;
        if (stat.size > 262144 || bytes > 2 * 1024 * 1024) {
          issues.push({ path, reason: "too_large" });
          continue;
        }
        const portable = portableIdePreference(path, await NodeFSP.readFile(file, "utf8"));
        if (portable === null) issues.push({ path, reason: "invalid_json" });
        else if (portable !== undefined) files[path] = portable;
      } catch (cause) {
        if (!missing(cause)) issues.push({ path, reason: "unavailable" });
      }
    }
    snapshot = { baseline, files, issues: [...issues, ...conflicts] };
    if (watcherFailed)
      snapshot = { ...snapshot, issues: [...snapshot.issues, { path: "", reason: "unavailable" }] };
  };
  await refresh();
  const watcher = NodeFS.watch(user, { recursive: true }, (_event, name) => {
    const path = name?.toString().replaceAll(NodePath.sep, "/");
    if (path !== "snippets" && (!path || !validPath(path))) return;
    lastEditAt = Date.now();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void serialize(refresh).catch(() => {
        snapshot = { ...snapshot, issues: [{ path: "", reason: "unavailable" }] };
      });
    }, 250);
  });
  watcher.on("error", () => {
    watcherFailed = true;
    snapshot = { ...snapshot, issues: [...snapshot.issues, { path: "", reason: "unavailable" }] };
  });
  const observation = () => ({ revision: revision(), snapshot });
  return {
    execute: (method: string, input: unknown) =>
      serialize(async () => {
        if (method === "ide.preferences.read") {
          const request = decodeRead(input);
          if (
            request.force ||
            timer ||
            snapshot.issues.some((issue) => issue.reason === "unavailable")
          ) {
            if (timer) clearTimeout(timer);
            timer = undefined;
            await refresh();
          }
          const result = observation();
          return request.after === result.revision ? { ...result, snapshot: null } : result;
        }
        if (method === "ide.preferences.replace") {
          const { files } = decodeReplace(input);
          if (
            Object.keys(files).length > 128 ||
            Buffer.byteLength(JSON.stringify(files)) > 2 * 1024 * 1024
          )
            throw new Error("Saved IDE preferences exceed the size limit");
          for (const [path, text] of Object.entries(files))
            if (portableIdePreference(path, text) !== text)
              throw new Error("Invalid portable IDE preference");
          await refresh();
          const names = new Set([
            ...Object.keys(files),
            ...Object.keys(snapshot.files),
            ...Object.keys(baseline ?? {}),
            ...snapshot.issues.map((issue) => issue.path).filter(validPath),
          ]);
          for (const path of names) {
            const destination = NodePath.join(user, path);
            const backup = NodePath.join(
              directory,
              "preference-backups",
              `${NodeCrypto.randomUUID()}.jsonc`,
            );
            let local = "";
            let backedUp = false;
            try {
              const stat = await NodeFSP.lstat(destination);
              if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 262144)
                local = await NodeFSP.readFile(destination, "utf8").catch(() => "");
              await NodeFSP.mkdir(NodePath.dirname(backup), { recursive: true, mode: 0o700 });
              await NodeFSP.rename(destination, backup);
              backedUp = true;
            } catch (cause) {
              if (!missing(cause)) throw cause;
            }
            try {
              const text = restoreIdePreference(path, files[path], local);
              if (text !== undefined) await writeIdeFile(destination, text);
            } catch (cause) {
              if (backedUp) await NodeFSP.rename(backup, destination);
              throw cause;
            }
          }
          baseline = files;
          conflicts = [];
          await writeIdeFile(record, JSON.stringify(baseline));
          await writeIdeFile(conflictRecord, JSON.stringify(conflicts));
          await refresh();
          return observation();
        }
        if (method === "ide.preferences.initialize") {
          const request = decodeInitialize(input);
          if (baseline === null) {
            await refresh();
            const existing = new Set([
              ...Object.keys(snapshot.files),
              ...snapshot.issues.map((issue) => issue.path),
            ]);
            for (const [path, text] of Object.entries(request.files)) {
              if (!validPath(path) || portableIdePreference(path, text) !== text)
                throw new Error("Invalid IDE preference");
              const destination = NodePath.join(user, path);
              try {
                await NodeFSP.writeFile(destination, text, { flag: "wx", mode: 0o600 });
              } catch (cause) {
                if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST"))
                  throw cause;
              }
            }
            const initialBaseline = { ...request.files };
            // Existing files are enrolled without adopting them as environment defaults.
            // The user can explicitly import this sandbox from setup management.
            for (const path of existing) {
              const local = snapshot.files[path];
              if (local === undefined) delete initialBaseline[path];
              else initialBaseline[path] = local;
              if (local !== request.files[path])
                conflicts = [...conflicts, { path, reason: "import_required" }];
            }
            baseline = initialBaseline;
            await writeIdeFile(record, JSON.stringify(baseline));
            await writeIdeFile(conflictRecord, JSON.stringify(conflicts));
            await refresh();
          }
          return observation();
        }
        if (method === "ide.preferences.acknowledge") {
          const request = decodeAcknowledge(input);
          // Advance the saved baseline even when a native edit arrived during upload.
          // Reject an acknowledgement if another save has already advanced it.
          await refresh();
          if (JSON.stringify(request.baseline) !== JSON.stringify(baseline)) return observation();
          baseline = request.files;
          conflicts = request.issues;
          await writeIdeFile(record, JSON.stringify(baseline));
          await writeIdeFile(conflictRecord, JSON.stringify(conflicts));
          await refresh();
          return observation();
        }
        if (method === "ide.preferences.resolve") {
          const request = decodeResolve(input);
          await refresh();
          if (baseline === null) throw new Error("IDE preferences have not been initialized");
          if (
            snapshot.issues.some(
              (issue) =>
                issue.path === "" ||
                (issue.path === request.path &&
                  issue.reason !== "conflict" &&
                  issue.reason !== "import_required"),
            )
          )
            throw new Error("Fix the native file before resolving this conflict");
          if (request.choice === "saved") {
            const destination = NodePath.join(user, request.path);
            let local = "";
            try {
              local = await NodeFSP.readFile(destination, "utf8");
            } catch (cause) {
              if (!missing(cause)) throw cause;
            }
            if (local)
              await writeIdeFile(
                NodePath.join(directory, "preference-backups", `${NodeCrypto.randomUUID()}.jsonc`),
                local,
              );
            const text = restoreIdePreference(request.path, request.files[request.path], local);
            if (text === undefined) await NodeFSP.rm(destination, { force: true });
            else await writeIdeFile(destination, text);
          }
          const resolvedBaseline = { ...baseline };
          const saved = request.files[request.path];
          if (saved === undefined) delete resolvedBaseline[request.path];
          else resolvedBaseline[request.path] = saved;
          baseline = resolvedBaseline;
          conflicts = conflicts.filter((issue) => issue.path !== request.path);
          await writeIdeFile(record, JSON.stringify(baseline));
          await writeIdeFile(conflictRecord, JSON.stringify(conflicts));
          await refresh();
          return observation();
        }
        throw new Error("Unknown IDE preference operation");
      }),
    activity: () => ({
      activeOperations:
        baseline !== null &&
        Date.now() - lastEditAt < 30_000 &&
        snapshot.issues.length === 0 &&
        (timer !== undefined || JSON.stringify(snapshot.files) !== JSON.stringify(baseline))
          ? 1
          : 0,
      pendingCallbacks: 0,
    }),
    close: async () => {
      watcher.close();
      if (timer) clearTimeout(timer);
      await queue;
    },
  };
}
