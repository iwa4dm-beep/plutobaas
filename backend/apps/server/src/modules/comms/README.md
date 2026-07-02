# Communications module

Fastify plugin — mounted at `/comms/v1/*` from `server.ts`.

Phase 14.0 (current commit) ships:
- SQL migration `0014_comms.sql`
- Module skeleton (`plugin.ts`, `email.ts`, `sms.ts`, `webhooks.ts`)
- Provider interface + `SmtpDriver` scaffold
- Route registration behind an env flag (`PLUTO_ENABLE_COMMS=1`)

Phase 14.1 lands the full send/deliver pipeline; see `docs/PHASE-14.md`.

## Routes (final surface)

| Method | Path                                                | Auth        |
| ------ | --------------------------------------------------- | ----------- |
| POST   | `/comms/v1/email/send`                              | workspace   |
| GET    | `/comms/v1/email?status=&limit=`                    | workspace   |
| POST   | `/comms/v1/sms/send`                                | workspace   |
| GET    | `/comms/v1/sms?status=&limit=`                      | workspace   |
| GET    | `/comms/v1/webhooks`                                | workspace   |
| POST   | `/comms/v1/webhooks`                                | admin       |
| PATCH  | `/comms/v1/webhooks/:id`                            | admin       |
| DELETE | `/comms/v1/webhooks/:id`                            | admin       |
| POST   | `/comms/v1/webhooks/:id/test`                       | admin       |
| GET    | `/comms/v1/webhooks/:id/deliveries?status=&limit=`  | workspace   |
| POST   | `/comms/v1/webhooks/:id/deliveries/:did/retry`      | admin       |

## Provider interface

```ts
interface EmailDriver {
  name: "smtp" | "resend" | "ses" | "postmark";
  send(msg: EmailOutbound): Promise<{ providerId: string }>;
}
interface SmsDriver {
  name: "twilio" | "messagebird" | "log";
  send(msg: SmsOutbound): Promise<{ providerId: string; segments: number }>;
}
```
