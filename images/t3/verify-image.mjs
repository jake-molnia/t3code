import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

const manifest = JSON.parse(NodeFS.readFileSync("/opt/t3/providers.lock.json", "utf8"));
const results = [];
function probe(name, binary, args, expected) {
  const result = NodeChildProcess.spawnSync(binary, args, {
    timeout: 60_000,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0)
    throw new Error(`${name} probe failed: ${result.error?.message ?? output}`);
  if (expected && !output.includes(expected))
    throw new Error(`${name} version differs from manifest: ${output}`);
  return output;
}
for (const [driver, spec] of Object.entries(manifest.harnesses)) {
  if (spec.kind === "sdk") {
    const installed = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join("/opt/t3/node_modules", spec.package, "package.json"),
        "utf8",
      ),
    );
    if (installed.version !== spec.version)
      throw new Error(`${driver} SDK version differs from manifest`);
    results.push({ driver, version: installed.version, verified: "package" });
  } else {
    const expectedPath =
      spec.kind === "npm"
        ? NodePath.join("/opt/harnesses/node_modules/.bin", spec.binary)
        : spec.kind === "runtime"
          ? NodePath.join("/usr/local/bin", spec.binary)
          : NodePath.join("/opt/native/bin", spec.binary);
    const realPath = NodeFS.realpathSync(expectedPath);
    const matches = (process.env.PATH ?? "")
      .split(NodePath.delimiter)
      .map((directory) => NodePath.join(directory, spec.binary))
      .filter((candidate) => {
        try {
          NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    if (
      matches.length === 0 ||
      matches.some((candidate) => NodeFS.realpathSync(candidate) !== realPath)
    )
      throw new Error(`${driver} has a missing or competing executable on PATH`);
    if (spec.kind === "npm") {
      const packageRoot = NodeFS.realpathSync(
        NodePath.join("/opt/harnesses/node_modules", spec.package),
      );
      if (!realPath.startsWith(`${packageRoot}/`))
        throw new Error(`${driver} executable is outside its locked package`);
      const installed = JSON.parse(
        NodeFS.readFileSync(NodePath.join(packageRoot, "package.json"), "utf8"),
      );
      if (installed.version !== spec.version)
        throw new Error(`${driver} package differs from manifest`);
    }
    probe(driver, expectedPath, ["--version"], spec.version);
    results.push({
      driver,
      version: spec.version,
      path: expectedPath,
      realPath,
      verified: "executable",
    });
  }
}
for (const [name, spec] of Object.entries(manifest.sourceControl)) {
  if (name === "azure-devops") {
    probe(
      name,
      "az",
      ["extension", "show", "--name", "azure-devops", "--query", "version", "-o", "tsv"],
      spec.version,
    );
    probe(name, "az", ["devops", "--help"]);
  } else probe(name, spec.binary, spec.versionArgs ?? ["--version"], spec.version);
  results.push({ tool: name, version: spec.version, verified: "executable" });
}
probe("Go", "go", ["version"], manifest.development.go);
probe("pnpm", "pnpm", ["--version"], manifest.development.pnpm);
probe("code-server", "code-server", ["--version"], "4.141.0");
probe("AIO", "aiod", ["version"], "0.9.2");
console.log(
  JSON.stringify(
    { platform: manifest.platform, components: results, authenticated: false },
    null,
    2,
  ),
);
