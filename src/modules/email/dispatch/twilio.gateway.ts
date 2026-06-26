import { Injectable } from "@nestjs/common";
import { logger } from "../../../common/logger/logger.service";

interface TwilioSendParams {
  to: string;
  body: string;
  channel: "sms" | "whatsapp";
}

interface TwilioResponse {
  sid: string;
  status: string;
  errorCode?: number;
  errorMessage?: string;
}

export interface TwilioSendResult {
  sent: boolean;
  sid?: string;
  reason?: string;
}

export interface TwilioFallbackResult {
  channel: "whatsapp" | "sms" | "none";
  sid?: string;
}

@Injectable()
export class TwilioGateway {
  private async send(params: TwilioSendParams): Promise<TwilioSendResult> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_FROM_NUMBER;

    if (!accountSid || !authToken || !fromNumber) {
      logger.info("Twilio not configured — skipping message", {
        channel: params.channel,
        to: params.to,
      });
      return { sent: false, reason: "not_configured" };
    }

    const from = params.channel === "whatsapp" ? `whatsapp:${fromNumber}` : fromNumber;
    const to = params.channel === "whatsapp" ? `whatsapp:${params.to}` : params.to;

    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages`;

    const formData = new URLSearchParams();
    formData.append("To", to);
    formData.append("From", from);
    formData.append("Body", params.body);

    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData.toString(),
      });

      const json = (await res.json()) as TwilioResponse;

      if (!res.ok) {
        logger.error("Twilio send failed", {
          channel: params.channel,
          to: params.to,
          errorCode: json.errorCode,
          errorMessage: json.errorMessage,
          status: res.status,
        });
        return { sent: false, reason: json.errorMessage ?? `HTTP ${res.status}` };
      }

      logger.info("Twilio message sent", {
        channel: params.channel,
        to: params.to,
        sid: json.sid,
      });

      return { sent: true, sid: json.sid };
    } catch (error) {
      logger.error("Twilio request threw", { channel: params.channel, error });
      return { sent: false, reason: "request_error" };
    }
  }

  sendSms(to: string, body: string): Promise<TwilioSendResult> {
    return this.send({ to, body, channel: "sms" });
  }

  sendWhatsApp(to: string, body: string): Promise<TwilioSendResult> {
    return this.send({ to, body, channel: "whatsapp" });
  }

  async sendWhatsAppWithSmsFallback(to: string, body: string): Promise<TwilioFallbackResult> {
    const waResult = await this.sendWhatsApp(to, body);
    if (waResult.sent) return { channel: "whatsapp", sid: waResult.sid };

    const smsResult = await this.sendSms(to, body);
    if (smsResult.sent) return { channel: "sms", sid: smsResult.sid };

    return { channel: "none" };
  }
}
