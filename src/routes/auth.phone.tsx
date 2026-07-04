import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Zap, ArrowLeft } from "lucide-react";
import { isLive, live } from "@/lib/pluto/live";
import { toast } from "sonner";

export const Route = createFileRoute("/auth/phone")({
  ssr: false,
  head: () => ({ meta: [{ title: "Sign in with phone — Pluto BaaS" }] }),
  component: PhoneAuthPage,
});

function PhoneAuthPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("+");
  const [channel, setChannel] = useState<"sms" | "whatsapp">("sms");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function requestOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) return toast.error("Enter phone in E.164 format (e.g. +15551234567).");
    setBusy(true);
    try {
      if (isLive()) await live.auth.signInWithOtp({ phone, channel });
      toast.success("Verification code sent.");
      setStep("code");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally { setBusy(false); }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return toast.error("Enter the 6-digit code.");
    setBusy(true);
    try {
      if (isLive()) await live.auth.verifyOtp({ phone, token: code });
      navigate({ to: "/dashboard" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Verification failed");
    } finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 justify-center mb-8">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Zap className="h-4 w-4" />
          </div>
          <span className="font-semibold tracking-tight text-lg">Pluto BaaS</span>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">
            {step === "phone" ? "Sign in with phone" : "Enter verification code"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {step === "phone"
              ? "আপনার phone number-এ 6-digit code পাঠাব।"
              : `Code sent to ${phone}. 10 মিনিট বৈধ।`}
          </p>

          {step === "phone" ? (
            <form onSubmit={requestOtp} className="mt-5 space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Phone (E.164)</label>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required
                  placeholder="+15551234567"
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Channel</label>
                <select value={channel} onChange={(e) => setChannel(e.target.value as "sms" | "whatsapp")}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <option value="sms">SMS</option>
                  <option value="whatsapp">WhatsApp</option>
                </select>
              </div>
              <button type="submit" disabled={busy}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                {busy ? "Sending…" : "Send code"}
              </button>
              <Link to="/auth" className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground">
                <ArrowLeft className="h-3 w-3" /> Back to sign in
              </Link>
            </form>
          ) : (
            <form onSubmit={verifyOtp} className="mt-5 space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">6-digit code</label>
                <input type="text" inputMode="numeric" pattern="\d{6}" value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  required maxLength={6}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
              <button type="submit" disabled={busy}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                {busy ? "Verifying…" : "Verify & sign in"}
              </button>
              <button type="button" onClick={() => setStep("phone")}
                className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground">
                <ArrowLeft className="h-3 w-3" /> Change phone
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
