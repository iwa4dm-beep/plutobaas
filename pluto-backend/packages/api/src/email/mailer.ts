import nodemailer, { type Transporter } from 'nodemailer';
import { randomBytes, createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { getSql } from '../db/pool.js';

let _tx: Transporter | null = null;

function transporter(): Transporter | null {
  if (_tx) return _tx;
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host) return null;
  _tx = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });
  return _tx;
}

export function emailEnabled(): boolean {
  return !!process.env.SMTP_HOST;
}

export function siteUrl(): string {
  return process.env.SITE_URL || process.env.JWT_ISSUER || 'http://localhost:3000';
}

export function fromAddr(): string {
  return process.env.SMTP_FROM || 'no-reply@pluto.local';
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

export async function sendMail(
  cfg: Config,
  to: string,
  subject: string,
  html: string,
  template = 'generic',
): Promise<{ ok: boolean; error?: string }> {
  const tx = transporter();
  const sql = getSql(cfg);
  if (!tx) {
    // Dev/no-SMTP fallback: just log
    console.log(`[email:disabled] to=${to} subj=${subject}\n${html}\n`);
    await sql`insert into admin.email_log (to_addr, subject, template, status, error)
              values (${to}, ${subject}, ${template}, 'sent', 'smtp-disabled-logged')`;
    return { ok: true };
  }
  try {
    await tx.sendMail({ from: fromAddr(), to, subject, html });
    await sql`insert into admin.email_log (to_addr, subject, template, status)
              values (${to}, ${subject}, ${template}, 'sent')`;
    return { ok: true };
  } catch (e: any) {
    await sql`insert into admin.email_log (to_addr, subject, template, status, error)
              values (${to}, ${subject}, ${template}, 'failed', ${e.message})`;
    return { ok: false, error: e.message };
  }
}

// -------- Templates (inline, brand-neutral) --------

function wrap(title: string, body: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#f6f7f9;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.06)">
    <h2 style="margin:0 0 16px;color:#111">${title}</h2>
    ${body}
    <hr style="margin:24px 0;border:none;border-top:1px solid #eee"/>
    <p style="font-size:12px;color:#888">Sent by Pluto BaaS. If this wasn't you, ignore this email.</p>
  </div></body></html>`;
}

export function verificationEmail(token: string, email: string): { subject: string; html: string } {
  const url = `${siteUrl()}/auth/v1/verify?token=${token}&type=signup`;
  return {
    subject: 'Confirm your email',
    html: wrap('Confirm your email',
      `<p>Hi ${email},</p><p>Click the button below to verify your email address:</p>
       <p style="margin:24px 0"><a href="${url}" style="background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Verify email</a></p>
       <p style="font-size:12px;color:#666">Or open this link: <br/>${url}</p>`),
  };
}

export function recoveryEmail(token: string): { subject: string; html: string } {
  const url = `${siteUrl()}/auth/v1/verify?token=${token}&type=recovery`;
  return {
    subject: 'Reset your password',
    html: wrap('Reset your password',
      `<p>We received a request to reset your password.</p>
       <p style="margin:24px 0"><a href="${url}" style="background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Reset password</a></p>
       <p style="font-size:12px;color:#666">This link expires in 1 hour.</p>`),
  };
}
