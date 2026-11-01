# pettycourt: launch-ready

Group Chat Court is ready for a public launch, and it still does exactly what M1–M5 built. This pass added search and sharing tags, launch updates to the legal pages, a Buy button for a Stripe Payment Link, and RepoHQ's launch counts. `npm test` passes: 546 tests, the 513 from M1–M5 plus 33 new in `test/launch.test.js`.

The app is Hono on Node, not Next.js (BUILD.md, M1 decisions), so "the framework's own conventions" means plain Hono routes and the existing server-rendered views, with no new dependencies.

## What was done

1. **Search and sharing** (`src/seo.js`, `src/views.js`, `src/app.js`)
   - The public pages are `/`, `/terms` and `/privacy`. Each one has:
     - its own `<title>` and meta description
     - a canonical URL
     - Open Graph tags (`og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image` with width, height and alt)
     - Twitter `summary_large_image` tags
     - JSON-LD: a `SoftwareApplication` with an `Offer` of `3.00` `USD`, "one appeal for one case, paid once"
   - The JSON-LD is the one `raw()` in the views. It holds no user text, and `<` is escaped, so nothing can close the `<script>`.
   - `/og.png` is the 1200×630 share image. It is drawn with code by the satori and resvg renderer the verdict card already uses, with the same paper, ink and Lora font. It is rendered on the first request, kept in memory and cached for a day. Nothing was copied from the web.
   - `/robots.txt` allows crawling, skips `/cron/` and points at `/sitemap.xml`. The sitemap lists the three public pages by their canonical URLs.
   - Every page reached through a case's links (case, summons, jury, plaintiff, appeal), plus "deleted" and "not found", keeps `<meta name="robots" content="noindex">` and stays out of the sitemap. A case is shared by its links and listed nowhere.
   - The case page keeps its own `og:image`, the verdict card.
2. **Privacy and terms** (`src/views.js`), both linked from every page's footer, which now also has a **Contact** link to the repo's GitHub issues.
   - **Privacy** adds three things:
     - A **Cookies** section. There is one cookie, `pc_device`, sent only to jury links, so that each device votes once.
     - A **Launch counts** section. It names `visit`, `activate` and `checkout`, the counter's address, and what a count holds: only the slug, the kind and an outside referrer. It also gives the opt-out.
     - RepoHQ listed among the processors, and GitHub issues as the contact.
   - **Terms** adds three things:
     - The price line: "$3.00 (USD), once", no subscription, with filing, the jury and the ruling free.
     - The refund line from M4: on request within 14 days, for any reason. REVENUE.md has no refund line of its own, so the existing one stands.
     - A **No warranty** section, and GitHub issues as the contact.
   - Refunds without an email address go through a public issue, quoting the receipt number from Stripe's email. The pages tell the payer not to post the appeal link there, because that link is the payer's credential.
3. **Payment: the Buy button** (`STRIPE_PAYMENT_LINK`, or `NEXT_PUBLIC_STRIPE_PAYMENT_LINK`, read on the server; never hard-coded)
   - When the variable holds an https URL and M4's Stripe Checkout isn't configured, a ruled case shows **"Buy the appeal · $3"**.
   - Pressing it records the click (the M5 "clicked" metric). The server then answers with the Payment Link plus `?client_reference_id=<click id>`, and the browser goes there.
   - Without the variable there is no Buy button. The case page keeps M3's fake door ("Unlock the full trial · $3", which says nothing was charged), and `POST /cases/:id/checkout` answers 503.
   - If `STRIPE_SECRET_KEY` and `CONTACT_EMAIL` are both set, M4's Checkout flow wins. Its "Appeal the verdict · $3" button is a Buy button too and counts as `checkout`.
4. **RepoHQ's launch counts** (`clientScript()` in `src/views.js`): fire-and-forget `POST` to `https://idea-factory.1426davejobs.workers.dev/api/ideas/signal` with `{"slug":"pettycourt","kind":…,"referrer":…}`.
   - **The three events:**
     - `visit` is sent from every page, once per browser session (`sessionStorage` `repohq:visit`).
     - `activate` is sent the first time a browser uses the core action, **filing a case** (`POST /cases` answered 201). It is sent once per browser (`localStorage` `repohq:activated`).
     - `checkout` is sent on every press of a Buy button.
   - **Referrer:** `document.referrer` only when its origin differs from `location.origin`, else `null`.
   - **Delivery:** the request is sent with `keepalive`, `credentials: "omit"` and `referrerPolicy: "no-referrer"`. A case link never reaches the counter, either in the body or as a `Referer`.
   - **When nothing is sent:** when `navigator.webdriver` is true, when `localStorage` `repohq:notrack` is set, when the browser has no usable storage, or on anything but production.
   - **Production is decided by the server:** `NEXT_PUBLIC_DEPLOY_ENV`, else `NEXT_PUBLIC_VERCEL_ENV`, else `VERCEL_ENV`, must equal `production`. The server bakes the flag into `/app.js`.
   - **On Render:** `render.yaml` sets `NEXT_PUBLIC_DEPLOY_ENV=production` (not a secret), so the commercial-use host counts too.
   - **CSP:** the content security policy's `connect-src` allows the counter's origin only when the counts are on.
5. **`.provision`** holds the two lines asked for: `vercel project pettycourt` and the Stripe Payment Link request.
6. **Tests** (`test/launch.test.js`, 33 tests):
   - the public pages' tags, unique titles and descriptions, the JSON-LD, and a hostile `Host` header
   - `noindex` on everything else
   - robots.txt, sitemap.xml, and the PNG's 1200×630 size
   - the legal pages
   - the Buy button hidden without the variable and shown after the ruling with it, the click and redirect, the manual-confirmation SQL below opening the appeal, and Checkout winning when both are set
   - no payment link or key in `src/`
   - the env parsing and the CSP
   - the real client script in the fake DOM: once per session or browser, the referrer rule, webdriver, notrack, no storage, non-production, and the fake door not counting as `checkout`

   Existing tests changed:
   - `test/serve.test.js` now allows exactly one `value:` in `render.yaml`: that production marker.
   - One title in `test/legal.test.js` was reworded, because the page now always has a contact.
   - `test/dom.js` and `test/helpers.js` gained optional settings, and behave as before without them.
7. **Screenshots**:
   - `npm run screenshots` now captures the start page, the summons and the verdict, at 1280×800 and on an iPhone 13.
   - It runs with a placeholder `STRIPE_PAYMENT_LINK=https://example.com/pay`.
   - It fails if the Buy button or the footer links aren't in view.
   - The README's Screenshots section shows the six new PNGs.

## Decisions made without asking

- **Public pages, and why robots.txt doesn't block case pages.** Case pages say `noindex` themselves. Blocking them in robots.txt would stop link-preview bots that honour it, such as X's, from fetching the verdict card.
- **Canonical origin.** `PUBLIC_URL` comes first, then Render's `RENDER_EXTERNAL_URL`, then Vercel's `VERCEL_PROJECT_PRODUCTION_URL`, then the request's own origin. A preview deployment therefore names production as canonical. The links the app hands out (summons, jury) still use the host they were made on, as before.
- **Where the Buy button sits.** It appears after the ruling, the gate M4 already had. REVENUE.md suggests waiting for a defendant answer and 2+ jury votes. That would change what the product does, so it wasn't adopted. It is a one-line change in `unlockSection` if David wants it.
- **The fake door stays when no payment is configured.** It feeds the M5 "unlock clicks" metric and says honestly that nothing was charged. It isn't a Buy button: it has no payment link and sends no `checkout` count.
- **Payment Link purchases are confirmed by hand.** A Payment Link needs no secret key, so the app can't ask Stripe whether a session was paid. REVENUE.md says to "use a manual check for the first few sales". The pages promise the appeal link by email within 2 days (`MANUAL_CONFIRM_DAYS` in `src/views.js`). The appeal page, the appeal and the M5 numbers then work unchanged.
- **The core action for `activate` is filing a case.** It starts every trial. The defendant answering and jury votes aren't counted as activations.
- **How the counts are sent.** They go as a CORS-safelisted `text/plain` body holding the JSON (`mode: "no-cors"`), so no preflight is needed. Browsers can't always preflight `keepalive` requests, and the page never reads the answer.
  - If the counter turns out to insist on `Content-Type: application/json`, change the `headers` and `mode` lines in `sendSignal` in `src/views.js`.
  - The counter's CORS rules couldn't be checked from here.
- **`VERCEL_ENV` is the last fallback.** Vercel sets `NEXT_PUBLIC_VERCEL_ENV` for Next.js projects, not for a Hono function. `VERCEL_ENV` carries the same value at runtime.
- **Contact is GitHub issues, plus `CONTACT_EMAIL` when it's set.** Issues are public, so the pages say not to post case links, appeal links or personal details there.
- **The M5 decision report is no longer screenshotted.** The screenshots now show the product doing its job. `npm run decide` still prints the report.

## How to check it

```
npm test                                   # 546 tests, no network or keys
CHROMIUM_PATH=/path/to/chromium npm run screenshots   # the six PNGs in docs/screenshots/
npm run dev                                # then, in another shell:
curl -s localhost:3000/robots.txt
curl -s localhost:3000/sitemap.xml
curl -s localhost:3000/ | head -30         # the <head>: description, canonical, og:*, twitter:*, JSON-LD
curl -so /tmp/og.png localhost:3000/og.png # open it: 1200×630
STRIPE_PAYMENT_LINK=https://example.com/pay npm run dev   # file, answer and rule a case: "Buy the appeal · $3"
```

After the deploy:
- **Previews:** paste `https://<host>/` into opengraph.xyz, X's composer or LinkedIn's Post Inspector to see the card. Run Google's Rich Results Test on `/` for the JSON-LD.
- **The share image:** `/og.png` must render. It needs the same files as the verdict card (fonts and wasm). If it gives 500 and the logs mention `index_bg.wasm` or `.woff2`, see the card's file-tracing note in BUILD.md.
- **The counts:** on the production URL, open DevTools → Network. There should be one `POST …/api/ideas/signal` per tab session. A preview deployment and `npm run dev` should send none.
- **Your own browser:** run `localStorage.setItem("repohq:notrack", "1")` on the production site so your own browser doesn't count.

## What's left for David

1. **Create the Stripe Payment Link and paste it into Vercel.** The pipeline runs `.provision`'s `request` line, but the link itself is yours to make.
   - In Stripe, go to Payment links → New. Set it up as:
     - product "Group Chat Court: one appeal", $3.00 USD, one-time, quantity fixed at 1
     - after payment, "Show confirmation page" with a message like "Thanks! We'll email the link to file your appeal within 2 days."
   - Turn on Settings → Customer emails → Successful payments.
   - Paste the link's URL into the Vercel project env as **`STRIPE_PAYMENT_LINK`** (Production), then redeploy. On Render, set the same variable in the dashboard.
2. **Confirm each payment by hand within 2 days.** In Stripe, the payment shows a `client_reference_id`, which is the click id, and a `cs_live_…` session id. Run this with `psql "$DATABASE_URL"` (the URL comes from the keychain):

   ```sql
   WITH paid AS (
     UPDATE unlock_clicks SET paid_at = now(), checkout_session_id = '<cs_live_… session id>'
     WHERE id = '<client_reference_id>' AND paid_at IS NULL
     RETURNING case_id
   )
   UPDATE cases SET paid_at = now() FROM paid WHERE cases.id = paid.case_id AND cases.paid_at IS NULL
   RETURNING cases.id;
   ```

   - **One row back:** email the payer, at the address Stripe shows, `https://<host>/appeals/<client_reference_id>`.
   - **No row back:** one of three things happened.
     - You already ran it for this payment. Check `SELECT paid_at FROM unlock_clicks WHERE id = '<client_reference_id>'`.
     - Someone else had already paid for that case.
     - The case is gone.

     In the last two cases, refund the payment in Stripe and don't send an appeal link. BUILD.md's refunds-owed query lists the rest.
3. **Decide where the money is taken.** Vercel Hobby bars commercial use, and REVENUE.md says to move before a payment link is live. The options:
   - Render's free web service: `render.yaml` is ready and already carries `STRIPE_PAYMENT_LINK` and the production marker.
   - A paid Vercel plan.
4. **Make sure the GitHub repo is public.** The footer's Contact link and the legal pages point at `github.com/smithdavedesign/pettycourt/issues`. If the repo is private, visitors can't reach it.
5. **Delete the four superseded screenshots.** The sandbox didn't allow deleting files, so they're still on disk and no longer referenced: `git rm docs/screenshots/file-a-case-desktop.png docs/screenshots/file-a-case-mobile.png docs/screenshots/decision-desktop.png docs/screenshots/decision-mobile.png`
6. **Optional:**
   - A custom domain costs money, so it wasn't set up. Vercel's `VERCEL_PROJECT_PRODUCTION_URL` picks one up as the canonical host automatically. On Render, set `PUBLIC_URL`.
   - Submit `https://<host>/sitemap.xml` in Google Search Console.
7. **Everything under "What's left" in BUILD.md still stands:** the 30-case run, the safety review, the decision and a rate limit.

## Self-review (gstack pre-landing checklist)

I reviewed `git diff` against "Review Categories" and applied the "Fix-First Heuristic". No CRITICAL finding remains open.

- **SQL and data safety:** no SQL was added to `src/`. The operator's confirmation SQL is one atomic statement guarded by `paid_at IS NULL`, so a second payer can't double-mark a case. A test runs it.
- **Race conditions:**
  - The Buy click reuses M4's atomic `INSERT … SELECT`, so it only records against a ruled, unpaid, unappealed, open case.
  - Two payers on one case is the same refund case M4 already documents.
- **XSS:** every new value goes through Hono's `html` escaping, except the JSON-LD. That `raw()` escapes `<` and is tested with a hostile origin. The client script writes nothing into the DOM.
- **Credential leaks (fixed while building):**
  - The counter could have received capability URLs (jury, summons and plaintiff tokens) as `Referer`. It sends `referrerPolicy: "no-referrer"`, and the site already sends `Referrer-Policy: no-referrer`.
  - A public refund issue could have exposed an appeal link. The pages ask for the receipt number instead.
- **CSP (fixed while building):** without a `connect-src` entry, the counts would have been blocked in production. The origin is now added only when the counts are on.
- **Enum completeness:**
  - The new payment mode `link` is handled by everything that reads the mode: the case page's full-trial section, the checkout route, the terms, the privacy page, the appeal page and the startup log.
  - `paymentsKind: 'link'` is handled in `dev.js` and `serve.js`.
  - The three count kinds are each named on the privacy page.
- **LLM output and shell:** both are unchanged. The screenshot script spawns with argument arrays.
- **Informational, left as is:**
  - `dev.js` doesn't print the "key but no CONTACT_EMAIL" warning when a Payment Link is also set, because the link works without a contact email.
  - `/og.png` costs about 0.5 s of CPU on a cold instance's first request.
