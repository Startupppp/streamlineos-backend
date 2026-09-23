import {
  decodeInboxCursor,
  encodeInboxCursor,
  sameInboxCursorState,
  type InboxCursorState,
} from "./dto/unified-inbox.schemas";

function encodeRaw(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

const LEGACY_PAYLOAD = {
  n: 10,
  nt: "2026-09-20T00:00:00.000Z",
  b: null,
  bt: null,
  m: null,
  a: 30,
  at: "2026-09-19T00:00:00.000Z",
};

describe("unified inbox cursor — per-adapter approval positions", () => {
  it("a cursor minted before `ap` existed decodes to an empty adapter map without throwing", () => {
    const state = decodeInboxCursor(encodeRaw(LEGACY_PAYLOAD));

    expect(state.ap).toEqual({});
    expect(state.n).toBe(10);
    expect(state.a).toBe(30);
    expect(state.at).toBe("2026-09-19T00:00:00.000Z");
  });

  it("a cursor carrying `ap` decodes every well-formed entry", () => {
    const state = decodeInboxCursor(
      encodeRaw({
        ...LEGACY_PAYLOAD,
        ap: {
          "hr:leave": { id: 7, t: "2026-09-18T00:00:00.000Z" },
          "hr:wfh": { id: 4, t: null },
        },
      }),
    );

    expect(state.ap).toEqual({
      "hr:leave": { id: 7, t: "2026-09-18T00:00:00.000Z" },
      "hr:wfh": { id: 4, t: null },
    });
  });

  it("drops only the malformed adapter entries and keeps the well-formed ones", () => {
    const state = decodeInboxCursor(
      encodeRaw({
        ...LEGACY_PAYLOAD,
        ap: {
          "hr:leave": { id: 7, t: "2026-09-18T00:00:00.000Z" },
          "hr:wfh": { id: "4", t: null },
          "hr:workflow": { id: 1.5, t: null },
          "timesheets:timesheet": { id: 9, t: 12345 },
          "build:build": "not-an-object",
        },
      }),
    );

    expect(state.ap).toEqual({ "hr:leave": { id: 7, t: "2026-09-18T00:00:00.000Z" } });
  });

  it("an `ap` that is not an object at all decodes to an empty map without throwing", () => {
    expect(decodeInboxCursor(encodeRaw({ ...LEGACY_PAYLOAD, ap: [1, 2, 3] })).ap).toEqual({});
    expect(decodeInboxCursor(encodeRaw({ ...LEGACY_PAYLOAD, ap: "x" })).ap).toEqual({});
    expect(decodeInboxCursor(encodeRaw({ ...LEGACY_PAYLOAD, ap: null })).ap).toEqual({});
  });

  it("round-trips the adapter map through encode and decode", () => {
    const state: InboxCursorState = {
      n: null,
      nt: null,
      b: null,
      bt: null,
      m: null,
      a: null,
      at: null,
      ap: {
        "hr:leave": { id: 7, t: "2026-09-18T00:00:00.000Z" },
        "timesheets:timesheet": { id: 88, t: "2026-09-17T00:00:00.000Z" },
      },
    };

    expect(decodeInboxCursor(encodeInboxCursor(state)).ap).toEqual(state.ap);
  });

  it("a moved adapter position is an advance, so the next cursor is emitted", () => {
    const before: InboxCursorState = decodeInboxCursor(encodeRaw(LEGACY_PAYLOAD));
    const after: InboxCursorState = {
      ...before,
      ap: { "hr:leave": { id: 7, t: "2026-09-18T00:00:00.000Z" } },
    };

    expect(sameInboxCursorState(before, after)).toBe(false);
    expect(sameInboxCursorState(after, after)).toBe(true);
    expect(sameInboxCursorState(before, { ...before, ap: {} })).toBe(true);
  });

  it("two adapters at the same numeric id are two distinct positions", () => {
    const left: InboxCursorState = {
      ...decodeInboxCursor(undefined),
      ap: { "hr:leave": { id: 5, t: null } },
    };
    const right: InboxCursorState = {
      ...decodeInboxCursor(undefined),
      ap: { "hr:wfh": { id: 5, t: null } },
    };

    expect(sameInboxCursorState(left, right)).toBe(false);
    expect(sameInboxCursorState(left, left)).toBe(true);
  });
});
