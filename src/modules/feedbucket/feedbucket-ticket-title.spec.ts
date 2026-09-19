import { deriveFeedbackTicketTitle } from "./feedbucket-ticket-routing";

const REPORTED_BODY_38 = [
  "Opening the user details is breaking the page",
  "",
  'Description: On opening the user details the page is breaking and showing "Settings Error".',
  "",
  "Steps: 1. Navigate to the Members and Access under the Members by cliking on the Avtar.",
  "2. Click on the first user as it opens the user details in the right side page and then the page breaks and shows Settings Error.",
].join("\n");

describe("deriveFeedbackTicketTitle", () => {
  it("keeps only the reporter's headline, so the description no longer bleeds into the title", () => {
    expect(deriveFeedbackTicketTitle(REPORTED_BODY_38, "bug")).toBe(
      "Opening the user details is breaking the page",
    );
  });

  it("never returns a multi-line title, because a board cell cannot render one", () => {
    expect(deriveFeedbackTicketTitle(REPORTED_BODY_38, "bug")).not.toMatch(/[\r\n]/);
  });

  it("stops at the first sentence when the reporter wrote one long paragraph with no line break", () => {
    const body =
      "Sending the mail is throwing error. The mail is already connected via composio and the error appears immediately.";
    expect(deriveFeedbackTicketTitle(body, "bug")).toBe("Sending the mail is throwing error.");
  });

  it("truncates an over-long single sentence at a word boundary rather than mid-word", () => {
    const body = `${"pagination ".repeat(30)}breaks`;
    const title = deriveFeedbackTicketTitle(body, "bug");

    expect(title.length).toBeLessThanOrEqual(121);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/pagin…$/);
  });

  it("falls back to the submission type when the reporter sent only whitespace", () => {
    expect(deriveFeedbackTicketTitle("   \n\n  \t ", "idea")).toBe("idea feedback");
  });

  it("drops a dangling separator so the title does not end in a colon", () => {
    expect(deriveFeedbackTicketTitle("Chat is broken:\nmore detail here", "bug")).toBe(
      "Chat is broken",
    );
  });

  it("recovers the reporter's own Title field from the widget's title-blank-description join", () => {
    const widgetWireFormat = `Mail - Sending the mail is throwing error\n\nDescription: On sending the mails via mail module the system is throwing the error.\n\nThe mail is already connected via composio.`;

    expect(deriveFeedbackTicketTitle(widgetWireFormat, "bug")).toBe(
      "Mail - Sending the mail is throwing error",
    );
  });

  it("uses the description when the reporter left the optional Title field empty", () => {
    const titleOmitted = "Export button does nothing when clicked twice.";

    expect(deriveFeedbackTicketTitle(titleOmitted, "bug")).toBe(
      "Export button does nothing when clicked twice.",
    );
  });

  it("leaves a short clean headline untouched", () => {
    expect(deriveFeedbackTicketTitle("Export button does nothing", "bug")).toBe(
      "Export button does nothing",
    );
  });
});
