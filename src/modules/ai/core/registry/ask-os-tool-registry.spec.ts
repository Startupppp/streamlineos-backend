import { z } from "zod";
import {
  assertUniqueKeys,
  availableDefinitions,
  isToolAvailable,
  renderOutcome,
  toJsonSafe,
} from "./ask-os-tool-registry";
import {
  defineTool,
  data,
  denied,
  empty,
  failed,
  needsConnection,
  toolDenialReason,
} from "./ask-os-tool.types";
import type { AccessSnapshot } from "../../../access/access.types";

function snapshot(overrides: Partial<AccessSnapshot> = {}): AccessSnapshot {
  return {
    membershipId: 1,
    scopes: {},
    modules: {},
    isOrgOwner: false,
    canManageOrganizationMembership: false,
    mfa: { enforced: false, satisfied: true },
    version: 1,
    ...overrides,
  };
}

const ungated = defineTool({
  key: "getMyThing",
  description: "d",
  input: z.object({}),
  run: async () => data({ ok: 1 }),
});

const gated = defineTool({
  key: "getTickets",
  description: "d",
  input: z.object({}),
  permission: "build:tickets:view",
  module: "build",
  run: async () => data({ ok: 1 }),
});

describe("a tool the caller cannot use is never offered to the model", () => {
  it("hides a permission-gated tool when the key resolves to none", () => {
    expect(isToolAvailable(gated, snapshot({ scopes: { "build:tickets:view": "none" } }))).toBe(false);
  });

  it("hides a permission-gated tool when the key is absent entirely", () => {
    expect(isToolAvailable(gated, snapshot())).toBe(false);
  });

  it("offers it once the caller holds the key at any usable scope", () => {
    expect(isToolAvailable(gated, snapshot({ scopes: { "build:tickets:view": "own" } }))).toBe(true);
  });

  it("hides a tool whose module is disabled even when the permission is held", () => {
    expect(
      isToolAvailable(gated, snapshot({ scopes: { "build:tickets:view": "all" }, modules: { build: false } })),
    ).toBe(false);
  });

  it("always offers an ungated self tool, because every member holds the self surface", () => {
    expect(isToolAvailable(ungated, snapshot())).toBe(true);
  });

  it("filters the set rather than the caller having to know which are safe", () => {
    const available = availableDefinitions([ungated, gated], snapshot());
    expect(available.map((definition) => definition.key)).toEqual(["getMyThing"]);
  });
});

describe("the registry refuses an ambiguous toolset instead of silently shadowing one", () => {
  it("throws when two definitions share a key", () => {
    expect(() => assertUniqueKeys([ungated, { ...ungated }])).toThrow("Duplicate Ask OS tool keys: getMyThing");
  });

  it("accepts distinct keys", () => {
    expect(() => assertUniqueKeys([ungated, gated])).not.toThrow();
  });
});

describe("every outcome renders to a shape the model can tell apart", () => {
  it("marks data as ok", () => {
    expect(renderOutcome(data({ n: 1 }))).toEqual({ ok: true, data: { n: 1 } });
  });

  it("distinguishes empty from failure, so nothing-found never reads as broken", () => {
    const e = renderOutcome(empty("referrals"));
    const f = renderOutcome(failed("provider down"));
    expect(e).toMatchObject({ ok: true, empty: true, subject: "referrals" });
    expect(f).toMatchObject({ ok: false, failed: true });
    expect(e).not.toMatchObject({ failed: true });
  });

  it("renders a connection gap as a structured, actionable outcome rather than prose", () => {
    const rendered = renderOutcome(needsConnection("gmail", "no-connection", "Connect Gmail to send mail"));
    expect(rendered).toMatchObject({
      requiresConnection: true,
      toolkit: "gmail",
      reason: "no-connection",
    });
  });

  it("keeps needs-reauth distinguishable from never-connected", () => {
    expect(renderOutcome(needsConnection("gmail", "needs-reauth", "Reconnect"))).toMatchObject({
      reason: "needs-reauth",
    });
  });

  it("preserves the confirmation contract the frontend already parses", () => {
    expect(
      renderOutcome({
        kind: "needs-confirmation",
        proposalId: 3,
        token: "t",
        action: "mail.send",
        summary: "s",
        preview: { to: "a@b.c" },
      }),
    ).toMatchObject({ requiresConfirmation: true, proposalId: 3, token: "t", action: "mail.send" });
  });
});

describe("tool results are JSON-safe before they become ModelMessage parts", () => {
  it("converts a Date to a string, because a Date in a tool result aborts the turn with an invalid-prompt error", () => {
    const encoded = toJsonSafe({ ok: true, data: { at: new Date("2026-09-19T00:00:00.000Z") } });

    expect(encoded).toEqual({ ok: true, data: { at: "2026-09-19T00:00:00.000Z" } });
  });

  it("drops an undefined field, because undefined is not a JSON value and fails the ModelMessage schema", () => {
    const encoded = toJsonSafe({ ok: true, data: { present: 1, absent: undefined } });

    expect(encoded).toEqual({ ok: true, data: { present: 1 } });
  });

  it("reports a failure instead of throwing when a tool returns a circular structure", () => {
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;

    expect(toJsonSafe(circular)).toEqual({
      ok: false,
      failed: true,
      reason: "The tool result could not be serialized.",
    });
  });
});

describe("a denial reads the same whether it comes from a tool or a confirmed action", () => {
  it("builds the reason from one definition, so the two paths cannot drift into different wording", () => {
    const outcome = denied("build:tickets:view");

    if (outcome.kind !== "denied") throw new Error(`expected denied, got ${outcome.kind}`);
    expect(outcome.reason).toBe(toolDenialReason("build:tickets:view"));
    expect(renderOutcome(outcome)).toEqual({
      ok: false,
      denied: true,
      reason: toolDenialReason("build:tickets:view"),
    });
  });

  it("names the area the caller lacks rather than the bare permission key", () => {
    expect(toolDenialReason("inventory:stock:read")).toBe(
      "Permission denied: you do not have access to inventory stock data.",
    );
  });

  it("carries the permission on the outcome, so a denial is never mistaken for a failure", () => {
    const outcome = denied("self:payslips");

    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") throw new Error("expected denied");
    expect(outcome.permission).toBe("self:payslips");
  });
});
