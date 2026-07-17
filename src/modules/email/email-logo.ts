import { logger } from "../../common/logger/logger.service";

const LOGO_CID = "streamlineos-logo";
const LOGO_URL =
  "https://pub-891e5f8831c54f9295d7dda0eac7ed65.r2.dev/email-assets/logo-v2.png";
const FETCH_TIMEOUT_MS = 4000;

export interface EmailLogoAttachment {
  filename: string;
  content: Buffer;
  type: string;
  cid: string;
}

let cachedAttachment: EmailLogoAttachment | null | undefined = undefined;

async function fetchLogoBuffer(): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(LOGO_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    logger.warn("Email logo fetch failed; falling back to monogram", {
      url: LOGO_URL,
    });
    return null;
  }
}

export async function getEmailLogoAttachment(): Promise<EmailLogoAttachment | null> {
  if (cachedAttachment !== undefined) return cachedAttachment;

  const buf = await fetchLogoBuffer();
  if (!buf) {
    cachedAttachment = null;
    return null;
  }

  cachedAttachment = {
    filename: "logo.png",
    content: buf,
    type: "image/png",
    cid: LOGO_CID,
  };
  return cachedAttachment;
}

export { LOGO_CID };

export const LOGO_MONOGRAM_TD =
  `<td width="32" height="32" align="center" valign="middle" bgcolor="#0b1220" ` +
  `style="width:32px;height:32px;border-radius:8px;background:#0b1220;font-size:0;line-height:0;">` +
  `<span style="font-family:'Geist',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;` +
  `font-size:15px;font-weight:700;color:#ffffff;line-height:32px;display:inline-block;` +
  `letter-spacing:-0.02em;">S</span>` +
  `</td>`;
