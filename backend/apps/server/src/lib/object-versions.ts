// Phase 54 — Object versioning store (in-memory shadow of storage4_object_versions).
import { createHash, randomUUID } from "node:crypto";

export type ObjectVersion = {
  version_id: string;
  bucket: string;
  object_key: string;
  size_bytes: number;
  content_type: string | null;
  checksum_sha256: string;
  storage_uri: string;
  is_delete_marker: boolean;
  created_at: number;
};

const versions = new Map<string, ObjectVersion[]>(); // key = `${bucket}/${key}`
const kkey = (b: string, k: string) => `${b}/${k}`;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function putVersion(bucket: string, key: string, bytes: Uint8Array, content_type: string | null = null): ObjectVersion {
  const v: ObjectVersion = {
    version_id: `v_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    bucket, object_key: key,
    size_bytes: bytes.byteLength,
    content_type,
    checksum_sha256: sha256Hex(bytes),
    storage_uri: `mem://${bucket}/${key}#${Date.now()}`,
    is_delete_marker: false,
    created_at: Date.now(),
  };
  const list = versions.get(kkey(bucket, key)) ?? [];
  list.push(v);
  versions.set(kkey(bucket, key), list);
  return v;
}

export function markDelete(bucket: string, key: string): ObjectVersion {
  const v: ObjectVersion = {
    version_id: `v_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    bucket, object_key: key,
    size_bytes: 0,
    content_type: null,
    checksum_sha256: "",
    storage_uri: "",
    is_delete_marker: true,
    created_at: Date.now(),
  };
  const list = versions.get(kkey(bucket, key)) ?? [];
  list.push(v);
  versions.set(kkey(bucket, key), list);
  return v;
}

export function listVersions(bucket: string, key: string): ObjectVersion[] {
  return [...(versions.get(kkey(bucket, key)) ?? [])].sort((a, b) => b.created_at - a.created_at);
}

export function getVersion(bucket: string, key: string, version_id: string): ObjectVersion | undefined {
  return (versions.get(kkey(bucket, key)) ?? []).find((v) => v.version_id === version_id);
}

export function deleteVersion(bucket: string, key: string, version_id: string): boolean {
  const list = versions.get(kkey(bucket, key)) ?? [];
  const idx = list.findIndex((v) => v.version_id === version_id);
  if (idx < 0) return false;
  list.splice(idx, 1);
  return true;
}

export function clearVersions(): void { versions.clear(); }
