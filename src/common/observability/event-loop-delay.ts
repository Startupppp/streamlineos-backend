import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { startSpan } from "./tracing";

export const EVENT_LOOP_SEAM = "runtime.eventloop.delay";
export const EVENT_LOOP_RESOLUTION_MS = 10;
export const EVENT_LOOP_SAMPLE_INTERVAL_MS = 30_000;

export interface EventLoopDelaySample {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

const toMs = (nanoseconds: number): number => Math.round(nanoseconds / 10_000) / 100;

export class EventLoopDelayMonitor {
  private histogram: IntervalHistogram | undefined;
  private timer: NodeJS.Timeout | undefined;

  start(intervalMs = EVENT_LOOP_SAMPLE_INTERVAL_MS): void {
    if (this.histogram) return;

    this.histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
    this.histogram.enable();

    this.timer = setInterval(() => this.emit(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.histogram?.disable();
    this.histogram = undefined;
  }

  sample(): EventLoopDelaySample | undefined {
    if (!this.histogram) return undefined;
    return {
      p50Ms: toMs(this.histogram.percentile(50)),
      p95Ms: toMs(this.histogram.percentile(95)),
      p99Ms: toMs(this.histogram.percentile(99)),
      maxMs: toMs(this.histogram.max),
    };
  }

  emit(): EventLoopDelaySample | undefined {
    const sample = this.sample();
    if (!sample) return undefined;

    const span = startSpan(EVENT_LOOP_SEAM, {
      attributes: {
        seam: EVENT_LOOP_SEAM,
        p50Ms: sample.p50Ms,
        p95Ms: sample.p95Ms,
        p99Ms: sample.p99Ms,
      },
    });
    span.end("ok");
    this.histogram?.reset();
    return sample;
  }
}

export const eventLoopDelayMonitor = new EventLoopDelayMonitor();
