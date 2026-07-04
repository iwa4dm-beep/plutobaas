// Phase 31 — Email transport abstraction.
//
// Two adapters: `console` writes to stdout (dev), `webhook` POSTs the
// message to $PLUTO_EMAIL_WEBHOOK_URL. Real SMTP / Resend / SendGrid
// plugs in by adding another adapter without touching call sites.

export type OutboundEmail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  tag?: string; // e.g. "password-reset", "email-confirm"
};

export interface EmailProvider {
  name: string;
  send(msg: OutboundEmail): Promise<{ id: string }>;
}

class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";
  async send(msg: OutboundEmail) {
    // eslint-disable-next-line no-console
    console.log("[email:console]", JSON.stringify({ ...msg, html: undefined }, null, 2));
    return { id: `console_${Date.now().toString(36)}` };
  }
}

class WebhookEmailProvider implements EmailProvider {
  readonly name = "webhook";
  constructor(private readonly url: string, private readonly secret?: string) {}
  async send(msg: OutboundEmail) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.secret ? { "x-pluto-signature": this.secret } : {}),
      },
      body: JSON.stringify(msg),
    });
    if (!res.ok) throw new Error(`email_webhook_${res.status}`);
    const j = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: j.id ?? `wh_${Date.now().toString(36)}` };
  }
}

// SMTP adapter — beta-blocker email transport for auth flows.
// Uses raw net.Socket (STARTTLS) so there's no nodemailer dep. Enough
// for password-reset, email-confirm, OTP delivery.
class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  constructor(private readonly cfg: {
    host: string; port: number; user: string; pass: string;
    from: string; secure: boolean;
  }) {}
  async send(msg: OutboundEmail) {
    const net = await import("node:net");
    const tls = await import("node:tls");
    const from = this.cfg.from;
    const lines: string[] = [
      `From: ${from}`, `To: ${msg.to}`, `Subject: ${msg.subject}`,
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "",
      msg.text,
    ];
    const body = lines.join("\r\n") + "\r\n.\r\n";
    const auth = Buffer.from(`\x00${this.cfg.user}\x00${this.cfg.pass}`).toString("base64");
    return await new Promise<{ id: string }>((resolve, reject) => {
      const sock: import("node:net").Socket = this.cfg.secure
        ? tls.connect(this.cfg.port, this.cfg.host)
        : net.createConnection(this.cfg.port, this.cfg.host);
      let step = 0; let buf = "";
      const script = [
        `EHLO pluto\r\n`, `AUTH PLAIN ${auth}\r\n`,
        `MAIL FROM:<${from.replace(/.*<|>.*/g, "")}>\r\n`,
        `RCPT TO:<${msg.to}>\r\n`, `DATA\r\n`, body, `QUIT\r\n`,
      ];
      sock.setEncoding("utf8");
      sock.on("data", (d) => {
        buf += d;
        while (buf.includes("\r\n")) {
          const line = buf.slice(0, buf.indexOf("\r\n")); buf = buf.slice(buf.indexOf("\r\n") + 2);
          if (/^[45]\d\d/.test(line)) { sock.destroy(); return reject(new Error(`smtp:${line}`)); }
          if (/^2\d\d/.test(line) || /^3\d\d/.test(line)) {
            const cmd = script[step++]; if (cmd) sock.write(cmd);
            else { sock.end(); resolve({ id: `smtp_${Date.now().toString(36)}` }); }
          }
        }
      });
      sock.on("error", reject);
      sock.setTimeout(15_000, () => { sock.destroy(); reject(new Error("smtp_timeout")); });
    });
  }
}

let _provider: EmailProvider | null = null;
export function emailProvider(): EmailProvider {
  if (_provider) return _provider;
  if (process.env.SMTP_HOST) {
    _provider = new SmtpEmailProvider({
      host: process.env.SMTP_HOST!,
      port: Number(process.env.SMTP_PORT ?? 587),
      user: process.env.SMTP_USER ?? "",
      pass: process.env.SMTP_PASS ?? "",
      from: process.env.SMTP_FROM ?? "no-reply@pluto.local",
      secure: (process.env.SMTP_SECURE ?? "0") === "1",
    });
    return _provider;
  }
  const url = process.env.PLUTO_EMAIL_WEBHOOK_URL;

  _provider = url
    ? new WebhookEmailProvider(url, process.env.PLUTO_EMAIL_WEBHOOK_SECRET)
    : new ConsoleEmailProvider();
  return _provider;
}

// ---- Templates (plain-text; callers may wrap with HTML) ---------------

export function passwordResetEmail(link: string, ttlMinutes: number): OutboundEmail {
  return {
    to: "",
    subject: "Reset your password",
    tag: "password-reset",
    text: [
      "Someone (hopefully you) asked to reset your password.",
      `Open this link within ${ttlMinutes} minutes to choose a new one:`,
      link,
      "",
      "If you didn't request this, you can safely ignore this email.",
    ].join("\n"),
  };
}

export function emailConfirmEmail(link: string, ttlMinutes: number): OutboundEmail {
  return {
    to: "",
    subject: "Confirm your email address",
    tag: "email-confirm",
    text: [
      "Welcome! Please confirm your email address by opening the link below:",
      link,
      "",
      `The link expires in ${ttlMinutes} minutes.`,
    ].join("\n"),
  };
}
