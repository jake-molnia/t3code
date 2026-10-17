import { T3_PROJECT_FILE_NAME, type EnvironmentId, type T3ProjectFile } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import {
  getOptimisticProjectFileQueryData,
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Read and decode the project's checked-in `t3.json`.
 *
 * Imperative counterpart to `useT3ProjectFileState` for the new-thread path,
 * which resolves defaults at call time rather than render time. The passive
 * file query shares the render-time cache and never starts a worker.
 * Cold or revalidating reads wait for observation. Optimistic
 * in-app writes are available immediately and overlay any in-flight result,
 * matching what `useProjectFileQuery` renders. Missing, truncated, or invalid
 * files resolve to null.
 */
export async function readT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  options?: { signal?: AbortSignal },
): Promise<T3ProjectFile | null> {
  const optimistic = getOptimisticProjectFileQueryData(
    environmentId,
    workspaceRoot,
    T3_PROJECT_FILE_NAME,
  );
  if (optimistic !== null) {
    return optimistic.truncated ? null : parseT3ProjectFile(optimistic.contents);
  }
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME, { passive: true }),
    { reportDefect: false, reportFailure: false, ...options },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    T3_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.truncated) return null;
  return parseT3ProjectFile(data.contents);
}
