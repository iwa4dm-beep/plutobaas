
# Homepage-কে "Real & Accurate" করার Plan

আপনার BaaS software-এর homepage (`src/routes/index.tsx`, ~1800 lines) এ এখন অনেকগুলো **placeholder / বানানো তথ্য** আছে যেগুলো real project data দিয়ে replace করতে হবে। শুধু frontend-এর কাজ — backend logic-এ হাত দিব না।

---

## যা যা এখন "ভুল / বানানো" আছে

### 1. Hero section
- **"Source" বাটন** → `href="https://github.com"` (fake, generic GitHub homepage)।
- **"Launch Admin Console"** → ঠিক আছে, `/dashboard` এ যায়।

### 2. SDK / Code showcase ("Two lines of setup")
- Code samples-এ `import { createClient } from "@pluto/client"` লেখা — কিন্তু **`@pluto/client` npm package টা এখনো publish হয়নি** (আপনার real package name আলাদা: `pluto-backend/packages/sdk-js`)।
- Anon key example: `import.meta.env.VITE_PLUTO_ANON_KEY` — কিন্তু real endpoint URL (`https://api.timescard.cloud`) কোথাও দেখানো নাই।
- "install" / setup step (npm/bun/yarn install command) কোথাও নেই — মানুষ কীভাবে connect করবে বুঝবে না।

### 3. Stats bar (বানানো সংখ্যা)
- `"8 canonical modules"`, `"60+ phases shipped"`, `"15+ endpoint smoke tests"`, `"4 official SDKs"` — এগুলো accurate কিনা repo থেকে verify করে সঠিক করব।

### 4. Deploy targets
- Docker Compose / Fly / Railway / Render / VPS — repo-তে configs আছে (`backend/deploy/`), কিন্তু এখানে "1-click" claim গুলো verify করা দরকার।

### 5. Pricing section (**সবচেয়ে risky**)
- `Self-Hosted Free` / `Cloud Starter $19` / `Business $99` — এই cloud tiers **আপনি actually offer করেন কি না** জানা নেই। ভুল দাম দেখালে legal/UX সমস্যা।

### 6. FAQ
- CORS, RLS, deploy, migration answers — content ঠিক আছে, শুধু link/domain references (`https://backend-joy.lovable.app`) real production domain হলে verify করব।

### 7. Footer + Header nav
- Product / Resources / Platform link গুলোর কিছু route valid, কিছু placeholder — সব verify করব।

---

## যা করব (frontend only)

1. **Hero "Source" বাটন** — real GitHub repo URL বসাব, না থাকলে বাটনটা সরিয়ে দেব।
2. **SDK section rewrite** — real install command + real API base URL + real SDK package name দিয়ে ৩টা tab (Auth / Data / Realtime) rewrite:
   ```bash
   # tab-এর উপরে দেখানো হবে
   bun add @your-scope/pluto-sdk
   # অথবা npm i @your-scope/pluto-sdk
   ```
   ```ts
   const pluto = createClient({
     url: "https://api.timescard.cloud",
     anonKey: "eyJhbGciOi...", // Dashboard → API keys থেকে
   });
   ```
3. **Stats bar** — repo scan করে actual numbers বসাব (modules, migrations count, SDK count, endpoints)।
4. **Deploy targets** — শুধু যেগুলো repo-তে সত্যিই config-file আছে সেগুলো রাখব।
5. **Pricing section** — আপনি cloud offer করলে real দাম, না করলে পুরো section সরিয়ে "Self-hosted" এবং "Contact for managed hosting" এই দুটো card রাখব।
6. **Footer + Header links** — শুধু existing route-এর link রাখব, dead link সরাব।
7. **Meta / OG tags** — production domain + description accurate করব।

---

## Deployment (frontend rebuild only)

```bash
cd ~/backend-joy && git pull
sudo APP_DIR=/root/backend-joy bash deploy-frontend.sh
```
Backend / API restart লাগবে না।

---

## Plan finalize করার আগে ৪টা তথ্য দরকার

আপনি answer দিলে সাথে সাথে implement শুরু করব:

1. **GitHub repo URL** — public কি? থাকলে exact URL দিন (যেমন `https://github.com/yourname/pluto-backend`)। না থাকলে "Source" বাটনটা সরিয়ে দেব।

2. **SDK npm package name** — `pluto-backend/packages/sdk-js` কি npm-এ publish করা আছে? থাকলে exact name (e.g. `@timescard/pluto-sdk`)। না থাকলে temporary local install instruction দেব।

3. **Real API base URL** — homepage-এর code sample-এ `https://api.timescard.cloud` বসাব, নাকি অন্য URL?

4. **Pricing section কী করব?**
   - (a) পুরো section সরিয়ে দিন — শুধু "Self-hosted / MIT free" রাখব
   - (b) real দাম দিয়ে রাখব (তাহলে দাম + quotas দিন)
   - (c) "Contact us" বানিয়ে দিব — কোনো hardcoded দাম থাকবে না

উত্তর দিলে আমি এই plan অনুযায়ী পুরো homepage `real` করে দিচ্ছি।
