import { nextReactions } from "./chat-reactions";

const ASHA = "user-asha";
const RAVI = "user-ravi";

describe("toggling a reaction", () => {
  it("adds a reaction to a message nobody has reacted to", () => {
    expect(nextReactions({}, ASHA, "👍")).toEqual({ "👍": [ASHA] });
  });

  it("adds a reactor beside the people already there", () => {
    expect(nextReactions({ "👍": [RAVI] }, ASHA, "👍")).toEqual({
      "👍": [RAVI, ASHA],
    });
  });

  it("removes the reaction when the same person taps the same emoji again", () => {
    expect(nextReactions({ "👍": [ASHA] }, ASHA, "👍")).toEqual({});
  });

  it("drops the emoji entirely once its last reactor leaves", () => {
    const result = nextReactions({ "👍": [ASHA], "🎉": [RAVI] }, ASHA, "👍");
    expect(result).toEqual({ "🎉": [RAVI] });
    expect(Object.keys(result)).not.toContain("👍");
  });

  it("replaces a person's reaction rather than stacking a second one", () => {
    expect(nextReactions({ "👍": [ASHA] }, ASHA, "🎉")).toEqual({
      "🎉": [ASHA],
    });
  });

  it("moves one person without disturbing anybody else", () => {
    expect(nextReactions({ "👍": [ASHA, RAVI] }, ASHA, "🎉")).toEqual({
      "👍": [RAVI],
      "🎉": [ASHA],
    });
  });

  it("never mutates the reactions it was given", () => {
    const current = { "👍": [RAVI] };
    nextReactions(current, ASHA, "👍");
    expect(current).toEqual({ "👍": [RAVI] });
  });

  it("applies two people's toggles in sequence without losing either", () => {
    const afterAsha = nextReactions({}, ASHA, "👍");
    const afterRavi = nextReactions(afterAsha, RAVI, "🎉");
    expect(afterRavi).toEqual({ "👍": [ASHA], "🎉": [RAVI] });
  });
});
