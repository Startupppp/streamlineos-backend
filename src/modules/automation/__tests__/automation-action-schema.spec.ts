import { automationActionSchema } from "../dto/automation.schemas";

describe("automationActionSchema — discriminated union validation", () => {
  describe("rejected malformed configs", () => {
    it("rejects notify_roles missing required title field", () => {
      const result = automationActionSchema.safeParse({
        type: "notify_roles",
        config: { roles: ["MEMBER"], message: "Hello" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects email with missing subject", () => {
      const result = automationActionSchema.safeParse({
        type: "email",
        config: { to: "user@example.com", body: "Hello" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects support_add_tag with a non-integer tagId", () => {
      const result = automationActionSchema.safeParse({
        type: "support_add_tag",
        config: { tagId: "not-a-number" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects create_task missing title", () => {
      const result = automationActionSchema.safeParse({
        type: "create_task",
        config: { assigneeId: "user-1" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects an unknown action type", () => {
      const result = automationActionSchema.safeParse({
        type: "send_smoke_signal",
        config: {},
      });
      expect(result.success).toBe(false);
    });

    it("rejects support_assign_ticket with missing assigneeId", () => {
      const result = automationActionSchema.safeParse({
        type: "support_assign_ticket",
        config: {},
      });
      expect(result.success).toBe(false);
    });

    it("rejects webhook with missing event field", () => {
      const result = automationActionSchema.safeParse({
        type: "webhook",
        config: {},
      });
      expect(result.success).toBe(false);
    });
  });

  describe("accepted well-formed configs", () => {
    it("accepts notify_roles with all required fields", () => {
      const result = automationActionSchema.safeParse({
        type: "notify_roles",
        config: { roles: ["MEMBER", "ORG_ADMIN"], title: "Alert", message: "Something happened" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts notify_roles with optional link", () => {
      const result = automationActionSchema.safeParse({
        type: "notify_roles",
        config: { roles: ["MEMBER"], title: "Alert", message: "Msg", link: "https://example.com" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts notify_all with required fields", () => {
      const result = automationActionSchema.safeParse({
        type: "notify_all",
        config: { title: "Broadcast", message: "Hello everyone" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts email with a string recipient", () => {
      const result = automationActionSchema.safeParse({
        type: "email",
        config: { to: "alice@example.com", subject: "Welcome", body: "<p>Hi</p>" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts email with an array of recipients", () => {
      const result = automationActionSchema.safeParse({
        type: "email",
        config: { to: ["alice@example.com", "bob@example.com"], subject: "Welcome", body: "Hi" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts create_task with only required title", () => {
      const result = automationActionSchema.safeParse({
        type: "create_task",
        config: { title: "Follow up" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts create_task with optional assigneeId and dueInDays", () => {
      const result = automationActionSchema.safeParse({
        type: "create_task",
        config: { title: "Review", assigneeId: "user-1", dueInDays: 3 },
      });
      expect(result.success).toBe(true);
    });

    it("accepts webhook with an event name", () => {
      const result = automationActionSchema.safeParse({
        type: "webhook",
        config: { event: "ticket.created" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts support_assign_ticket with assigneeId", () => {
      const result = automationActionSchema.safeParse({
        type: "support_assign_ticket",
        config: { assigneeId: "agent-42" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts support_set_priority with a priority string", () => {
      const result = automationActionSchema.safeParse({
        type: "support_set_priority",
        config: { priority: "URGENT" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts support_add_tag with an integer tagId", () => {
      const result = automationActionSchema.safeParse({
        type: "support_add_tag",
        config: { tagId: 7 },
      });
      expect(result.success).toBe(true);
    });

    it("accepts support_internal_note with body", () => {
      const result = automationActionSchema.safeParse({
        type: "support_internal_note",
        config: { body: "Auto-escalated due to SLA breach" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts ai_classify with an open-ended config", () => {
      const result = automationActionSchema.safeParse({
        type: "ai_classify",
        config: { categories: ["billing", "technical"], model: "fast" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts ai_summarize with an empty config", () => {
      const result = automationActionSchema.safeParse({
        type: "ai_summarize",
        config: {},
      });
      expect(result.success).toBe(true);
    });

    it("accepts ai_extract with an open-ended config", () => {
      const result = automationActionSchema.safeParse({
        type: "ai_extract",
        config: { fields: ["urgency", "sentiment"] },
      });
      expect(result.success).toBe(true);
    });

    it("accepts ai_routing_suggestion with config", () => {
      const result = automationActionSchema.safeParse({
        type: "ai_routing_suggestion",
        config: { teamId: "support-tier-2" },
      });
      expect(result.success).toBe(true);
    });
  });
});
