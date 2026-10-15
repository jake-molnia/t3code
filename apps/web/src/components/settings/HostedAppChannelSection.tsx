import { HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from "../../branding";
import { buildHostedChannelSelectionUrl } from "../../hostedPairing";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function HostedAppChannelSection() {
  if (HOSTED_APP_CHANNEL === null) return null;

  return (
    <SettingsRow
      {...searchableSetting("update-track")}
      description="Switches the hosted web app channel."
      control={
        <Select
          value={HOSTED_APP_CHANNEL}
          onValueChange={(value) => {
            if ((value !== "latest" && value !== "nightly") || value === HOSTED_APP_CHANNEL) return;
            window.location.assign(buildHostedChannelSelectionUrl({ channel: value }));
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Web app channel">
            <SelectValue>{HOSTED_APP_CHANNEL_LABEL}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="latest">
              Latest
            </SelectItem>
            <SelectItem hideIndicator value="nightly">
              Nightly
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}
