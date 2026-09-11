import { InMemoryCommandFenceStore } from "../../../../common/idempotency/command-fence-store-memory";
import { claimAiStreamCommand, completeAiStreamCommand } from "./ai-stream-command";

const input = {
  key: "attempt-1", command: "kb.ask.stream", orgId: "org-a", userId: "user-a", membershipId: 7,
  audience: "internal", body: { question: "Question", conversationId: 42 },
};

describe("durable AI stream command", () => {
  it("admits one caller and blocks a concurrent duplicate", async () => {
    const store = new InMemoryCommandFenceStore();
    const results = await Promise.allSettled([claimAiStreamCommand(store, input), claimAiStreamCommand(store, input)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("replays only the completed result and canonicalizes property order", async () => {
    const store = new InMemoryCommandFenceStore();
    const claim = await claimAiStreamCommand(store, input);
    if (claim.kind !== "proceed") throw new Error("Expected first claim");
    await completeAiStreamCommand(store, claim.fenceId, input.orgId, { answer: "Saved" });
    await expect(claimAiStreamCommand(store, { ...input, body: { conversationId: 42, question: "Question" } }))
      .resolves.toEqual({ kind: "replay", data: { answer: "Saved" } });
  });

  it("rejects body mismatch and cross-principal reuse", async () => {
    const store = new InMemoryCommandFenceStore();
    await claimAiStreamCommand(store, input);
    await expect(claimAiStreamCommand(store, { ...input, body: { question: "Different" } })).rejects.toMatchObject({ status: 422 });
    await expect(claimAiStreamCommand(store, { ...input, userId: "other-user", membershipId: 8 })).rejects.toMatchObject({ status: 422 });
  });

  it("does not reclaim started paid work after the old lease expires", async () => {
    const store = new InMemoryCommandFenceStore();
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(1000);
    try {
      await claimAiStreamCommand(store, input);
      now.mockReturnValue(1000 + 120_000);
      await expect(claimAiStreamCommand(store, input)).rejects.toMatchObject({ status: 409 });
    } finally { now.mockRestore(); }
  });

  it("isolates tenant keys and rejects absent headers", async () => {
    const store = new InMemoryCommandFenceStore();
    await claimAiStreamCommand(store, input);
    await expect(claimAiStreamCommand(store, { ...input, orgId: "org-b" })).resolves.toMatchObject({ kind: "proceed" });
    await expect(claimAiStreamCommand(store, { ...input, key: undefined })).rejects.toMatchObject({ status: 400 });
  });
});
