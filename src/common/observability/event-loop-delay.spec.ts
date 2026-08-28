import { EventLoopDelayMonitor } from "./event-loop-delay";
import { resetSpanExporter, setSpanExporter, type FinishedSpan } from "./tracing";

function block(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // deliberately starving the loop
  }
}

describe("event-loop delay is measured separately from the route total", () => {
  let monitor: EventLoopDelayMonitor;
  let spans: FinishedSpan[];

  beforeEach(() => {
    spans = [];
    setSpanExporter({ export: (span) => spans.push(span) });
    monitor = new EventLoopDelayMonitor();
  });

  afterEach(() => {
    monitor.stop();
    resetSpanExporter();
  });

  it("reports nothing until it is started, rather than inventing a zero", () => {
    expect(monitor.sample()).toBeUndefined();
    expect(monitor.emit()).toBeUndefined();
    expect(spans).toHaveLength(0);
  });

  it("observes a starved loop", async () => {
    monitor.start(60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    block(120);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sample = monitor.sample();

    expect(sample).toBeDefined();
    expect(sample!.maxMs).toBeGreaterThan(50);
  });

  it("emits one span carrying the seam and no unbounded label", async () => {
    monitor.start(60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));

    monitor.emit();

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("runtime.eventloop.delay");
    expect(spans[0]?.attributes.seam).toBe("runtime.eventloop.delay");
    expect(JSON.stringify(spans[0]?.attributes)).not.toMatch(/org|user|tenant/i);
  });

  it("does not stack a second histogram when started twice", () => {
    monitor.start(60_000);
    monitor.start(60_000);
    monitor.stop();

    expect(monitor.sample()).toBeUndefined();
  });
});
