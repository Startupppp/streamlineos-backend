import { STEP_PROMPTS, activation, nextStep, type WorkspaceSignals } from "./activation";

const EMPTY: WorkspaceSignals = {
  realParties: 0,
  realDeals: 0,
  realActivities: 0,
  activeMembers: 1,
  hasCompletedImport: false,
  hasConnectedChannel: false,
};

describe("activation", () => {
  it("is not reached by a fresh workspace", () => {
    const result = activation(EMPTY);

    expect(result.isActivated).toBe(false);
    expect(result.percent).toBe(0);
    expect(result.remaining).toHaveLength(4);
  });

  it("is not reached by data alone", () => {
    // An import nobody looked at is effort, not adoption. Counting it as
    // activation would make the funnel report success for a trial that went
    // quiet the day it started.
    const result = activation({ ...EMPTY, hasCompletedImport: true });

    expect(result.completed).toEqual(["bring-your-data"]);
    expect(result.isActivated).toBe(false);
  });

  it("is not reached by activity alone", () => {
    // Somebody clicking around a demo. Real, and not the thing being measured.
    const result = activation({ ...EMPTY, realDeals: 3 });

    expect(result.isActivated).toBe(false);
  });

  it("is reached when the workspace holds real data and somebody used it", () => {
    expect(activation({ ...EMPTY, hasCompletedImport: true, realDeals: 1 }).isActivated).toBe(true);
  });

  it("counts a connected channel as using the data", () => {
    // A rep whose email flows in is getting the product's actual value without
    // opening a deal by hand.
    expect(
      activation({ ...EMPTY, hasCompletedImport: true, hasConnectedChannel: true }).isActivated,
    ).toBe(true);
  });

  it("counts an import however few rows it brought", () => {
    // The tenant did the work of pointing us at their data. Penalising a small
    // business for being small would make the measure mean something else.
    const result = activation({ ...EMPTY, hasCompletedImport: true, realParties: 2 });
    expect(result.completed).toContain("bring-your-data");
  });

  it("accepts enough parties entered by hand as bringing data", () => {
    // Not everybody imports; a team that types in forty customers has adopted it.
    expect(activation({ ...EMPTY, realParties: 40 }).completed).toContain("bring-your-data");
  });

  it("treats a handful of parties as exploration rather than adoption", () => {
    // One or two created while clicking around is not a book of business.
    expect(activation({ ...EMPTY, realParties: 3 }).completed).not.toContain("bring-your-data");
  });

  it("does not count the founder as a colleague", () => {
    expect(activation({ ...EMPTY, activeMembers: 1 }).completed).not.toContain(
      "invite-a-colleague",
    );
    expect(activation({ ...EMPTY, activeMembers: 2 }).completed).toContain("invite-a-colleague");
  });
});

describe("what to do next", () => {
  it("asks for data first, because every other step needs something to act on", () => {
    // A colleague invited into an empty workspace sees an empty workspace.
    expect(nextStep(EMPTY)).toBe("bring-your-data");
  });

  it("moves on once data is there", () => {
    expect(nextStep({ ...EMPTY, hasCompletedImport: true })).toBe("open-a-deal");
  });

  it("is null when nothing is left", () => {
    expect(
      nextStep({
        ...EMPTY,
        hasCompletedImport: true,
        realDeals: 1,
        hasConnectedChannel: true,
        activeMembers: 3,
      }),
    ).toBeNull();
  });

  it("has a prompt for every step, so no surface renders a bare key", () => {
    for (const step of activation(EMPTY).remaining) {
      expect(STEP_PROMPTS[step]).toBeDefined();
      expect(STEP_PROMPTS[step].length).toBeGreaterThan(20);
    }
  });
});

describe("progress", () => {
  it("reports a percentage derived from the steps, never stored", () => {
    expect(activation({ ...EMPTY, hasCompletedImport: true }).percent).toBe(25);
    expect(activation({ ...EMPTY, hasCompletedImport: true, realDeals: 1 }).percent).toBe(50);
  });

  it("reaches a hundred only when every step is done", () => {
    const complete = activation({
      realParties: 100,
      realDeals: 5,
      realActivities: 20,
      activeMembers: 4,
      hasCompletedImport: true,
      hasConnectedChannel: true,
    });

    expect(complete.percent).toBe(100);
    expect(complete.remaining).toEqual([]);
    expect(complete.isActivated).toBe(true);
  });

  it("lists completed steps in the order worth doing them, not the order signalled", () => {
    const result = activation({ ...EMPTY, activeMembers: 5, hasCompletedImport: true });
    expect(result.completed).toEqual(["bring-your-data", "invite-a-colleague"]);
  });
});
