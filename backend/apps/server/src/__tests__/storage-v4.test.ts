// Phase 54 — Storage v4: versioning, retention, replication unit tests.
import { describe, it, expect, beforeEach } from "vitest";
import { putVersion, listVersions, getVersion, deleteVersion, markDelete, clearVersions } from "../lib/object-versions.js";
import { setLock, canModify, clearLegalHold, clearLocks } from "../lib/retention.js";
import { submit, runOnce, statusFor, clearJobs } from "../lib/replication.js";

beforeEach(() => { clearVersions(); clearLocks(); clearJobs(); });

describe("object versioning", () => {
  it("assigns unique version ids and lists newest first", () => {
    const a = putVersion("b1", "file.txt", new Uint8Array([1]));
    const b = putVersion("b1", "file.txt", new Uint8Array([1, 2]));
    expect(a.version_id).not.toBe(b.version_id);
    const list = listVersions("b1", "file.txt");
    expect(list[0]!.version_id).toBe(b.version_id);
    expect(list).toHaveLength(2);
    expect(getVersion("b1", "file.txt", a.version_id)?.checksum_sha256).toBe(a.checksum_sha256);
  });
  it("delete marker preserves history", () => {
    putVersion("b1", "x", new Uint8Array([9]));
    markDelete("b1", "x");
    const list = listVersions("b1", "x");
    expect(list[0]!.is_delete_marker).toBe(true);
    expect(list).toHaveLength(2);
  });
  it("deleteVersion removes a single version", () => {
    const a = putVersion("b1", "x", new Uint8Array([1]));
    expect(deleteVersion("b1", "x", a.version_id)).toBe(true);
    expect(getVersion("b1", "x", a.version_id)).toBeUndefined();
  });
});

describe("retention locks", () => {
  const future = new Date(Date.now() + 60_000).getTime();
  it("blocks modification while locked", () => {
    const v = putVersion("b1", "x", new Uint8Array([1]));
    setLock("b1", "x", v.version_id, { mode: "governance", retain_until: future, legal_hold: false });
    expect(canModify("b1", "x", v.version_id)).toBe(false);
    expect(canModify("b1", "x", v.version_id, { bypass_governance: true })).toBe(true);
  });
  it("compliance locks cannot be shortened", () => {
    const v = putVersion("b1", "x", new Uint8Array([1]));
    setLock("b1", "x", v.version_id, { mode: "compliance", retain_until: future, legal_hold: false });
    expect(() => setLock("b1", "x", v.version_id, { mode: "compliance", retain_until: Date.now() + 1_000, legal_hold: false }))
      .toThrow(/compliance_lock_shorten/);
    expect(canModify("b1", "x", v.version_id, { bypass_governance: true })).toBe(false); // bypass ignored
  });
  it("legal hold overrides retention window and can be cleared", () => {
    const v = putVersion("b1", "x", new Uint8Array([1]));
    setLock("b1", "x", v.version_id, { mode: "governance", retain_until: Date.now() - 1_000, legal_hold: true });
    expect(canModify("b1", "x", v.version_id)).toBe(false);
    clearLegalHold("b1", "x", v.version_id);
    expect(canModify("b1", "x", v.version_id)).toBe(true);
  });
});

describe("replication", () => {
  it("idempotency: same key returns same job", () => {
    const a = submit({ bucket: "b", object_key: "x", version_id: "v1",
      source_region: "us-east", target_region: "eu-west", idempotency_key: "k1" });
    const b = submit({ bucket: "b", object_key: "x", version_id: "v1",
      source_region: "us-east", target_region: "eu-west", idempotency_key: "k1" });
    expect(a.id).toBe(b.id);
  });
  it("succeeds with checksum verification", async () => {
    const v = putVersion("b", "x", new Uint8Array([1, 2, 3]));
    const j = submit({ bucket: "b", object_key: "x", version_id: v.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "k2" });
    const r = await runOnce(j.id, async () => ({ ok: true, remote_checksum: v.checksum_sha256 }), v.checksum_sha256, v.created_at);
    expect(r.status).toBe("succeeded");
    expect(r.checksum_verified).toBe(true);
  });
  it("checksum mismatch retries with backoff", async () => {
    const v = putVersion("b", "x", new Uint8Array([1]));
    const j = submit({ bucket: "b", object_key: "x", version_id: v.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "k3" });
    const r1 = await runOnce(j.id, async () => ({ ok: true, remote_checksum: "wrong" }), v.checksum_sha256, v.created_at);
    expect(r1.status).toBe("pending");
    expect(r1.last_error).toMatch(/checksum_mismatch/);
    expect(r1.next_attempt_at).toBeGreaterThan(Date.now());
  });
  it("out-of-order older version is skipped after newer one replicates", async () => {
    const v1 = putVersion("b", "x", new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 2));
    const v2 = putVersion("b", "x", new Uint8Array([2]));
    const j2 = submit({ bucket: "b", object_key: "x", version_id: v2.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "kb" });
    await runOnce(j2.id, async () => ({ ok: true, remote_checksum: v2.checksum_sha256 }), v2.checksum_sha256, v2.created_at);
    const j1 = submit({ bucket: "b", object_key: "x", version_id: v1.version_id,
      source_region: "us-east", target_region: "eu-west", idempotency_key: "ka" });
    const r = await runOnce(j1.id, async () => ({ ok: true, remote_checksum: v1.checksum_sha256 }), v1.checksum_sha256, v1.created_at);
    expect(r.status).toBe("skipped");
    expect(statusFor("b", "x", v2.version_id)[0]!.status).toBe("succeeded");
  });
});
