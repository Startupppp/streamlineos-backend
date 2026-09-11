import {
  currentSpan,
  formatTraceparent,
  newSpanId,
  newTraceId,
  parseTraceparent,
  resetSpanExporter,
  setSpanExporter,
  withSpan,
  type FinishedSpan,
} from "./tracing";

function collector(): { spans: FinishedSpan[] } {
  const spans: FinishedSpan[] = [];
  setSpanExporter({ export: (span) => spans.push(span) });
  return { spans };
}

afterEach(() => resetSpanExporter());

describe("identifiers", () => {
  it("mints W3C-shaped ids", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("parseTraceparent", () => {
  it("reads a valid header", () => {
    expect(
      parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
    ).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true,
    });
  });

  it("reads the sampled flag", () => {
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")?.sampled).toBe(false);
  });

  /**
   * An all-zero id is invalid per the specification. Adopting one would merge
   * every request that sent it into a single trace.
   */
  it("refuses all-zero ids", () => {
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeNull();
  });

  it("refuses anything malformed rather than guessing", () => {
    for (const header of ["", "nonsense", "00-short-00f067aa0ba902b7-01", undefined, null])
      expect(parseTraceparent(header)).toBeNull();
  });

  it("round-trips through formatTraceparent", () => {
    const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(formatTraceparent(parseTraceparent(header)!)).toBe(header);
  });

  /*
   * The negative test for the one `as unknown as` this file's source carries
   * (tracing.ts:93, ledgered `external`). Its invariant is an ARITY claim: the
   * traceparent regex has four capture groups, so a successful match is exactly
   * five elements, and the cast names that. The ledger proves the cast is
   * declared and cannot multiply; it does not prove the claim. These do.
   *
   * The claim fails silently, which is why it needs pinning rather than reading.
   * Drop a capture group and `match` is still an array, the destructure still
   * succeeds, and the missing element arrives as `undefined` wearing the type
   * `string`. Nothing throws — the trace just goes wrong. So each group is
   * pinned by an OBSERVABLE consequence of its own presence, not by counting
   * elements the cast has already lied about.
   */
  describe("the arity the cast asserts", () => {
    const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    it("group 4 is really read — an odd flag byte samples and an even one does not", () => {
      // Lose this group and `flags` is undefined: Number.parseInt(undefined, 16)
      // is NaN, NaN & 1 is 0, and EVERY trace silently reads as unsampled.
      expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03")?.sampled).toBe(true);
      expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-ff")?.sampled).toBe(true);
      expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-02")?.sampled).toBe(false);
      expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-fe")?.sampled).toBe(false);
    });

    it("groups 2 and 3 are really read — the ids come back as themselves, not as undefined", () => {
      // Lose either and the field is `undefined` typed `string`: the all-zero
      // guard below stops rejecting (String(undefined) is "undefined", which
      // does not match /^0+$/), so the header is ACCEPTED carrying nothing.
      const parsed = parseTraceparent(VALID);
      expect(parsed).not.toBeNull();
      expect(typeof parsed?.traceId).toBe("string");
      expect(typeof parsed?.spanId).toBe("string");
      expect(parsed?.traceId).toHaveLength(32);
      expect(parsed?.spanId).toHaveLength(16);
    });

    it("never returns a context with an undefined member, whatever it is fed", () => {
      const corpus = [
        VALID,
        VALID.toUpperCase(),
        `  ${VALID}  `,
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
        "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0g",
        "00-4bf92f3577b34da6a3ce929d0e073-00f067aa0ba902b7-01",
        "",
        "-".repeat(64),
      ];

      for (const header of corpus) {
        const parsed = parseTraceparent(header);
        if (parsed === null) continue;
        expect(Object.values(parsed)).not.toContain(undefined);
        expect(parsed.traceId).toMatch(/^[0-9a-f]{32}$/);
        expect(parsed.spanId).toMatch(/^[0-9a-f]{16}$/);
        expect(typeof parsed.sampled).toBe("boolean");
      }
    });

    it("null-checks before the cast, so a non-matching header returns null and never throws", () => {
      // The cast sits AFTER `if (!match) return null`. Remove that guard and
      // every one of these destructures null and throws a TypeError into the
      // request instead of declining to join a trace.
      for (const header of ["nonsense", "00--", "00-x-y-z", "\u0000"])
        expect(() => parseTraceparent(header)).not.toThrow();
      expect(parseTraceparent("nonsense")).toBeNull();
    });
  });
});

describe("withSpan", () => {
  it("exports a span with its duration and status", async () => {
    const { spans } = collector();
    await withSpan("work", async () => "done");

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ name: "work", status: "ok", parentSpanId: null });
    expect(spans[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns what the work returned", async () => {
    collector();
    await expect(withSpan("work", async () => 42)).resolves.toBe(42);
  });

  it("records a failure and still throws", async () => {
    const { spans } = collector();
    await expect(withSpan("work", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(spans[0]).toMatchObject({ status: "error" });
  });

  /**
   * The property the criterion is about: work that runs later carries the same
   * trace as the request that scheduled it, rather than starting an orphan.
   */
  it("nests, so a child shares its parent's trace", async () => {
    const { spans } = collector();

    await withSpan("request", async () => {
      await withSpan("after-commit", async () => undefined);
    });

    const [child, parent] = spans;
    expect(child!.name).toBe("after-commit");
    expect(child!.traceId).toBe(parent!.traceId);
    expect(child!.parentSpanId).toBe(parent!.spanId);
  });

  it("joins an inbound trace when given one", async () => {
    const { spans } = collector();
    const inbound = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");

    await withSpan("request", async () => undefined, { parent: inbound });

    expect(spans[0]).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
    });
  });

  it("keeps an unsampled trace unsampled", async () => {
    const { spans } = collector();
    const inbound = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00");
    await withSpan("request", async () => undefined, { parent: inbound });
    expect(spans[0]!.sampled).toBe(false);
  });

  it("exposes the current span to the work inside it", async () => {
    collector();
    expect(currentSpan()).toBeUndefined();
    await withSpan("work", async () => {
      expect(currentSpan()).toMatchObject({ traceId: expect.any(String) });
    });
    expect(currentSpan()).toBeUndefined();
  });

  /**
   * Instrumentation must never become an outage.
   */
  it("survives an exporter that throws", async () => {
    setSpanExporter({ export: () => { throw new Error("collector down"); } });
    await expect(withSpan("work", async () => "fine")).resolves.toBe("fine");
  });

  it("discards silently with nothing attached", async () => {
    resetSpanExporter();
    await expect(withSpan("work", async () => "fine")).resolves.toBe("fine");
  });
});
