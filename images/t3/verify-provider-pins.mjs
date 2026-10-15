import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/** Fail the image build before downloading harnesses if its two lockfiles disagree. */
export function verifyProviderPins(manifest, packageJson, lockfile) {
  const expected = {};
  for (const [name, spec] of Object.entries(manifest.harnesses)) {
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(spec.version))
      throw new Error(`${name} must have an exact version`);
    if (spec.kind === "npm") {
      if (expected[spec.package]) throw new Error(`Duplicate harness package: ${spec.package}`);
      expected[spec.package] = spec.version;
      const locked = lockfile.packages[`node_modules/${spec.package}`];
      if (locked?.version !== spec.version || !locked.integrity)
        throw new Error(`${name} has no matching integrity-pinned package`);
    } else if (spec.kind !== "sdk" && spec.kind !== "runtime") {
      if (
        typeof spec.url !== "string" ||
        !spec.url.startsWith("https://") ||
        !/^[a-f0-9]{64}$/.test(spec.sha256)
      )
        throw new Error(`${name} has no checksum-pinned artifact`);
    }
  }
  for (const dependencies of [packageJson.dependencies, lockfile.packages[""].dependencies]) {
    if (
      JSON.stringify(Object.entries(dependencies).sort()) !==
      JSON.stringify(Object.entries(expected).sort())
    )
      throw new Error("Harness manifest, package.json and package-lock.json pins must agree");
  }
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const directory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  const read = (name) => JSON.parse(NodeFS.readFileSync(NodePath.join(directory, name), "utf8"));
  verifyProviderPins(
    read("providers.lock.json"),
    read("harnesses/package.json"),
    read("harnesses/package-lock.json"),
  );
  console.log("Provider image pins agree with the integrity lockfile.");
}
