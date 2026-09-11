import { NotificationEmailProvider } from "./notification-email.provider";
import { NotificationWebPushProvider } from "./notification-web-push.provider";
import type { EmailProviderService } from "../../email/email.provider";
import type { WebPushService } from "../../realtime/web-push.service";
import type { ProviderSendInput } from "../notification.types";

const RECIPIENT = "ada.lovelace@customer.example";
const TITLE = "Your termination letter is ready";

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const out = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  const err = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => [out, err].forEach((s) => s.mockRestore()) };
}

function input(overrides: Partial<ProviderSendInput> = {}): ProviderSendInput {
  return {
    orgId: "org-sandbox-1",
    userId: "user-sandbox-1",
    channel: "EMAIL",
    recipientAddress: RECIPIENT,
    title: TITLE,
    message: "Sign in to download it.",
    priority: "NORMAL",
    sandbox: true,
    ...overrides,
  };
}

/**
 * PRD-C102. The sandbox short-circuit is the one branch in each provider that
 * logs before any provider call, and it was writing the recipient's address and
 * the notification's own title straight into the message string, where the
 * redactor cannot reach them.
 */
describe("sandbox notification providers emit a tenant-safe line", () => {
  let cap: ReturnType<typeof capture>;
  beforeEach(() => {
    cap = capture();
  });
  afterEach(() => cap.restore());

  it("(bite proof) the fixture carries the recipient and title a leak would print", () => {
    expect(JSON.stringify(input())).toContain(RECIPIENT);
    expect(JSON.stringify(input())).toContain(TITLE);
  });

  it("email: neither the recipient address nor the title is in the emitted line", async () => {
    const provider = new NotificationEmailProvider({} as EmailProviderService, {});
    const result = await provider.send(input());

    const joint = cap.lines.join("");
    expect(result.status).toBe("SENT");
    expect(joint).not.toContain(RECIPIENT);
    expect(joint).not.toContain(TITLE);
    expect(joint).toContain("org-sandbox-1");
  });

  it("web push: the title is not in the emitted line", async () => {
    const provider = new NotificationWebPushProvider({} as WebPushService);
    const result = await provider.send(input({ channel: "PUSH" }));

    const joint = cap.lines.join("");
    expect(result.status).toBe("SENT");
    expect(joint).not.toContain(TITLE);
    expect(joint).toContain("org-sandbox-1");
  });

  it("the line is still structured JSON an operator can act on", async () => {
    await new NotificationEmailProvider({} as EmailProviderService, {}).send(input());
    const record = JSON.parse(cap.lines.join("")) as Record<string, unknown>;
    expect(record["level"]).toBe("debug");
    const meta = record["meta"] as Record<string, unknown>;
    expect(meta["orgId"]).toBe("org-sandbox-1");
    expect(meta["userId"]).toBe("user-sandbox-1");
    expect(meta["hasAddressOnFile"]).toBe(true);
  });
});
