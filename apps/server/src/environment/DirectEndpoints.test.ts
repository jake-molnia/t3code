import type * as NodeOS from "node:os";
import { describe, expect, it } from "vite-plus/test";

import { resolveBoundEndpoints } from "./DirectEndpoints.ts";

const INTERFACES: ReturnType<typeof NodeOS.networkInterfaces> = {
  lo0: [
    {
      address: "127.0.0.1",
      netmask: "255.0.0.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: true,
      cidr: "127.0.0.1/8",
    },
  ],
  en0: [
    {
      address: "192.168.1.10",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "aa:bb:cc:dd:ee:ff",
      internal: false,
      cidr: "192.168.1.10/24",
    },
    {
      address: "fe80::1",
      netmask: "ffff:ffff:ffff:ffff::",
      family: "IPv6",
      mac: "aa:bb:cc:dd:ee:ff",
      internal: false,
      cidr: "fe80::1/64",
      scopeid: 4,
    },
  ],
  en1: [
    {
      address: "203.0.113.20",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "aa:bb:cc:dd:ee:00",
      internal: false,
      cidr: "203.0.113.20/24",
    },
  ],
  // Tailscale on macOS: an anonymous utun that also carries a Tailscale IPv6 address.
  utun4: [
    {
      address: "100.101.102.103",
      netmask: "255.255.255.255",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: "100.101.102.103/32",
    },
    {
      address: "fd7a:115c:a1e0::1",
      netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      family: "IPv6",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: "fd7a:115c:a1e0::1/128",
      scopeid: 0,
    },
  ],
};

/** A VPN interface with an address from the same 100.64.0.0/10 range. */
const vpnInterface = (address: string) => [
  {
    address,
    netmask: "255.255.255.255",
    family: "IPv4" as const,
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/32`,
  },
];

const virtualInterface = (address: string) => [
  {
    address,
    netmask: "255.255.0.0",
    family: "IPv4" as const,
    mac: "02:42:ac:11:00:01",
    internal: false,
    cidr: `${address}/16`,
  },
];

describe("resolveBoundEndpoints", () => {
  it("lists nothing for a loopback-only server", () => {
    expect(resolveBoundEndpoints({ host: undefined, port: 3773, interfaces: INTERFACES })).toEqual(
      [],
    );
    expect(
      resolveBoundEndpoints({ host: "127.0.0.1", port: 3773, interfaces: INTERFACES }),
    ).toEqual([]);
  });

  it("lists every external IPv4 address for a wildcard bind, tagging the tailnet one", () => {
    expect(resolveBoundEndpoints({ host: "0.0.0.0", port: 3773, interfaces: INTERFACES })).toEqual([
      { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" },
      { kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" },
    ]);
  });

  it("skips container and VM networks, which only this machine reaches", () => {
    const interfaces = {
      ...INTERFACES,
      docker0: virtualInterface("172.17.0.1"),
      "br-3f2a1b": virtualInterface("172.18.0.1"),
      virbr0: virtualInterface("192.168.122.1"),
      "vEthernet (WSL)": virtualInterface("172.24.0.1"),
      bridge100: virtualInterface("192.168.64.1"),
      vmbr0: virtualInterface("192.168.1.20"),
    };
    expect(resolveBoundEndpoints({ host: "0.0.0.0", port: 3773, interfaces })).toEqual([
      { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" },
      { kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" },
      { kind: "lan", httpBaseUrl: "http://192.168.1.20:3773/" },
    ]);
  });

  it("tags only addresses on Tailscale's interface as tailnet, not other VPNs in its range", () => {
    const interfaces = {
      en0: INTERFACES.en0,
      tailscale0: vpnInterface("100.70.1.2"),
      CloudflareWARP: vpnInterface("100.96.0.1"),
      utun7: vpnInterface("100.85.0.1"),
    };
    expect(resolveBoundEndpoints({ host: "0.0.0.0", port: 3773, interfaces })).toEqual([
      { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" },
      { kind: "tailnet", httpBaseUrl: "http://100.70.1.2:3773/" },
      { kind: "lan", httpBaseUrl: "http://100.96.0.1:3773/" },
      { kind: "lan", httpBaseUrl: "http://100.85.0.1:3773/" },
    ]);
  });

  it("lists only the bound address for a specific bind", () => {
    expect(
      resolveBoundEndpoints({ host: "100.101.102.103", port: 3773, interfaces: INTERFACES }),
    ).toEqual([{ kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" }]);
  });

  it("never reports a host name, which can resolve to another machine per client", () => {
    for (const host of ["server.local", "devbox", "devbox.home.arpa"]) {
      expect(resolveBoundEndpoints({ host, port: 3773, interfaces: INTERFACES })).toEqual([]);
    }
  });

  it("never reports a public address, which would carry the credential over plain HTTP", () => {
    expect(
      resolveBoundEndpoints({ host: "203.0.113.20", port: 3773, interfaces: INTERFACES }),
    ).toEqual([]);
  });
});
