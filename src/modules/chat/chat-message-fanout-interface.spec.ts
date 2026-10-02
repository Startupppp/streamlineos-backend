import { ChatMessageFanoutService } from "./chat-message-fanout.service";
import type { MessageFanoutProvider } from "./message-fanout.interface";

describe("ChatMessageFanoutService as direct MESSAGE_FANOUT_PROVIDER binding", () => {
  it("satisfies MessageFanoutProvider without any adapter so the module can bind the token with useExisting", () => {
    const implementation: MessageFanoutProvider = ChatMessageFanoutService.prototype;
    expect(typeof implementation.dispatchRealtime).toBe("function");
    expect(typeof implementation.dispatchDeferred).toBe("function");
  });
});
