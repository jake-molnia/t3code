import {
  type ResourceMonitorProcessSample,
  type ResourceMonitorSnapshotEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { emptyTelemetryCounters, mergeProcesses, type MergeProcessesResult } from "./Model.ts";

const SERVER_PID = 100;
const BASE_TIME_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-06-17T12:00:00.000Z"));

function processSample(
  input: Partial<ResourceMonitorProcessSample> &
    Pick<ResourceMonitorProcessSample, "pid" | "ppid" | "startTimeMs">,
): ResourceMonitorProcessSample {
  return {
    runTimeMs: 1_000,
    name: `process-${input.pid}`,
    command: `process-${input.pid}`,
    status: "Running",
    cpuPercent: 0,
    cpuTimeMs: 0,
    residentBytes: 1_024,
    virtualBytes: 2_048,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioSemantics: "storage",
    ...input,
  };
}

function nativeSnapshot(
  sampledAtUnixMs: number,
  processes: ReadonlyArray<ResourceMonitorProcessSample>,
  sequence = 1,
): ResourceMonitorSnapshotEvent {
  return {
    version: 3,
    type: "snapshot",
    sequence,
    sampledAtUnixMs,
    collectionDurationMicros: 250,
    scannedProcessCount: processes.length,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 0,
    processes: [...processes],
  };
}

function merge(input: {
  readonly native: ResourceMonitorSnapshotEvent;
  readonly previous?: MergeProcessesResult;
  readonly sidecarPid?: number;
}): MergeProcessesResult {
  return mergeProcesses({
    serverPid: SERVER_PID,
    sidecarPid: Option.fromUndefinedOr(input.sidecarPid),
    fallbackSampledAtMs: input.native.sampledAtUnixMs,
    nativeSnapshot: Option.some(input.native),
    previous: input.previous?.previous ?? new Map(),
    counters: input.previous?.counters ?? emptyTelemetryCounters(),
    updatePrevious: true,
  });
}

describe("resource telemetry process model", () => {
  it("builds complete descendant depths and isolates monitor overhead", () => {
    const result = merge({
      sidecarPid: 900,
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
        processSample({ pid: 200, ppid: SERVER_PID, startTimeMs: 2_000 }),
        processSample({ pid: 201, ppid: 200, startTimeMs: 3_000 }),
        processSample({ pid: 202, ppid: 201, startTimeMs: 4_000 }),
        processSample({ pid: 900, ppid: SERVER_PID, startTimeMs: 5_000 }),
      ]),
    });

    expect(result.processes.map((process) => [process.identity.pid, process.depth])).toEqual([
      [100, 0],
      [200, 1],
      [201, 2],
      [202, 3],
      [900, 1],
    ]);
    expect(result.processes.find((process) => process.identity.pid === 900)?.category).toBe(
      "resource-monitor",
    );
    expect(result.groups.backend.processCount).toBe(4);
    expect(result.groups.monitor.processCount).toBe(1);
    expect(result.groups.monitor.processStarts).toBe(1);
    expect(result.groups.allT3.processStarts).toBe(5);
  });

  it("uses the native timestamp for native cumulative-counter deltas", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({
          pid: SERVER_PID,
          ppid: 1,
          startTimeMs: 1_000,
          cpuTimeMs: 1_000,
        }),
      ]),
    });
    const second = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 1_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 1_500,
          }),
        ],
        2,
      ),
    });

    expect(second.processes[0]?.cpuPercent).toBe(50);
    expect(second.groups.backend.cpuTimeMs).toBe(500);
  });

  it("derives rates from cumulative counters and preserves I/O semantics", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({
          pid: SERVER_PID,
          ppid: 1,
          startTimeMs: 1_000,
          cpuTimeMs: 1_000,
          ioReadBytes: 10_000,
          ioWriteBytes: 20_000,
          ioSemantics: "all-io",
        }),
      ]),
    });
    const second = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 1_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 1_250,
            ioReadBytes: 12_000,
            ioWriteBytes: 23_000,
            ioSemantics: "all-io",
          }),
        ],
        2,
      ),
    });
    const server = second.processes[0]!;

    expect(server.cpuPercent).toBe(25);
    expect(server.ioReadBytesPerSecond).toBe(2_000);
    expect(server.ioWriteBytesPerSecond).toBe(3_000);
    expect(server.ioSemantics).toBe("all-io");
    expect(second.groups.backend.cpuTimeMs).toBe(250);
    expect(second.groups.backend.ioReadBytes).toBe(2_000);
    expect(second.groups.backend.ioWriteBytes).toBe(3_000);
  });

  it("derives deltas at the 15-second sampling gap", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({
          pid: SERVER_PID,
          ppid: 1,
          startTimeMs: 1_000,
          cpuTimeMs: 1_000,
          ioReadBytes: 10_000,
          ioWriteBytes: 20_000,
        }),
      ]),
    });
    const second = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 15_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 2_500,
            ioReadBytes: 25_000,
            ioWriteBytes: 50_000,
          }),
        ],
        2,
      ),
    });

    expect(second.processes[0]?.cpuPercent).toBe(10);
    expect(second.processes[0]?.ioReadBytesPerSecond).toBe(1_000);
    expect(second.processes[0]?.ioWriteBytesPerSecond).toBe(2_000);
    expect(second.groups.backend.cpuTimeMs).toBe(1_500);
    expect(second.groups.backend.ioReadBytes).toBe(15_000);
    expect(second.groups.backend.ioWriteBytes).toBe(30_000);
  });

  it("resets deltas when counters decrease or the sampling gap is unsafe", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({
          pid: SERVER_PID,
          ppid: 1,
          startTimeMs: 1_000,
          cpuTimeMs: 1_000,
          ioReadBytes: 10_000,
          ioWriteBytes: 20_000,
        }),
      ]),
    });
    const decreased = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 1_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 100,
            ioReadBytes: 100,
            ioWriteBytes: 200,
          }),
        ],
        2,
      ),
    });
    const delayed = merge({
      previous: decreased,
      native: nativeSnapshot(
        BASE_TIME_MS + 90_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 10_000,
            ioReadBytes: 100_000,
            ioWriteBytes: 200_000,
          }),
        ],
        3,
      ),
    });

    expect(decreased.processes[0]?.cpuPercent).toBe(0);
    expect(decreased.processes[0]?.ioReadBytesPerSecond).toBe(0);
    expect(decreased.processes[0]?.ioWriteBytesPerSecond).toBe(0);
    expect(delayed.processes[0]?.cpuPercent).toBe(0);
    expect(delayed.processes[0]?.ioReadBytesPerSecond).toBe(0);
    expect(delayed.processes[0]?.ioWriteBytesPerSecond).toBe(0);
    expect(delayed.groups.backend.cpuTimeMs).toBe(0);
    expect(delayed.groups.backend.ioReadBytes).toBe(0);
    expect(delayed.groups.backend.ioWriteBytes).toBe(0);
  });

  it("treats reused PIDs as an exit plus a new process", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
        processSample({ pid: 200, ppid: SERVER_PID, startTimeMs: 2_000 }),
      ]),
    });
    const second = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 1_000,
        [
          processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
          processSample({
            pid: 200,
            ppid: SERVER_PID,
            startTimeMs: 9_000,
            cpuTimeMs: 999,
            ioReadBytes: 999,
            ioWriteBytes: 999,
          }),
        ],
        2,
      ),
    });
    const reused = second.processes.find((process) => process.identity.pid === 200)!;

    expect(reused.identity.startTimeMs).toBe(9_000);
    expect(reused.cpuPercent).toBe(0);
    expect(reused.ioReadBytesPerSecond).toBe(0);
    expect(second.groups.backend.processStarts).toBe(3);
    expect(second.groups.backend.processExits).toBe(1);
  });
});
