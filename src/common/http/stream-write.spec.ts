import { writeChunk, type BackpressuredResponse } from "./stream-abort";

type Handler = () => void;

function fakeResponse(options: { acceptsBeforeBackpressure: number }) {
  const handlers = new Map<string, Handler[]>();
  let writes = 0;

  const response = {
    destroyed: false,
    written: [] as string[],
    write(chunk: string): boolean {
      this.written.push(chunk);
      writes += 1;
      return writes <= options.acceptsBeforeBackpressure;
    },
    once(event: string, listener: Handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(listener);
      handlers.set(event, existing);
      return this;
    },
    off(event: string, listener: Handler) {
      const existing = handlers.get(event) ?? [];
      handlers.set(
        event,
        existing.filter((candidate) => candidate !== listener),
      );
      return this;
    },
    fire(event: string): void {
      for (const listener of [...(handlers.get(event) ?? [])]) listener();
    },
    listenerCount(): number {
      let total = 0;
      for (const list of handlers.values()) total += list.length;
      return total;
    },
  };

  return response;
}

describe("writeChunk", () => {
  it("returns immediately while the socket still accepts writes", async () => {
    const res = fakeResponse({ acceptsBeforeBackpressure: 10 });

    await expect(writeChunk(res as BackpressuredResponse, "row")).resolves.toBe(true);
    expect(res.written).toEqual(["row"]);
    expect(res.listenerCount()).toBe(0);
  });

  it("waits for the drain when the socket pushes back", async () => {
    const res = fakeResponse({ acceptsBeforeBackpressure: 0 });

    const pending = writeChunk(res as BackpressuredResponse, "row");
    res.fire("drain");

    await expect(pending).resolves.toBe(true);
  });

  it("gives up when the client disconnects instead of awaiting a drain that never comes", async () => {
    const res = fakeResponse({ acceptsBeforeBackpressure: 0 });

    const pending = writeChunk(res as BackpressuredResponse, "row");
    res.fire("close");

    await expect(pending).resolves.toBe(false);
  });

  it("gives up when the socket errors", async () => {
    const res = fakeResponse({ acceptsBeforeBackpressure: 0 });

    const pending = writeChunk(res as BackpressuredResponse, "row");
    res.fire("error");

    await expect(pending).resolves.toBe(false);
  });

  it("removes every listener it added, so a long export cannot accumulate them", async () => {
    const res = fakeResponse({ acceptsBeforeBackpressure: 0 });

    const pending = writeChunk(res as BackpressuredResponse, "row");
    expect(res.listenerCount()).toBeGreaterThan(0);
    res.fire("drain");
    await pending;

    expect(res.listenerCount()).toBe(0);
  });

  it("refuses to write to a response that is already destroyed", async () => {
    const res = fakeResponse({ acceptsBeforeBackpressure: 10 });
    res.destroyed = true;

    await expect(writeChunk(res as BackpressuredResponse, "row")).resolves.toBe(false);
    expect(res.written).toEqual([]);
  });
});
