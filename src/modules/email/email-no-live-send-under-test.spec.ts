import { buildEmailClients } from "./email.provider";
import type { AppConfig } from "../../config/env.validation";

const CONFIG = {
  ZEPTOMAIL_TOKEN: "Zoho-enczapikey live-looking-token",
  ZEPTOMAIL_API_URL: "https://api.zeptomail.in/v1.1/email",
  RESEND_API_KEY: "re_live_looking_key",
} as unknown as AppConfig;

describe("buildEmailClients under NODE_ENV=test", () => {
  const original = { node: process.env.NODE_ENV, allow: process.env.EMAIL_ALLOW_LIVE_SEND };

  afterEach(() => {
    process.env.NODE_ENV = original.node;
    if (original.allow === undefined) delete process.env.EMAIL_ALLOW_LIVE_SEND;
    else process.env.EMAIL_ALLOW_LIVE_SEND = original.allow;
  });

  it("constructs no provider client even when live credentials are present", () => {
    process.env.NODE_ENV = "test";
    delete process.env.EMAIL_ALLOW_LIVE_SEND;

    expect(buildEmailClients(CONFIG)).toEqual({ resend: null, zeptomail: null });
  });

  it("still builds clients outside a test run, so the guard is scoped and not a kill switch", () => {
    process.env.NODE_ENV = "production";
    delete process.env.EMAIL_ALLOW_LIVE_SEND;

    const clients = buildEmailClients(CONFIG);

    expect(clients.zeptomail).not.toBeNull();
    expect(clients.resend).not.toBeNull();
  });

  it("allows an explicit opt-in, so a deliberate live-delivery test remains possible", () => {
    process.env.NODE_ENV = "test";
    process.env.EMAIL_ALLOW_LIVE_SEND = "1";

    expect(buildEmailClients(CONFIG).zeptomail).not.toBeNull();
  });
});
