# Pluto — Go-to-Market Playbook

> Internal reference for launching Pluto (BaaS) as a SaaS product. Written
> for a solo/small-team founder. Follow section-by-section; each step ends
> with a concrete deliverable.

---

## 1. Positioning

Pick one primary line and stick with it across landing page, ads, and
outreach. Three variants tuned to audience:

- **Developers (default)**: "Supabase-compatible BaaS you can self-host or
  run managed — Postgres, auth, storage, edge functions, and realtime in
  one predictable bill."
- **Agencies / consultants**: "Ship client backends in a weekend. Bring
  your own domain, our infra. Full data export, no lock-in."
- **Bangladesh / South Asia**: "Local BaaS with local pricing. Host in
  Dhaka or Singapore, pay in BDT via bKash — Firebase alternative built
  for our latency, our compliance, our budgets."

**Elevator pitch (30 seconds)** —
"Pluto is a Supabase-compatible backend-as-a-service. You get Postgres,
auth, storage, realtime, and edge functions with one SDK. You can run it
managed by us for $29/month or self-host on your own VPS in ~10 minutes.
Everything is open — no proprietary lock-in, full data export, and if you
outgrow us you keep your Postgres database."

## 2. Ideal Customer Profile (ICP)

Rank in this order — the top of the list converts fastest.

1. **Indie hackers & solo founders** shipping side projects. They already
   know Supabase / Firebase and complain about egress cost, cold starts,
   or vendor lock-in.
2. **Agencies (2–10 people)** building client sites. They want one backend
   they resell, with per-client isolation and a simple admin.
3. **Bangladesh / South Asia dev shops** who need local hosting, BDT
   invoicing, and Bangla support.
4. **Regulated verticals** (health, fintech, edu) needing data residency
   — self-host tier + signed BAA/DPA.

## 3. Pricing tiers

| Tier | Price | For | Includes |
|---|---|---|---|
| **Free** | $0 | Hobby / prototypes | 500MB Postgres, 1GB storage, 50k req/mo, community support |
| **Pro** | $29/mo | Solo founders | 8GB DB, 100GB storage, 2M req/mo, daily backups, custom domain, email support |
| **Team** | $99/mo | Small teams | 50GB DB, 500GB storage, 10M req/mo, PITR, 3 workspaces, priority support |
| **Self-host** | $199 one-time + $49/mo support (optional) | Everything above, on your infra | All features, Docker Compose, 12mo updates, private Slack |
| **Enterprise** | Custom | Regulated / 100k+ MAU | Dedicated infra, SSO, DPA/BAA, SLA, phone support |

**Bangladesh add-on** — same tiers priced in BDT (Pro ₹1,999/mo,
Team ₹6,999/mo) with bKash / Nagad payment via Paddle.

## 4. Launch channels (execute top-down)

### 4a. Pre-launch (week -2 to 0)
- [ ] Landing page live at `backend-joy.lovable.app` (or custom domain).
- [ ] Waitlist form + Twitter/X + LinkedIn accounts created.
- [ ] 5 short demo videos (60s each): quickstart, auth, storage, realtime,
      self-host.
- [ ] `README.md` polished, GIF demo, one-line install.
- [ ] Analytics wired (Plausible / Umami / PostHog).

### 4b. Product Hunt launch
- [ ] Schedule for a Tuesday or Wednesday, 12:01 AM PST.
- [ ] Assets ready: gallery images (1270×760), tagline (60 char), maker
      comment (150 words), 2-min video.
- [ ] Line up 20 hunters/supporters in advance (DM them the day before).
- [ ] Reply to every comment in first 4 hours.
- [ ] Deliverable: aim for top 5 of the day.

### 4c. Hacker News
Template for "Show HN":
```
Show HN: Pluto — Supabase-compatible BaaS you can self-host

Hi HN — I built Pluto because I wanted Supabase's DX without the egress
bill and the vendor lock-in. It runs the same client SDK surface, so
`createClient()` code from Supabase migrates in one line.

- Postgres 16 + PostgREST-compatible REST
- Auth (email, magic link, OAuth) — issues real JWTs
- Storage (S3-compatible), Realtime, Edge Functions
- Deploy in 10min on a $6 VPS, or use our managed tier

Would love feedback on the SDK API and the self-host flow.

Demo: <url>   Repo: <url>
```

### 4d. Communities
- Reddit: r/selfhosted (self-host angle), r/webdev, r/SaaS, r/nextjs
- Dev.to: 3-part series "Migrating from Supabase to Pluto"
- Hashnode: same content, cross-post
- Discord/Slack: Supabase Discord (be respectful), Indie Hackers
- GitHub: PR to `awesome-selfhosted` and `awesome-baas`

### 4e. Twitter/X + LinkedIn — 30-day founder-led content calendar

| Day | Topic |
|---|---|
| 1  | Launch announcement + demo GIF |
| 3  | "Why I built Pluto" thread |
| 5  | Feature: auth in 3 lines of code |
| 7  | Case study: your own dogfooded app |
| 10 | Comparison table (Pluto vs Supabase vs Firebase) |
| 14 | Behind-the-scenes: self-host deploy speedrun |
| 17 | "Migrating a real Supabase project" screencast |
| 21 | Community shoutout — first paying customers |
| 24 | Roadmap update |
| 28 | Ask: what should we build next? |
| 30 | Month-1 metrics: users, MRR, lessons |

## 5. Content marketing — 10 SEO posts

Each targets a real query devs search for:

1. "Supabase alternative self hosted" → head-to-head + migration guide
2. "Firebase vs Postgres" → why Postgres wins for most apps
3. "Cheapest way to host Postgres for a startup"
4. "Row-level security tutorial" → RLS explained with Pluto examples
5. "Realtime Postgres changes with WebSockets"
6. "How to add auth to a React app in 10 lines"
7. "Deploy Supabase-compatible backend on Hetzner"
8. "S3-compatible storage for developers"
9. "Edge functions vs serverless — 2026 comparison"
10. "Data sovereignty for SaaS: hosting in Bangladesh"

## 6. Landing page conversion checklist

- [ ] Above-fold: headline (positioning), sub-line, primary CTA (Start
      free), secondary (View demo), 30s hero video/GIF.
- [ ] Social proof: logos of early users (even 3–5 helps), GitHub stars.
- [ ] Comparison table: Pluto vs Supabase vs Firebase vs Appwrite.
- [ ] Feature grid with icons: Auth, DB, Storage, Realtime, Functions,
      Vector.
- [ ] Code showcase (already live) — copy-paste `createClient` snippet.
- [ ] Pricing table with "Most popular" highlight on Pro.
- [ ] Self-host CTA block — one command, GIF of terminal.
- [ ] FAQ (10 questions minimum, schema.org JSON-LD for SEO).
- [ ] Footer: docs, GitHub, status page, X/LinkedIn, contact.

## 7. First 100 users playbook

- **Days 1–7** — Onboard 20 hand-picked users. Personal onboarding call
  with each. Add every friction to a followup list.
- **Days 8–30** — Ship one improvement per week from the friction list.
  Post the changelog publicly. Ask users to tweet if they enjoyed it.
- **Days 30–90** — Launch on Product Hunt + HN. Aim for 500 signups.
  Convert 10% to Pro trial.
- **Cold outreach template**:
  > Hi <name>, saw your <project> on <platform>. You mentioned
  > <specific frustration> with <supabase/firebase>. I built Pluto to
  > fix exactly that — <one sentence>. Would love your take, no pitch.
  > Here's a demo: <url>

## 8. Metrics to track

Weekly dashboard (Plausible / PostHog + a manual sheet):

- Landing page: uniques, signup conversion rate.
- Signups: total, activated (first API call within 24h), still active
  after 7 days (D7), after 30 days (D30).
- Revenue: MRR, ARR, paid customers, churn rate, LTV.
- Product: API requests/day, DB size trends, error rate.
- Support: median response time, open tickets.

North-star metric: **weekly active projects** (a project that made ≥1
API call in the past 7 days).

## 9. Bangladesh-specific GTM

- **Payments**: Paddle + Stripe both accept BDT via card; add bKash /
  Nagad via a local aggregator (SSLCommerz, ShurjoPay) for domestic
  buyers. Show BDT prices with a language toggle on the pricing page.
- **Hosting**: offer a "Dhaka region" option on Pro/Team (rent a VPS at
  BDIX-connected DC — DataHub / IIG). Sell latency: "Backend in Dhaka
  means <10ms to users in Dhaka".
- **Community**: post in BASIS forums, Bangladesh Developer Initiative
  Facebook group, DevRel Meetup Dhaka. Sponsor one meetup.
- **Documentation**: bilingual (Bangla + English). The in-app help layer
  already ships with both.
- **Support**: WhatsApp/Messenger support channel — expected in BD.

## 10. Sequence — first 90 days

| Week | Focus | Output |
|---|---|---|
| 1 | Landing + waitlist | Live page, 200 signups |
| 2 | Onboarding polish | Every signup gets welcome email + first-project script |
| 3 | Content batch 1 | 3 blog posts published |
| 4 | Product Hunt prep | Assets, hunters lined up |
| 5 | **Product Hunt launch** | Top 5 of the day |
| 6 | HN launch + community | 500 GitHub stars, 100 self-hosters |
| 7 | Case study interview | Written up + on landing page |
| 8 | Pricing test | Turn on paid tiers, first 10 Pro customers |
| 9-12 | Iterate | Weekly metrics review, ship 1 feature/week |

---

## Notes

- Everything above is a starting point — measure, iterate, kill what
  doesn't work.
- Don't ship the pricing page until 20+ users have used the free tier
  and given feedback. Pricing without signal is theater.
- Self-hosting is the moat. Every time someone says "I don't want
  another lock-in", the answer is "one command, your VPS, your data".
