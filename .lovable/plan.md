
# Plan — BaaS-as-SaaS: Marketing Brief + In-App Documentation Layer

দুইটা আলাদা কাজ, একসাথে ডেলিভার করব:

**Part A** — SaaS হিসেবে বাজারজাত করার একটা concrete go-to-market brief (কোথায়, কিভাবে, কাদের কাছে, কোন প্রাইসিং)।
**Part B** — অ্যাপের **প্রতিটা পেইজ, প্রতিটা সেকশন, প্রতিটা ফিচারের** পাশে বিস্তারিত bilingual (বাংলা + English) help/guide, যাতে ইউজার পড়েই বুঝে ফেলতে পারে "এই টুল কী করে, কিভাবে কাজ করে, কোন step-এ কী চাপতে হবে"। পরে ইচ্ছেমতো কমানো যাবে।

---

## Part A — Marketing / Go-to-Market Brief (ডকুমেন্ট আকারে)

`docs/GO-TO-MARKET.md` তৈরি করব — এটা আপনার নিজের reference, বাজারজাত করার সময় step-by-step follow করবেন।

সেকশনগুলো থাকবে:

1. **Positioning** — "Supabase-compatible, self-hostable BaaS for teams that want data sovereignty + predictable pricing" — এই লাইনে ৩টা variant।
2. **Target ICP (Ideal Customer Profile)** —
   - Indie developers & solo founders (Firebase/Supabase-এর alternative খুঁজছেন)
   - SMB agencies যারা client-এর জন্য backend host করেন
   - Regulated industries (health, finance, edu — data residency লাগে)
   - Bangladesh + South Asia SaaS builders (local hosting + BDT pricing)
3. **Pricing tiers** — Free / Pro ($29) / Team ($99) / Self-host (one-time + support) — feature matrix সহ।
4. **Launch channels** (priority order):
   - Product Hunt launch checklist
   - Hacker News "Show HN" post template
   - Reddit r/selfhosted, r/webdev, r/SaaS
   - Dev.to + Hashnode article series ("Migrating from Supabase to Pluto")
   - Twitter/X + LinkedIn founder-led content plan (৩০ দিনের calendar)
   - GitHub README + `awesome-selfhosted` PR
5. **Content marketing plan** — ১০টা blog post idea, প্রতিটার SEO keyword সহ।
6. **Landing page conversion checklist** — hero, social proof, comparison table (vs Supabase/Firebase/Appwrite), pricing, FAQ, CTA।
7. **First 100 users playbook** — cold outreach templates, community engagement rules, feedback loop।
8. **Metrics to track** — signups, activation (first API call), retention (D7/D30), MRR।
9. **Bangladesh-specific GTM** — bKash/Nagad payment, BDT pricing tier, local dev community outreach (BASIS, Facebook groups)।

সাথে homepage-এ একটা ছোট "For SaaS builders" section যোগ করব যা এই positioning-টা reflect করবে।

---

## Part B — In-App Help/Documentation Layer (প্রতিটা পেইজে)

লক্ষ্য: **কোনো পেইজ বাদ যাবে না**। প্রতিটা dashboard route, প্রতিটা section, প্রতিটা button-এর পাশে explanation।

### B1. Reusable primitives (একবার বানাব, সব জায়গায় use হবে)

- **`<HelpPanel>`** — পেইজের উপরে collapsible bilingual info card। props: `title`, `whatItDoes` (কী করে), `howToUse` (কিভাবে use করবেন — steps array), `whenToUse` (কখন), `troubleshooting` (optional)।
- **`<FeatureHint>`** — ছোট `(?)` icon যেটা hover/click করলে tooltip/popover-এ short bilingual explanation দেখাবে। প্রতিটা button/toggle/field-এর পাশে বসবে।
- **`<StepGuide>`** — numbered step list, expandable, per-step screenshot placeholder।
- **`<HelpDrawer>`** — right-side slide-in drawer, "Show full guide" button থেকে খুলবে, পুরো পেইজের deep documentation ধারণ করবে।
- **Global help toggle** — top navbar-এ একটা switch: "Beginner mode: ON/OFF"। ON থাকলে সব HelpPanel + FeatureHint দেখাবে; OFF করলে কেবল `(?)` icons থাকবে। User preference `localStorage`-এ save হবে। এটাই আপনার "পরে কমাব" mechanism — একটা toggle-এ সবাই একসাথে hide/show।

### B2. Content structure (প্রতিটা পেইজের জন্য)

প্রতিটা route-এর জন্য একটা content file বানাব: `src/content/help/<route-slug>.ts` — TypeScript object যাতে থাকবে:

```ts
{
  page: { titleBn, titleEn, whatItDoes: {bn, en}, whyItMatters: {bn, en} },
  sections: [
    {
      id, titleBn, titleEn,
      whatItDoes: {bn, en},
      howToUse: [{stepBn, stepEn}, ...],
      fields: [{name, purposeBn, purposeEn, exampleValue}],
      troubleshooting: [{problemBn, solutionBn}],
    }
  ],
  glossary: [{term, definitionBn, definitionEn}]
}
```

এভাবে content আর UI আলাদা থাকবে — পরে edit/translate/trim করা সহজ।

### B3. Coverage — প্রতিটা route ধরে ধরে

Dashboard routes (already exist) — প্রতিটার জন্য HelpPanel + section-level hints:

- `/dashboard` — overview, quick stats কী মানে
- `/dashboard/verify` — verify checks কেন লাগে, কোন check কী test করে
- `/dashboard/api` — API keys generate/rotate/revoke কিভাবে
- `/dashboard/cors` — CORS origin add কেন লাগে, কোন pattern valid
- `/dashboard/audit` + `/dashboard/audit-log` — কে কী করেছে দেখা
- `/dashboard/ai` — AI features setup
- `/dashboard/backups` — backup schedule + restore step-by-step
- `/dashboard/branching` — DB branching workflow
- `/dashboard/backend-status` — health signals কী মানে
- `/dashboard/database-import` — schema import steps
- `/dashboard/migrations` (+legacy `/dashboard/pluto-migrations`) — migration apply/rollback
- `/dashboard/sdk-demo`, `/dashboard/pluto-sdk`, `/dashboard/sdk-release` — SDK install/publish flow
- `/dashboard/admin/invite` — team invite + role explain
- সব বাকি dashboard.* route যেগুলো `src/routes/` scan করে বের করব

Public/docs routes:
- `/` (homepage) — feature card প্রতিটায় short "what/why"
- `/docs`, `/docs/sdk`, `/docs/auth` (আগের কাজে যা তৈরি হয়েছে) — বাংলা counterpart যোগ করব
- CORS/env checklist, OpenAPI, Quickstart pages — bilingual help block যোগ

### B4. Onboarding tour (bonus, low-effort)

First-time login-এ একটা optional 5-step tour: "এখানে API key তৈরি করুন → এখানে CORS যোগ করুন → এখানে SDK install করুন → এখানে data দেখুন → এখানে backup on করুন"। skip করা যাবে, "Show again" option settings-এ থাকবে।

### B5. Search

`Cmd+K` command palette (আগে থেকে আছে) — এটাতে help content-ও index করে দিব, যাতে user "backup" লিখলে backup page + related help section সব চলে আসে।

---

## Delivery order (ছোট ছোট batch-এ)

1. **Batch 1** — Primitives (`HelpPanel`, `FeatureHint`, `HelpDrawer`, global Beginner-mode toggle) + content schema + English/Bangla i18n helper।
2. **Batch 2** — `docs/GO-TO-MARKET.md` (Part A পুরোটা) + homepage "For SaaS builders" section।
3. **Batch 3** — Top 5 highest-traffic dashboard pages-এ content (dashboard home, verify, api, cors, sdk-demo)।
4. **Batch 4** — বাকি সব dashboard routes cover।
5. **Batch 5** — Public docs pages + onboarding tour + Cmd+K help search integration।

প্রতিটা batch আলাদা turn-এ deliver হবে, যাতে আপনি review করে feedback দিতে পারেন।

---

## Technical notes (for me, not user-facing)

- Content file structure keeps copy edit-friendly — non-devs can update `src/content/help/*.ts` without touching route components.
- HelpPanel visibility controlled by a single `useBeginnerMode()` hook backed by `localStorage`, so "trim later" = flip default to `false`.
- No new heavy deps — plain React + existing shadcn Popover/Sheet/Collapsible primitives.
- Bilingual: no i18n framework needed for v1; content object carries both `bn` + `en`, component picks based on a lightweight `useLocale()` (defaults to `bn` since target market includes BD).
- SEO-safe: HelpPanel content renders as normal DOM, indexable, not behind JS-only tooltips for the primary text.

---

Approve করলে **Batch 1 + Batch 2** দিয়ে শুরু করব (primitives + marketing brief), তারপর ধাপে ধাপে বাকি batch।
