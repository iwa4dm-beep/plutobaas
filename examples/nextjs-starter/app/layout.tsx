export const metadata = {
  title: "Pluto BaaS — Next.js Starter",
  description: "Auth + RLS + Webhooks E2E starter for Pluto BaaS.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 24 }}>{children}</body>
    </html>
  );
}
