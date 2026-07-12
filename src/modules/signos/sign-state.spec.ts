import {
  canTransitionEnvelope,
  canTransitionRecipient,
  computeEnvelopeStatusFromRecipients,
  isEnvelopeEditable,
  isEnvelopeSignable,
  isEnvelopeTerminal,
  nextEligibleRecipientIds,
  ENVELOPE_TRANSITIONS,
  RECIPIENT_TRANSITIONS,
  type SignEnvelopeStatus,
  type SignRecipientStatus,
} from "./sign-state";

describe("canTransitionEnvelope", () => {
  it("never allows a self-transition, even for statuses with no outgoing edges", () => {
    for (const status of Object.keys(ENVELOPE_TRANSITIONS) as SignEnvelopeStatus[]) {
      expect(canTransitionEnvelope(status, status)).toBe(false);
    }
  });

  it("allows every edge declared in ENVELOPE_TRANSITIONS", () => {
    for (const [from, tos] of Object.entries(ENVELOPE_TRANSITIONS) as [SignEnvelopeStatus, SignEnvelopeStatus[]][]) {
      for (const to of tos) {
        expect(canTransitionEnvelope(from, to)).toBe(true);
      }
    }
  });

  it("rejects transitions out of terminal states (completed, voided)", () => {
    expect(canTransitionEnvelope("completed", "sent")).toBe(false);
    expect(canTransitionEnvelope("completed", "voided")).toBe(false);
    expect(canTransitionEnvelope("voided", "sent")).toBe(false);
    expect(canTransitionEnvelope("voided", "draft")).toBe(false);
  });

  it("rejects skipping straight from draft to completed", () => {
    expect(canTransitionEnvelope("draft", "completed")).toBe(false);
  });

  it("allows a declined envelope to be corrected and resent, but not skip straight back to sent", () => {
    expect(canTransitionEnvelope("declined", "correction_required")).toBe(true);
    expect(canTransitionEnvelope("declined", "sent")).toBe(false);
    expect(canTransitionEnvelope("correction_required", "sent")).toBe(true);
  });

  it("allows an expired envelope to be reopened (extend expiration) or corrected", () => {
    expect(canTransitionEnvelope("expired", "sent")).toBe(true);
    expect(canTransitionEnvelope("expired", "correction_required")).toBe(true);
    expect(canTransitionEnvelope("expired", "completed")).toBe(false);
  });
});

describe("canTransitionRecipient", () => {
  it("never allows a self-transition", () => {
    for (const status of Object.keys(RECIPIENT_TRANSITIONS) as SignRecipientStatus[]) {
      expect(canTransitionRecipient(status, status)).toBe(false);
    }
  });

  it("rejects transitions out of terminal recipient states", () => {
    for (const to of ["invited", "viewed", "authenticated", "signing"] as SignRecipientStatus[]) {
      expect(canTransitionRecipient("completed", to)).toBe(false);
      expect(canTransitionRecipient("declined", to)).toBe(false);
      expect(canTransitionRecipient("delegated", to)).toBe(false);
    }
  });

  it("allows the full happy path pending -> invited -> viewed -> authenticated -> signing -> completed", () => {
    expect(canTransitionRecipient("pending", "invited")).toBe(true);
    expect(canTransitionRecipient("invited", "viewed")).toBe(true);
    expect(canTransitionRecipient("viewed", "authenticated")).toBe(true);
    expect(canTransitionRecipient("authenticated", "signing")).toBe(true);
    expect(canTransitionRecipient("signing", "completed")).toBe(true);
  });
});

describe("isEnvelopeEditable / isEnvelopeTerminal / isEnvelopeSignable", () => {
  it("only draft and ready_to_send are editable", () => {
    expect(isEnvelopeEditable("draft")).toBe(true);
    expect(isEnvelopeEditable("ready_to_send")).toBe(true);
    expect(isEnvelopeEditable("sent")).toBe(false);
    expect(isEnvelopeEditable("completed")).toBe(false);
  });

  it("only completed and voided are terminal", () => {
    expect(isEnvelopeTerminal("completed")).toBe(true);
    expect(isEnvelopeTerminal("voided")).toBe(true);
    expect(isEnvelopeTerminal("declined")).toBe(false);
    expect(isEnvelopeTerminal("expired")).toBe(false);
  });

  it("only sent/delivered/partially_completed are signable", () => {
    expect(isEnvelopeSignable("sent")).toBe(true);
    expect(isEnvelopeSignable("delivered")).toBe(true);
    expect(isEnvelopeSignable("partially_completed")).toBe(true);
    expect(isEnvelopeSignable("draft")).toBe(false);
    expect(isEnvelopeSignable("completed")).toBe(false);
    expect(isEnvelopeSignable("expired")).toBe(false);
  });
});

describe("computeEnvelopeStatusFromRecipients", () => {
  it("keeps the current status when there are no blocking recipients (cc/viewer-only envelope)", () => {
    expect(computeEnvelopeStatusFromRecipients([], "sent")).toBe("sent");
  });

  it("becomes completed only when every blocking recipient has completed", () => {
    expect(
      computeEnvelopeStatusFromRecipients([{ status: "completed" }, { status: "completed" }], "partially_completed"),
    ).toBe("completed");
  });

  it("becomes declined the moment any blocking recipient declines, even if others already completed", () => {
    expect(
      computeEnvelopeStatusFromRecipients([{ status: "completed" }, { status: "declined" }], "partially_completed"),
    ).toBe("declined");
  });

  it("becomes partially_completed when some but not all blocking recipients are done", () => {
    expect(
      computeEnvelopeStatusFromRecipients([{ status: "completed" }, { status: "invited" }], "sent"),
    ).toBe("partially_completed");
  });

  it("keeps current status when nobody has completed or declined yet", () => {
    expect(
      computeEnvelopeStatusFromRecipients([{ status: "invited" }, { status: "viewed" }], "sent"),
    ).toBe("sent");
  });
});

describe("nextEligibleRecipientIds", () => {
  it("returns nothing once every recipient has decided (parallel routing, all done)", () => {
    const ids = nextEligibleRecipientIds([
      { id: 1, routingOrder: 1, status: "completed" },
      { id: 2, routingOrder: 1, status: "declined" },
    ]);
    expect(ids).toEqual([]);
  });

  it("returns only the single lowest-order recipient for pure sequential routing", () => {
    const ids = nextEligibleRecipientIds([
      { id: 1, routingOrder: 1, status: "pending" },
      { id: 2, routingOrder: 2, status: "pending" },
      { id: 3, routingOrder: 3, status: "pending" },
    ]);
    expect(ids).toEqual([1]);
  });

  it("advances to the next order group once the current lowest-order recipient completes", () => {
    const ids = nextEligibleRecipientIds([
      { id: 1, routingOrder: 1, status: "completed" },
      { id: 2, routingOrder: 2, status: "pending" },
      { id: 3, routingOrder: 3, status: "pending" },
    ]);
    expect(ids).toEqual([2]);
  });

  it("returns every tied recipient in a mixed-routing batch sharing the lowest order", () => {
    const ids = nextEligibleRecipientIds([
      { id: 1, routingOrder: 1, status: "pending" },
      { id: 2, routingOrder: 1, status: "pending" },
      { id: 3, routingOrder: 2, status: "pending" },
    ]);
    expect(ids.sort()).toEqual([1, 2]);
  });

  it("does not treat a delegated recipient as still eligible", () => {
    const ids = nextEligibleRecipientIds([
      { id: 1, routingOrder: 1, status: "delegated" },
      { id: 2, routingOrder: 2, status: "pending" },
    ]);
    expect(ids).toEqual([2]);
  });
});
