import type { ScheduledTaskWebhookEndpoint } from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

/**
 * Resolves a webhook path against the central service address.
 */
export interface WebhookAddress {
  /** The URL to give a sender, or the bare path when no address is known. */
  readonly address: string;
  /** Whether `address` is a full URL a sender can call. */
  readonly copyable: boolean;
  /** One line on who can reach `address`; null for an explicit public URL. */
  readonly note: string | null;
}

export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
): WebhookAddress {
  if (endpoint.url !== null) {
    return { address: endpoint.url, copyable: true, note: null };
  }
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: "Connect to the central service to resolve its webhook URL.",
    };
  }
  const url = new URL(endpoint.path, httpBaseUrl);
  return {
    address: url.href,
    copyable: true,
    note: isLocalLoopbackHost(url.hostname)
      ? "Only this computer can call this address. Use the deployment's public address for external senders."
      : "The sender must be able to reach this service's address.",
  };
}
