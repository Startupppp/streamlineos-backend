import {
  earliestTransition,
  type GrantTransitions,
  NO_TRANSITIONS,
  snapshotValidUntil,
} from "./snapshot-validity";

const CEILING_MS = 30_000;
const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("snapshotValidUntil", () => {
  it("returns now plus the ceiling when there are no transitions", () => {
    expect(snapshotValidUntil(NOW, CEILING_MS, NO_TRANSITIONS)).toBe(
      NOW.getTime() + CEILING_MS,
    );
  });

  it("returns the transition instant when it is sooner than the ceiling", () => {
    const transitions: GrantTransitions = {
      roleAssignmentExpiry: new Date(NOW.getTime() + 5_000),
      delegationStart: null,
      delegationEnd: null,
    };
    expect(snapshotValidUntil(NOW, CEILING_MS, transitions)).toBe(
      NOW.getTime() + 5_000,
    );
  });

  it("returns the ceiling when the transition is later than the ceiling", () => {
    const transitions: GrantTransitions = {
      roleAssignmentExpiry: new Date(NOW.getTime() + 60_000),
      delegationStart: null,
      delegationEnd: null,
    };
    expect(snapshotValidUntil(NOW, CEILING_MS, transitions)).toBe(
      NOW.getTime() + CEILING_MS,
    );
  });

  it("picks the earliest transition when roleAssignmentExpiry wins", () => {
    const transitions: GrantTransitions = {
      roleAssignmentExpiry: new Date(NOW.getTime() + 5_000),
      delegationStart: new Date(NOW.getTime() + 10_000),
      delegationEnd: new Date(NOW.getTime() + 15_000),
    };
    expect(snapshotValidUntil(NOW, CEILING_MS, transitions)).toBe(
      NOW.getTime() + 5_000,
    );
  });

  it("picks the earliest transition when delegationStart wins", () => {
    const transitions: GrantTransitions = {
      roleAssignmentExpiry: new Date(NOW.getTime() + 10_000),
      delegationStart: new Date(NOW.getTime() + 5_000),
      delegationEnd: new Date(NOW.getTime() + 15_000),
    };
    expect(snapshotValidUntil(NOW, CEILING_MS, transitions)).toBe(
      NOW.getTime() + 5_000,
    );
  });

  it("picks the earliest transition when delegationEnd wins", () => {
    const transitions: GrantTransitions = {
      roleAssignmentExpiry: new Date(NOW.getTime() + 10_000),
      delegationStart: new Date(NOW.getTime() + 15_000),
      delegationEnd: new Date(NOW.getTime() + 5_000),
    };
    expect(snapshotValidUntil(NOW, CEILING_MS, transitions)).toBe(
      NOW.getTime() + 5_000,
    );
  });

  it("ignores a transition exactly equal to now", () => {
    const transitions: GrantTransitions = {
      roleAssignmentExpiry: NOW,
      delegationStart: null,
      delegationEnd: null,
    };
    expect(snapshotValidUntil(NOW, CEILING_MS, transitions)).toBe(
      NOW.getTime() + CEILING_MS,
    );
  });

  it("honours a transition one millisecond after now and sets validUntil to that instant", () => {
    const oneMs = new Date(NOW.getTime() + 1);
    const transitions: GrantTransitions = {
      roleAssignmentExpiry: null,
      delegationStart: null,
      delegationEnd: oneMs,
    };
    expect(snapshotValidUntil(NOW, CEILING_MS, transitions)).toBe(
      oneMs.getTime(),
    );
  });
});

describe("earliestTransition", () => {
  it("returns null when every candidate is null", () => {
    expect(earliestTransition(NOW, NO_TRANSITIONS)).toBeNull();
  });

  it("returns null when every candidate is in the past or exactly now", () => {
    const transitions: GrantTransitions = {
      roleAssignmentExpiry: new Date(NOW.getTime() - 1_000),
      delegationStart: NOW,
      delegationEnd: new Date(NOW.getTime() - 1),
    };
    expect(earliestTransition(NOW, transitions)).toBeNull();
  });
});
