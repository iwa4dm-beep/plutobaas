# Plan: `timescard.cloud`-এর subdomain-এ Live করা

লক্ষ্য: এই Lovable project-টা `timescard.cloud`-এর একটা subdomain-এ (যেমন `app.timescard.cloud` বা `pluto.timescard.cloud`) live করা এবং SSL সহ auto-refresh-able deep links কাজ করা।

## পদক্ষেপ

### 1. Subdomain সিদ্ধান্ত

আপনাকে জানাতে হবে কোন subdomain চান। প্রস্তাব:

- `app.timescard.cloud` — dashboard/app-এর জন্য standard
- `pluto.timescard.cloud` — Pluto BaaS branding-এর সাথে মিলে
- `admin.timescard.cloud` — admin console indication

### 2. Lovable-এ project publish করা

- `preview_ui--publish` দিয়ে project deploy করব → `plutobaas.lovable.app`-এ live হবে (~১ মিনিট)।
- Publish না হলে custom domain flow available হয় না।
- Publish আগে security scan check করব।

### 3. Custom domain connect

- Project Settings → Domains → **Connect Domain** → subdomain type করব (e.g. `app.timescard.cloud`)।
- Lovable DNS instruction দেবে।

### 4. DNS records (আপনার registrar-এ যোগ করতে হবে)

`timescard.cloud`-এর DNS provider-এ (Cloudflare / Namecheap / GoDaddy যেখানেই আছে):

```text
Type: A       Name: app        Value: 185.158.133.1
Type: TXT     Name: _lovable   Value: lovable_verify=<Lovable UI যা দেবে>
```

**Cloudflare proxy (orange cloud) ব্যবহার করলে:** Connect dialog-এ Advanced → "Domain uses Cloudflare or a similar proxy" tick করতে হবে — তাহলে CNAME-based verification হবে।

### 5. Verify + SSL

- DNS propagate হতে সর্বোচ্চ ৭২ ঘন্টা (সাধারণত ৫–৩০ মিনিট)।
- Lovable auto SSL provision করবে।
- Status: `Verifying` → `Setting up` → `Active`।

### 6. Post-live verification

- `https://app.timescard.cloud` open করে check করব।
- `/dashboard/pluto-deploy` deep link refresh করে TanStack routing verify করব।

## আপনার কাছ থেকে যা লাগবে

**১। কোন subdomain?** (`app`) যতগুলো প্রজেক্ট ডেপলয়মেন্ট করা হবে সব এভাবে পাবলিশ হবে নাম অটো পরিবর্তন হতে থাকবে।  
২।`timescard.cloud`**-এর DNS কোথায় manage হয়?** ( Hostinger ) — Cloudflare হলে proxy mode বলে দেবেন।

৩।Publish visibility — **public** (anyone with link) 

## Technical notes

- Lovable IP: `185.158.133.1` (static A record)
- TanStack Start SPA fallback Lovable hosting-এই handled — `_redirects` / `vercel.json` লাগবে না।
- DNS/domain add আমি করতে পারব না — সেটা আপনাকে registrar UI-তে করতে হবে। বাকি সব (publish, connect flow trigger, verification poll) আমি করব।

Approve করলে আমি publish শুরু করব এবং subdomain connect step-by-step guide করব।