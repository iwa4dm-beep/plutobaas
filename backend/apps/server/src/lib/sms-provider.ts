// Phase 31 — SMS transport abstraction.
//
// Adapters: `console` (dev, writes to stdout), `twilio` (uses standard
// Twilio Messages.json REST API when TWILIO_ACCOUNT_SID +
// TWILIO_AUTH_TOKEN + TWILIO_FROM are set).

export type OutboundSms = {
  to: string;                 // E.164
  body: string;
  channel?: "sms" | "whatsapp";
};

export interface SmsProvider {
  name: string;
  send(msg: OutboundSms): Promise<{ id: string }>;
}

class ConsoleSmsProvider implements SmsProvider {
  readonly name = "console";
  async send(msg: OutboundSms) {
    // eslint-disable-next-line no-console
    console.log("[sms:console]", JSON.stringify(msg));
    return { id: `console_${Date.now().toString(36)}` };
  }
}

class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly from: string,           // "+15551234567" or "whatsapp:+..."
  ) {}
  async send(msg: OutboundSms) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const from = msg.channel === "whatsapp" ? `whatsapp:${this.from}` : this.from;
    const to   = msg.channel === "whatsapp" ? `whatsapp:${msg.to}`    : msg.to;
    const body = new URLSearchParams({ To: to, From: from, Body: msg.body });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`twilio_${res.status}: ${t.slice(0, 200)}`);
    }
    const j = (await res.json()) as { sid?: string };
    return { id: j.sid ?? `tw_${Date.now().toString(36)}` };
  }
}

let _sms: SmsProvider | null = null;
export function smsProvider(): SmsProvider {
  if (_sms) return _sms;
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = process.env;
  _sms = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM)
    ? new TwilioSmsProvider(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM)
    : new ConsoleSmsProvider();
  return _sms;
}
