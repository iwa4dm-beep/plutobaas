/**
 * File upload example — copy into a Lovable route/component.
 *
 * Uses the Pluto Storage API bucket `uploads` created by the SQL snippet in
 * docs/CONNECT-LOVABLE-FRONTEND.md. RLS restricts writes to the signed-in
 * user's own folder (`uploads/<user_id>/<filename>`).
 */
import { useState } from "react";
import { pluto } from "@/lib/pluto";

export function UploadExample() {
  const [status, setStatus] = useState<string>("");
  const [publicUrl, setPublicUrl] = useState<string | null>(null);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const { data: userData } = await pluto.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) {
      setStatus("Please sign in first.");
      return;
    }

    setStatus(`Uploading ${file.name}…`);
    const path = `${userId}/${Date.now()}-${file.name}`;

    const { error } = await pluto.storage
      .from("uploads")
      .upload(path, file, { upsert: false, contentType: file.type });

    if (error) {
      setStatus(`Upload failed: ${error.message}`);
      return;
    }

    const { data } = pluto.storage.from("uploads").getPublicUrl(path);
    setPublicUrl(data.publicUrl);
    setStatus("Uploaded ✓");
  }

  return (
    <div className="space-y-3">
      <input type="file" onChange={handleUpload} />
      <p className="text-sm text-muted-foreground">{status}</p>
      {publicUrl && (
        <a href={publicUrl} target="_blank" rel="noreferrer" className="underline">
          View uploaded file
        </a>
      )}
    </div>
  );
}
