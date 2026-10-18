import { useLocation } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ProjectFavicon } from "../ProjectFavicon";
import { InlineButton } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { useOptionalSettingsScope } from "./SettingsScopeContext";

/** App and account pages have no project policy to select. */
export const SETTINGS_DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/settings/appearance",
  "/settings/connections",
  "/settings/diagnostics",
  "/settings/keybindings",
  "/settings/integrations",
  "/settings/open-source-licenses",
  "/settings/archived",
]);

export function SettingsScopeSentence() {
  const context = useOptionalSettingsScope();
  const pathname = useLocation({ select: (location) => location.pathname });
  if (context === null || SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) return null;
  const { search, groups, selectScope } = context;
  const selected = groups.find((group) => group.projectKey === search.project);
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-1.5 px-3 text-base text-muted-foreground sm:px-4">
      Settings for
      <ScopeMenu
        ariaLabel="Project"
        icon={selected ? <ProjectFavicon project={selected} className="size-3.5 shrink-0" /> : null}
        label={
          selected?.displayName ?? (search.project ? "Unavailable project" : "Select a project")
        }
      >
        <MenuRadioGroup
          value={search.project ?? ""}
          onValueChange={(project) => {
            if (typeof project === "string") selectScope({ project });
          }}
        >
          {groups.map((group) => (
            <MenuRadioItem key={group.projectKey} value={group.projectKey} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                <ProjectFavicon project={group} className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </ScopeMenu>
    </p>
  );
}

function ScopeMenu({
  ariaLabel,
  icon,
  label,
  children,
}: {
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={`${ariaLabel}: ${label}`}
        render={<InlineButton tone="picker" />}
        className="min-w-0 max-w-72"
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start">{children}</MenuPopup>
    </Menu>
  );
}
