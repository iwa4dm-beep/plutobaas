# Pluto BaaS — Fullstack E2E Integration Guide (Plan)

আমি একটি বিস্তারিত End-to-End গাইড তৈরি করবো যা একজন ডেভেলপার শূন্য থেকে শুরু করে production-এ live দেওয়া পর্যন্ত ধাপে ধাপে follow করতে পারবে। এটি প্রজেক্টে `docs/GUIDE-FULLSTACK-E2E.md` ফাইলে যোগ হবে, এবং dashboard-এর একটি নতুন Help পেজ `/dashboard/help/fullstack-guide`-এ রেন্ডার হবে যেন logged-in user সরাসরি পড়তে পারে।

## Deliverables

1. **`docs/GUIDE-FULLSTACK-E2E.md`** — সম্পূর্ণ markdown গাইড (bilingual: Bengali বর্ণনা + English commands/code)।
2. **`src/routes/dashboard.help.fullstack-guide.tsx`** — একই কন্টেন্ট rendered as an in-app page (markdown → React sections, copy-to-clipboard code blocks)।
3. **`src/components/pluto/Sidebar.tsx`** — "Help" গ্রুপে "Fullstack E2E Guide" লিঙ্ক যোগ।

কোনো backend/schema change নেই — এটি pure documentation feature।

## Guide Structure (10 phase)

```text
Phase 0  Prerequisites            VPS/DNS/GitHub/Node/Docker checklist
Phase 1  Workspace + Project      Dashboard-এ workspace ও project তৈরি
Phase 2  API Keys                 anon (publishable) + service_role mint
Phase 3  Database Schema          Migration file, RLS policy, GRANT rules
Phase 4  Auth                     Email/password + JWT flow, roles table
Phase 5  Frontend Wiring          @pluto/js SDK install, env.js injection
Phase 6  Storage + Realtime       Bucket, upload, WS subscribe
Phase 7  Edge Functions / RPC     Server-side logic, secrets
Phase 8  Custom Domain + SSL      DNS records, wildcard cert, primary pin
Phase 9  Deploy + Cutover         build-and-cutover.sh, health verify
Phase 10 Observability + Ops     Traces, RBAC gate, migrations UI, backups
```

প্রত্যেক Phase-এ থাকবে: **Goal → Steps → Verify → Common errors → Rollback**।

## Key sections in detail

- **RLS pattern** — `user_roles` table + `has_role()` security-definer function (never store role on profiles)।
- **JWT claims** — `sub`, `role`, `is_superadmin` কীভাবে propagate হয় এবং `TraceAccessGate` কীভাবে চেক করে।
- **Env variables** — `VITE_PLUTO_URL`, `VITE_PLUTO_ANON_KEY` frontend-এ; `PLUTO_SERVICE_KEY`, `JWT_SECRET`, `DATABASE_URL` backend-এ।
- **Ops workflow** — Migration dry-run → approval → apply → backup → rollback path।
- **Debug tools** — `/dashboard/rbac-debug`, `/dashboard/ops/explain`, `/dashboard/ops/rls-debug`, `/dashboard/ops/jwt-inspect`, `/dashboard/ops/docker-check`।

## Sample commands included

```bash
# Frontend inject + build
bash pluto-backend/deploy/inject-pluto-env.sh
bash pluto-backend/deploy/build-and-cutover.sh <slug>

# Migration lifecycle
sudo /usr/local/sbin/pluto-ops migrate plan
sudo /usr/local/sbin/pluto-ops migrate dry-run
sudo /usr/local/sbin/pluto-ops migrate apply

# Verify live
curl -sI https://<domain>/ | grep -i x-pluto-primary
curl -s https://api.timescard.cloud/v1/health
```

## Out of scope

- New backend endpoints বা schema পরিবর্তন — শুধু documentation।
- Video/screencast — শুধু text + code।

Approve করলে তিনটে ফাইল লিখে দেবো একই টার্নে।
