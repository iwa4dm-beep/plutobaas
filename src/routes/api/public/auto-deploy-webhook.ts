// Public webhook receiver for Auto-Deploy Studio lifecycle events.
//
// Security:
//   - Verifies HMAC-SHA256 signature over the raw body when the
//     `AUTO_DEPLOY_WEBHOOK_SECRET` env var is set. Timing-safe compare.
//   - Requires `x-pluto-event` header; the event name must be a known
//     Auto-Deploy lifecycle event.
//   - Validates the JSON body against the matching JSON schema and returns
//     `400 Bad Request` with a structured list of field errors when the
//     payload does not match.
//
// Response contract:
//   200 { ok: true, event, deliveryId }         — accepted
//   400 { ok: false, code, message, errors[] }  — malformed / invalid
//   401 { ok: false, code: "invalid_signature" }
//   405                                          — non-POST

import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  PAYLOAD_SCHEMAS,
} from "@/lib/pluto/auto-deploy-webhook-schemas";
import type { WebhookEvent } from "@/lib/pluto/auto-deploy-webhooks";
import { ALL_EVENTS } from "@/lib/pluto/auto-deploy-webhooks";
import {
  validateAgainstSchema,
  type SchemaError,
} from "@/lib/pluto/auto-deploy-schema-validate";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export const Route = createFileRoute("/api/public/auto-deploy-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawBody = await request.text();
        const eventHeader = request.headers.get("x-pluto-event") ?? "";
        const signatureHeader = request.headers.get("x-pluto-signature") ?? "";
        const secret = process.env.AUTO_DEPLOY_WEBHOOK_SECRET ?? "";

        // 1) Signature check (only when a secret is configured server-side).
        if (secret) {
          const provided = signatureHeader.replace(/^sha256=/, "");
          const expected = createHmac("sha256", secret)
            .update(rawBody)
            .digest("hex");
          if (!timingSafeEqualHex(provided, expected)) {
            return jsonResponse(401, {
              ok: false,
              code: "invalid_signature",
              message:
                "Signature missing or does not match expected HMAC-SHA256 over raw body.",
            });
          }
        }

        // 2) JSON parse.
        let payload: unknown;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return jsonResponse(400, {
            ok: false,
            code: "invalid_json",
            message: "Request body is not valid JSON.",
          });
        }

        // 3) Event resolution — header takes precedence, else body.event.
        const bodyEvent =
          payload && typeof payload === "object"
            ? ((payload as Record<string, unknown>).event as string | undefined)
            : undefined;
        const event = (eventHeader || bodyEvent || "") as WebhookEvent;
        if (!event || !ALL_EVENTS.includes(event)) {
          return jsonResponse(400, {
            ok: false,
            code: "unknown_event",
            message: `Unknown or missing event. Expected 'x-pluto-event' header or body.event to be one of: ${ALL_EVENTS.join(", ")}.`,
            received: eventHeader || bodyEvent || null,
          });
        }

        // 4) Header/body event mismatch — reject rather than silently accept.
        if (eventHeader && bodyEvent && eventHeader !== bodyEvent) {
          return jsonResponse(400, {
            ok: false,
            code: "event_mismatch",
            message: `Header 'x-pluto-event' (${eventHeader}) does not match body.event (${bodyEvent}).`,
          });
        }

        // 5) JSON-Schema validation against the event's canonical schema.
        const schemaDef = PAYLOAD_SCHEMAS[event];
        const errors: SchemaError[] = validateAgainstSchema(
          schemaDef.schema,
          payload,
        );
        if (errors.length > 0) {
          return jsonResponse(400, {
            ok: false,
            code: "schema_validation_failed",
            message: `Payload does not match schema for '${event}'.`,
            schema: `pluto.auto-deploy.${event}`,
            errors,
          });
        }

        const deliveryId =
          (payload as Record<string, unknown>).delivery_id ?? null;
        return jsonResponse(200, { ok: true, event, deliveryId });
      },

      // Reject anything that isn't a POST with a clear 405.
      GET: async () =>
        new Response(
          JSON.stringify({
            ok: false,
            code: "method_not_allowed",
            message: "Use POST to deliver Auto-Deploy webhook events.",
            events: ALL_EVENTS,
          }),
          {
            status: 405,
            headers: {
              "content-type": "application/json",
              allow: "POST",
            },
          },
        ),
    },
  },
});
