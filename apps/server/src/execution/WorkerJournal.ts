// @effect-diagnostics nodeBuiltinImport:off -- Durable worker journal owns Node file descriptors and fsync boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { ExecutionEvent, ExecutionResult } from "../../../../packages/contracts/src/execution.ts";

const Record = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    id: Schema.String,
    fingerprint: Schema.String,
    incarnation: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("completed"), id: Schema.String, result: ExecutionResult }),
  Schema.Struct({ kind: Schema.Literal("event"), envelope: ExecutionEvent }),
  Schema.Struct({
    kind: Schema.Literal("ack"),
    incarnation: Schema.String,
    sessionId: Schema.String,
    sequence: Schema.Number,
  }),
  Schema.Struct({ kind: Schema.Literal("sequence"), sequence: Schema.Number }),
]);
type Record = typeof Record.Type;
const decodeRecord = Schema.decodeUnknownSync(Record);
const key = (incarnation: string, sessionId: string) => JSON.stringify([incarnation, sessionId]);
const encoded = (record: Record) => `${JSON.stringify(record)}\n`;
export class JournalCapacityError extends Error {
  constructor() {
    super(
      "Worker replay journal is full; committed event acknowledgements are required before more work can start",
    );
  }
}

/** A single writer owns the retained volume. Compaction never discards unacknowledged provider events. */
export async function openWorkerJournal(
  path: string,
  limits: {
    maxBytes?: number;
    maxReceipts?: number;
    compactAfterBytes?: number;
    incarnation?: string;
  } = {},
) {
  const maxBytes = limits.maxBytes ?? 64 * 1024 * 1024;
  const maxReceipts = limits.maxReceipts ?? 50_000;
  const compactAfterBytes = limits.compactAfterBytes ?? 4 * 1024 * 1024;
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  let contents = "";
  try {
    contents = await NodeFSP.readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const completeLength = contents.lastIndexOf("\n") + 1;
  const truncated = completeLength !== contents.length;
  contents = contents.slice(0, completeLength);
  const operations = new Map<
    string,
    { fingerprint: string; incarnation?: string; result?: ExecutionResult }
  >();
  const events: ExecutionEvent[] = [];
  const bySession = new Map<string, ExecutionEvent[]>();
  const eventBytes = new WeakMap<ExecutionEvent, number>();
  const acknowledgements = new Map<
    string,
    { incarnation: string; sessionId: string; sequence: number }
  >();
  let lastSequence = 0;
  let logicalBytes = 0;
  let physicalBytes = Buffer.byteLength(contents);
  let sinceCompaction = 0;
  const acknowledged = (event: ExecutionEvent) =>
    event.sequence <=
    (acknowledgements.get(key(event.identity.incarnation, event.sessionId))?.sequence ?? 0);
  function apply(record: Record) {
    switch (record.kind) {
      case "accepted":
        operations.set(record.id, {
          fingerprint: record.fingerprint,
          ...(record.incarnation ? { incarnation: record.incarnation } : {}),
        });
        break;
      case "completed": {
        const operation = operations.get(record.id);
        if (!operation) throw new Error("Journal completion without acceptance");
        operation.result = record.result;
        break;
      }
      case "event": {
        const event = record.envelope;
        eventBytes.set(event, Buffer.byteLength(encoded(record)));
        events.push(event);
        const channel = bySession.get(key(event.identity.incarnation, event.sessionId)) ?? [];
        channel.push(event);
        bySession.set(key(event.identity.incarnation, event.sessionId), channel);
        lastSequence = Math.max(lastSequence, event.sequence);
        break;
      }
      case "ack": {
        const id = key(record.incarnation, record.sessionId);
        if ((acknowledgements.get(id)?.sequence ?? 0) < record.sequence)
          acknowledgements.set(id, record);
        break;
      }
      case "sequence":
        lastSequence = Math.max(lastSequence, record.sequence);
        break;
    }
  }
  for (const line of contents.split("\n")) if (line) apply(decodeRecord(JSON.parse(line)));
  let removedReceipts = false;
  if (limits.incarnation)
    for (const [id, operation] of operations) {
      if (operation.incarnation && operation.incarnation !== limits.incarnation) {
        operations.delete(id);
        removedReceipts = true;
      }
    }
  function snapshot(): Record[] {
    const records: Record[] = [{ kind: "sequence", sequence: lastSequence }];
    for (const [id, operation] of operations) {
      records.push({
        kind: "accepted",
        id,
        fingerprint: operation.fingerprint,
        ...(operation.incarnation ? { incarnation: operation.incarnation } : {}),
      });
      if (operation.result) records.push({ kind: "completed", id, result: operation.result });
    }
    for (const acknowledgement of acknowledgements.values())
      records.push({ kind: "ack", ...acknowledgement });
    for (const event of events)
      if (!acknowledged(event)) records.push({ kind: "event", envelope: event });
    return records;
  }
  function recompute() {
    logicalBytes = snapshot().reduce(
      (total, record) => total + Buffer.byteLength(encoded(record)),
      0,
    );
  }
  recompute();
  let file = await NodeFSP.open(path, "a", 0o600);
  if (truncated) {
    await file.truncate(Buffer.byteLength(contents));
    await file.sync();
  }
  async function compact() {
    const text = snapshot().map(encoded).join("");
    const temporary = await NodeFSP.open(`${path}.compact`, "w", 0o600);
    try {
      await temporary.writeFile(text);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await NodeFSP.rename(`${path}.compact`, path);
    const directory = await NodeFSP.open(NodePath.dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await file.close();
    file = await NodeFSP.open(path, "a", 0o600);
    const retained = events.filter((event) => !acknowledged(event));
    events.length = 0;
    bySession.clear();
    for (const event of retained) apply({ kind: "event", envelope: event });
    physicalBytes = Buffer.byteLength(text);
    logicalBytes = physicalBytes;
    sinceCompaction = 0;
  }
  let writes = Promise.resolve();
  function append(record: Record) {
    const write = writes.then(async () => {
      const text = encoded(record);
      const bytes = Buffer.byteLength(text);
      const terminalFailure =
        record.kind === "event" &&
        record.envelope.event !== null &&
        typeof record.envelope.event === "object" &&
        "providerFailure" in record.envelope.event;
      const allowance = maxBytes + (terminalFailure ? 1024 * 1024 : 0);
      if (
        record.kind !== "ack" &&
        record.kind !== "sequence" &&
        (logicalBytes + bytes > allowance ||
          (record.kind === "accepted" && operations.size >= maxReceipts))
      )
        throw new JournalCapacityError();
      let reclaimed = 0;
      let priorAckBytes = 0;
      if (record.kind === "ack") {
        const previous = acknowledgements.get(key(record.incarnation, record.sessionId));
        const prior = previous?.sequence ?? 0;
        priorAckBytes = previous ? Buffer.byteLength(encoded({ kind: "ack", ...previous })) : 0;
        const channel = bySession.get(key(record.incarnation, record.sessionId)) ?? [];
        let lower = 0,
          upper = channel.length;
        while (lower < upper) {
          const middle = Math.floor((lower + upper) / 2);
          if ((channel[middle]?.sequence ?? 0) <= prior) lower = middle + 1;
          else upper = middle;
        }
        for (let index = lower; index < channel.length; index++) {
          const event = channel[index];
          if (!event || event.sequence > record.sequence) break;
          if (event.identity.incarnation === record.incarnation)
            reclaimed += eventBytes.get(event) ?? 0;
        }
      }
      await file.write(text);
      await file.sync();
      apply(record);
      physicalBytes += bytes;
      sinceCompaction += bytes;
      logicalBytes += bytes - reclaimed - priorAckBytes;
      if (sinceCompaction >= compactAfterBytes || physicalBytes > maxBytes + compactAfterBytes)
        await compact();
    });
    // Capacity is recoverable by a committed acknowledgement. I/O failures poison further writes.
    writes = write.catch((error) => {
      if (!(error instanceof JournalCapacityError)) throw error;
    });
    return write;
  }
  if (removedReceipts) await compact();
  return {
    operations,
    events,
    append,
    get lastSequence() {
      return lastSequence;
    },
    get full() {
      return logicalBytes >= maxBytes || operations.size >= maxReceipts;
    },
    eventsFor: (sessionId?: string, incarnation?: string) =>
      sessionId === undefined || incarnation === undefined
        ? events
        : (bySession.get(key(incarnation, sessionId)) ?? []),
    isAcknowledged: acknowledged,
    async acknowledge(incarnation: string, sessionId: string, sequence: number) {
      if (sequence > lastSequence || sequence < 0 || !Number.isSafeInteger(sequence))
        throw new Error("Invalid replay acknowledgement");
      if (sequence <= (acknowledgements.get(key(incarnation, sessionId))?.sequence ?? 0)) return;
      await append({ kind: "ack", incarnation, sessionId, sequence });
    },
    close: async () => {
      try {
        await writes;
      } finally {
        await file.close();
      }
    },
  };
}
export type WorkerJournal = Awaited<ReturnType<typeof openWorkerJournal>>;
