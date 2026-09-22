import { NotificationEmailProvider } from "./notification-email.provider";
import type { EmailProviderService } from "../../email/email.provider";
import type { EmailSuppressionService } from "../../email/email-suppression.service";
import type { ProviderSendInput } from "../notification.types";

function makeSuppressionService(
  suppressedEmails: string[] = [],
): jest.Mocked<Pick<EmailSuppressionService, "findSuppressed">> {
  return {
    findSuppressed: jest.fn().mockResolvedValue(new Set(suppressedEmails)),
  };
}

function makeEmailProvider(
  dispatchImpl: jest.Mock = jest.fn().mockResolvedValue(undefined),
): jest.Mocked<Pick<EmailProviderService, "getEmailProvider" | "dispatchEmail">> {
  return {
    getEmailProvider: jest.fn().mockReturnValue("zeptomail"),
    dispatchEmail: dispatchImpl,
  };
}

function makeProvider(opts: {
  dispatch?: jest.Mock;
  suppressed?: string[];
}): { provider: NotificationEmailProvider; dispatch: jest.Mock; suppression: ReturnType<typeof makeSuppressionService> } {
  const dispatch = opts.dispatch ?? jest.fn().mockResolvedValue(undefined);
  const suppression = makeSuppressionService(opts.suppressed ?? []);
  const provider = new NotificationEmailProvider(
    makeEmailProvider(dispatch) as never,
    { PUBLIC_API_URL: undefined },
    suppression as never,
  );
  return { provider, dispatch, suppression };
}

const BASE_INPUT: ProviderSendInput = {
  orgId: "org-1",
  userId: "user-1",
  channel: "EMAIL",
  recipientAddress: "recipient@example.com",
  title: "Hello",
  message: "World",
  priority: "NORMAL",
  sandbox: false,
};

describe("NotificationEmailProvider.send — suppression gate", () => {
  it("does not call dispatchEmail when the recipient is on the suppression list", async () => {
    const { provider, dispatch } = makeProvider({ suppressed: ["recipient@example.com"] });

    await provider.send(BASE_INPUT);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns retryable:false when the recipient is suppressed, so the delivery worker marks it DEAD instead of re-queuing", async () => {
    const { provider } = makeProvider({ suppressed: ["recipient@example.com"] });

    const result = await provider.send(BASE_INPUT);

    expect(result.status).toBe("FAILED");
    expect(result.retryable).toBe(false);
    expect(result.failureCode).toBe("SUPPRESSED");
  });

  it("dispatches the email and returns SENT when the recipient is not on the suppression list", async () => {
    const { provider, dispatch } = makeProvider({ suppressed: [] });

    const result = await provider.send(BASE_INPUT);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("SENT");
  });

  it("calls findSuppressed with the recipient address and the org id so that removing the check causes this assertion to fail", async () => {
    const { provider, suppression } = makeProvider({ suppressed: [] });

    await provider.send(BASE_INPUT);

    expect(suppression.findSuppressed).toHaveBeenCalledWith(
      ["recipient@example.com"],
      "org-1",
    );
  });

  it("suppresses case-insensitively because EmailSuppressionService stores canonical lowercase emails and canonicalEmail normalises before the Set lookup", async () => {
    const { provider, dispatch } = makeProvider({ suppressed: ["recipient@example.com"] });

    const result = await provider.send({ ...BASE_INPUT, recipientAddress: "RECIPIENT@EXAMPLE.COM" });

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.status).toBe("FAILED");
    expect(result.retryable).toBe(false);
  });

  it("skips the suppression check in sandbox mode, because sandbox sends are already short-circuited before the address matters", async () => {
    const { provider, suppression } = makeProvider({ suppressed: ["recipient@example.com"] });

    const result = await provider.send({ ...BASE_INPUT, sandbox: true });

    expect(suppression.findSuppressed).not.toHaveBeenCalled();
    expect(result.status).toBe("SENT");
  });
});

describe("NotificationEmailProvider — outbox suppression seam regression", () => {
  it("gates through EmailSuppressionService.findSuppressed, the same injectable seam the outbox path uses, so both paths share one suppression implementation", async () => {
    const { provider, dispatch, suppression } = makeProvider({
      suppressed: ["blocked@example.com"],
    });

    const result = await provider.send({ ...BASE_INPUT, recipientAddress: "blocked@example.com" });

    expect(suppression.findSuppressed).toHaveBeenCalledTimes(1);
    expect(suppression.findSuppressed).toHaveBeenCalledWith(["blocked@example.com"], "org-1");
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.retryable).toBe(false);
  });

  it("leaves a non-suppressed address's dispatch path unchanged, confirming the seam is transparent for normal sends", async () => {
    const { provider, dispatch, suppression } = makeProvider({ suppressed: [] });

    await provider.send(BASE_INPUT);

    expect(suppression.findSuppressed).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
