// Phase 54 — Extended replication conflict-resolution tests.
// Covers duplicate arrivals, ordering across regions, and idempotency reuse.
import { describe, it, expect, beforeEach } from "vitest";
import { putVersion, clearVersions } from "../lib/object-versions.js";
import { submit, runOnce, statusFor, listJobs, clearJobs } from "../lib/replication.js";

beforeEach(() => { clearVersions(); clearJobs(); });

describe("replication — duplicate version arrivals", () => {
  it("re-submitting the same version + region + idempotency key returns the same job (no dupes)", () => {
    const v = putVersion("b", "x", new Uint8Array([1]));
    const a = submit({ bucket: "b", object_key: "x", version_id: v.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "same" });
    const b = submit({ bucket: "b", object_key: "x", version_id: v.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "same" });
    const c = submit({ bucket: "b", object_key: "x", version_id: v.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "same" });
    expect(a.id).toBe(b.id);
    expect(b.id).toBe(c.id);
    expect(listJobs()).toHaveLength(1);
  });

  it("duplicate arrivals with different idempotency keys are independent jobs (both allowed)", async () => {
    const v = putVersion("b", "x", new Uint8Array([1]));
    const j1 = submit({ bucket: "b", object_key: "x", version_id: v.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "k1" });
    const j2 = submit({ bucket: "b", object_key: "x", version_id: v.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "k2" });
    expect(j1.id).not.toBe(j2.id);
    await runOnce(j1.id, async () => ({ ok: true, remote_checksum: v.checksum_sha256 }), v.checksum_sha256, v.created_at);
    // Second job for the same version now finds a cursor at ${created_at}::${version_id};
    // the equality check causes it to be skipped as a duplicate.
    const r2 = await runOnce(j2.id, async () => ({ ok: true, remote_checksum: v.checksum_sha256 }), v.checksum_sha256, v.created_at);
    expect(r2.status).toBe("skipped");
  });
});

describe("replication — ordering across regions", () => {
  it("cursor is per-target-region: same version replicates to two regions independently", async () => {
    const v = putVersion("b", "x", new Uint8Array([1]));
    const eu = submit({ bucket: "b", object_key: "x", version_id: v.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "eu" });
    const ap = submit({ bucket: "b", object_key: "x", version_id: v.version_id,
      source_region: "us-east", target_region: "ap-southeast", idempotency_key: "ap" });
    const rEu = await runOnce(eu.id, async () => ({ ok: true, remote_checksum: v.checksum_sha256 }), v.checksum_sha256, v.created_at);
    const rAp = await runOnce(ap.id, async () => ({ ok: true, remote_checksum: v.checksum_sha256 }), v.checksum_sha256, v.created_at);
    expect(rEu.status).toBe("succeeded");
    expect(rAp.status).toBe("succeeded"); // different target — not blocked by eu cursor
  });

  it("newer version wins in region A but older can still ship to region B", async () => {
    const v1 = putVersion("b", "y", new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 2));
    const v2 = putVersion("b", "y", new Uint8Array([2]));

    // Region eu-west: newer first, then older → older is skipped.
    const euNew = submit({ bucket: "b", object_key: "y", version_id: v2.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "eu-new" });
    const euOld = submit({ bucket: "b", object_key: "y", version_id: v1.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "eu-old" });
    await runOnce(euNew.id, async () => ({ ok: true, remote_checksum: v2.checksum_sha256 }), v2.checksum_sha256, v2.created_at);
    const rEuOld = await runOnce(euOld.id, async () => ({ ok: true, remote_checksum: v1.checksum_sha256 }), v1.checksum_sha256, v1.created_at);
    expect(rEuOld.status).toBe("skipped");

    // Region ap-southeast: only older ships → succeeds (independent cursor).
    const apOld = submit({ bucket: "b", object_key: "y", version_id: v1.version_id,
      source_region: "us-east", target_region: "ap-southeast", idempotency_key: "ap-old" });
    const rApOld = await runOnce(apOld.id, async () => ({ ok: true, remote_checksum: v1.checksum_sha256 }), v1.checksum_sha256, v1.created_at);
    expect(rApOld.status).toBe("succeeded");
  });
});

describe("replication — idempotency key reuse edge cases", () => {
  it("reusing an idempotency key with different target parameters still returns the original job", () => {
    const v = putVersion("b", "x", new Uint8Array([1]));
    const first = submit({ bucket: "b", object_key: "x", version_id: v.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "shared" });
    const collision = submit({ bucket: "b", object_key: "x", version_id: v.version_id,
      source_region: "us-east", target_region: "ap-southeast", idempotency_key: "shared" });
    // Idempotency wins over parameters — behavior mirrors Stripe/AWS conventions.
    expect(collision.id).toBe(first.id);
    expect(collision.target_region).toBe("eu-west");
  });

  it("successful job stays succeeded across further runOnce calls (no accidental retry)", async () => {
    const v = putVersion("b", "x", new Uint8Array([1]));
    const j = submit({ bucket: "b", object_key: "x", version_id: v.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "once" });
    const a = await runOnce(j.id, async () => ({ ok: true, remote_checksum: v.checksum_sha256 }), v.checksum_sha256, v.created_at);
    const b = await runOnce(j.id, async () => ({ ok: false, error: "should-not-run" }), v.checksum_sha256, v.created_at);
    expect(a.status).toBe("succeeded");
    expect(b.status).toBe("succeeded");
    expect(b.attempts).toBe(1); // no additional attempt
  });

  it("status endpoint aggregates all jobs for a version (retries + skips + successes)", async () => {
    const v = putVersion("b", "z", new Uint8Array([1]));
    const good = submit({ bucket: "b", object_key: "z", version_id: v.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "good" });
    const dup = submit({ bucket: "b", object_key: "z", version_id: v.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "dup" });
    const badChecksum = submit({ bucket: "b", object_key: "z", version_id: v.version_id,
      source_region: "us-east", target_region: "ap-southeast", idempotency_key: "bad" });
    await runOnce(good.id, async () => ({ ok: true, remote_checksum: v.checksum_sha256 }), v.checksum_sha256, v.created_at);
    await runOnce(dup.id, async () => ({ ok: true, remote_checksum: v.checksum_sha256 }), v.checksum_sha256, v.created_at);
    await runOnce(badChecksum.id, async () => ({ ok: true, remote_checksum: "wrong" }), v.checksum_sha256, v.created_at);
    const statuses = statusFor("b", "z", v.version_id).map((j) => j.status).sort();
    expect(statuses).toEqual(["pending", "skipped", "succeeded"]);
  });
});
