import { T3_PROJECT_FILE_NAME, type T3ProjectFile } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, type ReactNode, useContext, useMemo } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { getProjectFileQueryAtom, optimisticFileAtom } from "../files/projectFilesQueryState";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { resolveScopedSettingsTargets, selectScopedSettingsEnvironments } from "./scopedSettings";
import {
  resolveSettingsScope,
  isProjectSettingsScope,
  selectProjectSettingsScope,
  type SettingsScopeSearch,
} from "./settingsScope";
import { selectSingleEnvironmentScope } from "./settingsScopeAxis";

/**
 * Each member's decoded t3.json, so file-backed settings show the file as a
 * layer in the inheritance chain. A member is only present once its read has
 * settled; the query atom caches per (environment, cwd).
 */
function useMemberProjectFiles(scope: ReturnType<typeof resolveSettingsScope>) {
  const members = isProjectSettingsScope(scope) ? scope.members : [];
  // A bulk settings visit must not start every project workspace.
  const passive = scope.kind === "all";
  return useAtomValue(
    useMemo(
      () =>
        Atom.make((get) => {
          const files = new Map<string, T3ProjectFile | null>();
          for (const member of members) {
            const result = get(
              getProjectFileQueryAtom(
                member.environmentId,
                member.workspaceRoot,
                T3_PROJECT_FILE_NAME,
                passive ? { passive: true } : undefined,
              ),
            );
            if (result.waiting) continue;
            // A pending in-app save overlays the query, like useProjectFileQuery.
            const data =
              get(
                optimisticFileAtom(
                  member.environmentId,
                  member.workspaceRoot,
                  T3_PROJECT_FILE_NAME,
                ),
              )?.data ?? Option.getOrNull(AsyncResult.value(result));
            files.set(
              member.physicalProjectKey,
              data === null || data.truncated ? null : parseT3ProjectFile(data.contents),
            );
          }
          return files;
        }),
      [members, passive],
    ),
  );
}

function useResolvedSettingsScope(rawSearch: SettingsScopeSearch, projectOnly: boolean) {
  const groups = useSettingsProjectGroups();
  const { environments: availableEnvironments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const search = useMemo(
    () =>
      projectOnly
        ? selectProjectSettingsScope(rawSearch)
        : selectSingleEnvironmentScope(
            {},
            resolveSettingsScope({}, groups, availableEnvironments),
            availableEnvironments,
            primaryEnvironmentId,
          ),
    [availableEnvironments, groups, primaryEnvironmentId, rawSearch, projectOnly],
  );
  const scope = useMemo(
    () => resolveSettingsScope(search, groups, availableEnvironments),
    [availableEnvironments, groups, search],
  );
  const projectFiles = useMemberProjectFiles(scope);
  return useMemo(() => {
    const selected = selectScopedSettingsEnvironments(
      scope,
      availableEnvironments,
      primaryEnvironmentId,
    );
    const targets = resolveScopedSettingsTargets(
      scope,
      selected.connectedEnvironments,
      projectFiles,
    );
    // The representative target supplies display values; project scopes
    // prefer the member on the primary environment, like environments do.
    const target =
      targets.find(
        (candidate) => candidate.environmentId === selected.environment?.environmentId,
      ) ??
      targets[0] ??
      null;
    return { scope, groups, search, ...selected, targets, target };
  }, [availableEnvironments, groups, primaryEnvironmentId, projectFiles, scope, search]);
}

const SettingsScopeContext = createContext<
  | (ReturnType<typeof useResolvedSettingsScope> & {
      singleEnvironment: boolean;
      search: SettingsScopeSearch;
      selectScope: (next: SettingsScopeSearch) => void;
    })
  | null
>(null);

export function SettingsScopeProvider({
  search,
  onChange,
  children,
  singleEnvironment = false,
  projectOnly = true,
}: {
  singleEnvironment?: boolean;
  projectOnly?: boolean;
  search: SettingsScopeSearch;
  onChange: (next: SettingsScopeSearch) => void;
  children: ReactNode;
}) {
  const resolved = useResolvedSettingsScope(search, projectOnly);
  const value = useMemo(
    () => ({ ...resolved, singleEnvironment, selectScope: onChange }),
    [onChange, resolved, singleEnvironment],
  );
  return <SettingsScopeContext value={value}>{children}</SettingsScopeContext>;
}

export function useOptionalSettingsScope() {
  return useContext(SettingsScopeContext);
}

export function useSettingsScope() {
  const scope = useOptionalSettingsScope();
  if (scope === null) throw new Error("Settings scope must be read inside SettingsScopeProvider.");
  return scope;
}
