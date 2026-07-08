## Goal

Auth & Users page-এ admin এখন থেকে dashboard থেকেই যেকোনো user-কে এক ক্লিকে verified করতে পারবে (এমনকি user নিজে email confirm না করলেও)। Super Admin / Admin / User — তিন role-ই যাতে সঠিকভাবে কাজ করে সেটাও এই পাশে ঠিক করা হবে।

## Scope (কী পরিবর্তন হবে)

**Frontend only** — backend-এ `PATCH /admin/v1/users/:id` ইতিমধ্যেই `email_verified` accept করে (`admin.ts:513`, `live.ts:699`), তাই নতুন migration/endpoint লাগবে না।

## Changes

### 1. `src/routes/dashboard.users.tsx` — Approve/Verify workflow

- প্রতিটি **pending** row-এর পাশে একটি "Approve" button (green, checkmark icon)। Click → `live.admin.users.update(id, { email_verified: true })` → toast + refresh।
- Verified row-এর পাশে ছোট "Revoke" (unverify) link — শুধু super_admin দেখতে পাবে।
- **Bulk approve**: checkbox column + top toolbar-এ "Approve selected (N)" button।
- **Filter bar**: `All / Pending / Verified` tabs + email search box (client-side filter)।
- **Status pill** clearer: pending = amber with clock icon; verified = emerald with check + tooltip showing `email_confirmed_at`।
- সব mutation optimistic + error হলে rollback + inline `ErrorBanner`।
- Confirm dialog শুধু destructive action-এ (delete, revoke verification, super_admin promote/demote) — approve-এ নয় (friction কমাতে)।

### 2. Role management hardening

- Role dropdown disable হবে যদি:
  - target user নিজেই current signed-in user (self-demotion রোধ), অথবা
  - current user super_admin না হয়ে super_admin কে edit করছে।
- `super_admin` select করলে confirm dialog: "Grant full backend access to X?"।
- Non-super_admin admin শুধু `user ↔ admin` toggle করতে পারবে; super_admin select option তার UI-তেই hidden।
- Current actor-এর role/superadmin flag `useAuth()` থেকে পড়া হবে (already exposed via auth-context)।

### 3. Small UX / correctness fixes

- Toast notifications (`sonner`) — সব success/error-এ।
- Loading spinner per-row (busy state ইতিমধ্যে আছে, শুধু visible করা)।
- Empty states আলাদা: "No pending users" vs "No users yet"।
- Table responsive — mobile-এ role/verified column stack।
- `refresh()` কে `useCallback` করে dependency ঠিক রাখা; polling নয়।

### 4. Guard rails

- Frontend-এ super_admin action gate থাকলেও backend ইতিমধ্যেই `requireSuperadmin` enforce করে (`admin.ts`) — শুধু UI polish।
- একজন admin নিজেকে delete/demote করলে সাথে সাথে sign-out + redirect `/auth`।

## Out of scope

- Backend schema change nei.
- Email template বা confirmation flow-এ কোনো পরিবর্তন নেই — user-facing verification email আগের মতোই কাজ করবে; manual approve শুধু সেটার bypass।

## Files

- Edit: `src/routes/dashboard.users.tsx` (মূল কাজ)
- সম্ভবত edit: `src/components/pluto/PageHeader.tsx` (যদি action slot না থাকে — check করে decide)
- কোনো নতুন route/migration নেই।

## VPS-এ কী করতে হবে

**কিছুই না।** এটা pure frontend change — শুধু frontend redeploy হলেই feature live। Backend `email_verified` update আগে থেকেই deploy করা আছে (migration `0015_admin_user_mutations.sql`)।

Verify করতে (optional):
```bash
curl -s -X PATCH https://api.timescard.cloud/admin/v1/users/<uuid> \
  -H "Authorization: Bearer <super_admin_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"email_verified": true}'
```
`200` + updated row return করলেই দাশবোর্ডে Approve button কাজ করবে।
