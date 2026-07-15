// Client helper: call the server fn, decode base64, wrap in a File
// so the existing ZIP pipeline (verify → analyze → plan) can consume it
// unchanged.
import { fetchGithubZip } from "./github-loader.functions";

export async function loadRepoAsFile(source: string, ref?: string): Promise<File> {
  const r = await fetchGithubZip({ data: { source, ref } });
  const bin = atob(r.zipBase64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new File([buf], r.filename, { type: "application/zip" });
}
