# pettycourt — BUILD

## Plan

### Milestone 5 of 5: Decide

M1–M4 are built and their 448 tests keep passing. The roadmap's M5 is "Run 30 real cases from friend groups. Apply the PRD thresholds. If defendant response is under 40% or paid conversion is under 2%, fold the flow into tiebreak as a mode and stop."

The 30 real cases can't happen inside a build. What the build can do is make the decision mechanical and trustworthy, so that once the cases are in, one command gives the answer. This plan applies gstack's Step 0: Scope Challenge, 1. Architecture review and 3. Test review to that. The build is non-interactive, so each question is answered here and the answer is final.

There is no REVENUE.md. Charging was built in M4 (Checkout, terms, privacy, refunds), and M5 adds nothing to it.

**M5 exit criteria.** The roadmap gives none, so these are derived from its one line and from the PRD's success metrics and REVIEW.md's kill criteria. Each one becomes tests:
1. **Every PRD threshold is applied** to the recorded cases. Each comes with its value, its bar and pass/fail:
   - the defendant answered the summons: ≥ 40% of cases
   - 2 or more jury votes: ≥ 25%
   - new visitors per case beyond the plaintiff: ≥ 1.0 on average
   - clicked the $3 unlock: ≥ 5%
   - paid $3: ≥ 2% and at least 1 case
   - no published ruling names an outsider or an excluded topic, checked on every ruling until 100 are reviewed
2. **No decision under 30 cases:** the report says how many more are needed.
3. **The fold rule:** with 30 or more cases, any kill criterion failing gives "fold into tiebreak as a mode and stop":
   - defendant response under 40% or paid under 2% (the roadmap's rule)
   - under 25% with 2+ jury votes, or no paying case (REVIEW.md's kill criteria)
   - all kill criteria passing with a clean safety review gives "continue"
   - the bars are inclusive: 12 of 30 answered is exactly 40% and passes
4. **The numbers outlive the cases.** A party's delete and the 30-day expiry don't change the report, and what's kept holds no case text, token, link or id. M3's "nothing is left" guarantee still holds for every case table.
5. **Visitors are real people:**
   - each browser that opens a case's page, summons link or jury link counts once for that case
   - the plaintiff's own browser doesn't count
   - link-preview fetches (no script) don't count, and neither does a browser that can't remember what it has seen
6. **The safety review:**
   - every ruling, including an appeal ruling, waits in a review queue until it's reviewed
   - marking one a violation takes the case down and turns the safety bar red
   - an unreviewed ruling keeps the decision from saying "continue"
7. **The operator can run it:** `npm run decide` prints the report and the decision from `DATABASE_URL` (or the local PGlite data), and `review`, `ok` and `violation` work from the command line.

#### Step 0: Scope Challenge

1. **What existing code already solves part of this?**
   - **Most numbers are already stored**, as long as the case exists:
     - `defendant_testimony` (the answer)
     - `votes` (jury turnout)
     - `unlock_clicks` (fake-door clicks and checkout attempts, M3/M4)
     - `cases.paid_at` (M4)
     - `ruled_at` and `appeal_ruled_at` (what needs a safety review)
     - M4's funnel query under "Run it locally" computes half the PRD metrics by hand
   - **What's missing is a measurement, not a feature:**
     - **Expiry and deletion erase the evidence.** The case, its votes and its clicks go together after 30 days, or at once when a party deletes it. A 30-case run that takes more than a month, or a defendant who answers and then deletes the case, silently changes the denominators. M4's "What's left" already says "nothing outlives the 30-day window".
     - **Visitors aren't measured at all.** There's no record of who opened a link.
     - **The ruling sample has nowhere to live,** and the rulings themselves expire.
   - **Reuse:**
     - the delete and expiry statements (one `DELETE … RETURNING` each) gain one CTE that keeps the outcome in the same statement
     - `reportCase` is the takedown for a ruling that fails review
     - `createDeps` gives the command line the same database as the app (Neon, or local PGlite)
     - the client script's existing load gets the visit beacon
     - the fake DOM tests the beacon
2. **Minimum set of changes:**
   - **Keep each case's outcome when it goes.** It's one row in a new `case_outcomes` table, written by the same statement that deletes the case (party delete or expiry):
     - the filing day
     - answered, ruled, taken down, clicked and paid (yes/no)
     - the number of votes and visitors
     - the review result, and whether a ruling was still unreviewed
     - how it went: deleted or expired
     - nothing that links it back: no id, token, text or exact time
   - **Count visitors without cookies or a new table:**
     - `cases.visitors` is a counter
     - `POST /visits { caseId }` adds one, capped
     - the client script sends it once per case per browser, remembering seen cases in `localStorage` (`pc_seen`)
     - the browser that filed the case, and any browser that opens the plaintiff link, is remembered as the plaintiff and never counted
     - link-preview bots run no script, so they never count
   - **The safety review:**
     - two columns on `cases`: `review` (`ok`, `names_someone` or `serious`) and `reviewed_rulings` (how many of the case's rulings it covered, 1 or 2, so an appeal ruling after the review is queued again; a count, because comparing timestamps would trust clocks)
     - three commands: `review` lists what's waiting, `ok` approves, and `violation` takes the case down (a report row with the reason) and records it
   - **The decision:** `src/decide.js` is pure. It holds the thresholds with their sources, applies the rule, and writes the report text.
     - `scripts/decide.js` is the command line, `npm run decide`
     - `--since <day>` leaves out the operator's own deploy checks, and `--json` gives machine-readable output
   - **Privacy page:** it now says what the visit count and the outcome rows keep.
   - **Deliberately not in M5:**
     - **No admin web page.** A page with the review queue would need a new secret, a login and a new attack surface on a public app. The operator already has `DATABASE_URL` in the keychain (M3/M4 used `psql`), so a command line reaches the same data with no new credential.
     - **No visitor cookie and no per-visitor rows.** A server-side "seen" table would add a table, a cookie and personal data (per-case device hashes) to dedupe a number. `localStorage` dedupes on the device itself, and the server keeps only a count.
     - **No IP or user-agent bot filtering.** The script-only beacon already excludes link previews, the bulk of the noise.
     - **No dashboards, charts or cohorts by week.** One cohort with an optional start day is what the decision needs.
     - **No automatic folding into tiebreak.** The tiebreak repo isn't reachable from here (see M1's decision). The report says what to do; doing it is a human step.
     - **No rate limit,** still open from M1–M4. The visit counter is capped per case instead.
     - **No "first 100 by filing order" bookkeeping.** The review covers every ruling until 100 are reviewed, which is the same bar without ranking cases that no longer exist.
3. **Complexity check:**
   - Source files:
     - `src/store.js` (schema, outcome CTE, visits, review, totals)
     - `src/app.js` (one route)
     - `src/views.js` (the beacon, page attributes, privacy text)
     - new `src/decide.js` and `scripts/decide.js`
     - `package.json` (two scripts)
   - That's 6 files, under the 8-file smell. The screenshot script, README and this file are documentation the task asks for.
   - New services or classes: none. `decide` is two pure functions and a command-line `run()`.
   - New schema: one table with no foreign key (it must outlive cases), and three nullable or defaulted columns on `cases`.
   - **Two M2/M3 schema tests change on purpose.** `config.test.js` pins the exact list of tables after the schema script runs on an M2 or an M3 database. The list gains `case_outcomes` and stays exact. Nothing else from M1–M4 is edited or removed.
4. **Search check** (WebSearch wasn't used; proceeding with in-distribution knowledge, checked against PGlite in `.scratch/cte-check.mjs`):
   - **[Layer 1] Snapshot before cascade.** Postgres runs every sub-statement of a `WITH` on one snapshot, and `ON DELETE CASCADE` runs as an after-statement trigger. So `WITH gone AS (DELETE … RETURNING *) INSERT … SELECT (SELECT count(*) FROM votes …) FROM gone` still counts the votes the cascade is about to delete. That's one atomic statement, with no trigger and no read-then-delete. It was checked on PGlite: 3 child rows counted, then cascaded away.
   - **[Layer 1] `localStorage` + `fetch(…, { keepalive: true })`** are the platform's own "count once, survive navigation" pair. `navigator.sendBeacon` sends a string as `text/plain`, which the app's JSON-only rule (CSRF) refuses. `fetch` with `keepalive` sends real JSON and survives a quick navigation the same way.
   - **[Layer 1] `node:util` `parseArgs`** parses the command line, so no CLI library.
   - **[EUREKA, small] Count humans by script, not by request.** Every chat app fetches the case link for its preview, often more than once per share. Counting GETs would give each case several "visitors" before anyone clicks, and the PRD's ≥ 1.0 bar would pass on bots alone. Counting from the page's own script turns the noisiest part of the metric into nothing.
   - **Footgun: terminal escapes.** The review queue prints user and model text in the operator's terminal, so control and bidi characters are stripped before printing (tested).
5. **TODOS cross-reference:** there is no TODOS.md.
   - M4's "What's left" item "read the numbers before cases expire" is solved here by the outcome rows.
   - The rate limit stays open. The visit counter is capped at 100 per case.
   - New TODO: the actual 30-case run, and the decision taken on its report (What's left).
6. **Completeness check:** each path is built in full:
   - **Thresholds:** every metric at, just under and just over its bar, zero cases, the minimum paying count and the visitor average.
   - **Decision:** each of `collecting`, `fold`, `hold` and `continue`, the reasons listed in each, and the provisional note while cases are still live.
   - **Outcomes:** party delete (plaintiff or defendant), expiry in batches, a delete racing the expiry (one outcome row), and every state (fresh, answered, ruled, declined, taken down, paid, appealed). Deletion still leaves no row in any case table.
   - **Visits:** counted, capped, unknown case 404, bad body 400 or 415. In the browser: beacon once, then never again; never for the plaintiff (filing or plaintiff link); none without storage; none from pages without content.
   - **Review:**
     - the queue: order, `--since`, taken-down cases still listed, reviewed ones gone, an appeal ruling re-queued
     - `ok`: a stale `ok` refused when an appeal ruling appeared after the listing
     - `violation`: takes the case down with a report row
     - no such case, or not ruled yet
     - missed (deleted before review), and 100 reviewed completing the sample
   - **Command line:** every command, usage errors with exit code 2, `--json`, and stripped control characters. A real `node scripts/decide.js` run against in-memory PGlite.
7. **Distribution check:** no new artifact. `npm run decide` runs from the repo on the operator's machine, against the same `DATABASE_URL` the broker stored. No deploy change: the visit route is part of the same app on Vercel and Render.

#### 1. Architecture review

```
 browser opens /cases/:id · /summons/:t · /jury/:t   (page carries <main data-visit="<caseId>">)
     app.js: seen = localStorage.pc_seen; if caseId not in seen: remember it, then
             fetch POST /visits { caseId } (keepalive)          — no storage → remember fails → nothing sent
     /plaintiff/:t carries data-visitor="plaintiff": remember only; filing (POST /cases → 201) remembers too
     link-preview bots: no script → nothing
 POST /visits → UPDATE cases SET visitors = LEAST(visitors + 1, 100) WHERE id = $1 RETURNING id  → 204 | 404

 party DELETE /cases/:id  ─┐   WITH gone AS (DELETE FROM cases … RETURNING *),
 expiry /cron/expire       ─┴─▶     kept AS (INSERT INTO case_outcomes SELECT <outcome of gone> FROM gone)
                                    SELECT id FROM gone          — one statement, one snapshot, then the cascade

 operator: npm run decide [--since day] [--json]
     store.outcomeTotals(): <outcome of each live case>  UNION ALL  case_outcomes   (same column list)
     decide(totals) → status collecting | fold | hold | continue, each metric vs its bar, safety, advice
 operator: npm run decide -- review | ok <caseId> [--with-appeal] | violation <caseId> <names_someone|serious>
     review: rulings not yet reviewed (or with a newer appeal ruling), oldest first, control characters stripped
     ok: UPDATE … SET review='ok', reviewed_rulings = <1, or 2 with the appeal ruling>
            WHERE ruled AND (appeal_ruled_at IS NOT NULL) = <--with-appeal>      (no approving unseen text)
     violation: takedown + report row (like reportCase, but only for a ruled case), then the same UPDATE
```

One outcome expression (`OUTCOME` in `src/store.js`) defines every per-case number. It's used for live cases and, inside the delete statements, for the row that's kept, so the live and kept numbers can't drift apart.

Data:
```
cases          + visitors            integer NOT NULL DEFAULT 0   (capped at 100)
               + review              text CHECK (ok | names_someone | serious)
               + reviewed_rulings    smallint      (how many rulings the review covered: 1, or 2 with the appeal)
case_outcomes  id identity · filed_on date · gone_by (deleted | expired) · answered · ruled · taken_down
               · clicked · paid (booleans) · votes · visitors (integers) · review · review_pending
               — no foreign key, no text, no id, no token, no timestamp finer than a day
```

The decision, with each bar's source:

| Metric | Bar | If it fails | Source |
|---|---|---|---|
| Defendant answered the summons | ≥ 40% of cases | fold | PRD, ROADMAP M5, REVIEW kill criteria |
| 2 or more jury votes | ≥ 25% | fold | PRD, REVIEW kill criteria |
| New visitors per case beyond the plaintiff | ≥ 1.0 | watch | PRD |
| Clicked the $3 unlock | ≥ 5% | watch | PRD |
| Paid $3 | ≥ 2% and ≥ 1 case | fold | PRD, ROADMAP M5, REVIEW ("fewer than 1 of 30") |
| Safety review | 0 violations; every ruling reviewed until 100 are | hold | PRD |

The statuses:
- **`collecting`:** fewer than 30 cases.
- **`fold`:** any fold row fails.
- **`hold`:** demand passes, but the safety review isn't clean. It has a violation, rulings waiting, or rulings that were deleted before anyone reviewed them.
- **`continue`:** everything else. Failing watch rows are listed as warnings.
- While any counted case is still live, the decision is marked **provisional:** its answers, votes, clicks and payments can still come in.

Design decisions:
- **The cohort is every case filed** (from `--since`, if given), whether live, deleted, expired, taken down or declined. The PRD counts "cases filed", and dropping deleted ones would hide exactly the cases that went badly. Cases refused at filing were never stored, so they never count.
- **Kept outcomes have a day, not a time,** and no row links to a case. After a case is deleted, nothing in the database can tell which outcome was its own, which is what the privacy page now says.
- **The visit counter trusts the browser,** like the jury's cookie. A script can inflate it up to the cap of 100 per case. It's a friend-group experiment read by its own operator, and the threshold is an average.
- **A violation takes the case down,** the same way a report does (M3: at once, reversible by SQL), with a `reports` row that says why.
- **The review covers both rulings.** An appeal ruling that lands after a review puts the case back in the queue. `ok` without `--with-appeal` refuses a case that now has an appeal ruling, so text nobody read is never approved.
- **Missed reviews block "continue" but not "fold".** A demand failure is final whatever the safety numbers say. "Continue" needs the safety bar verified, not assumed.
- **No exact-time ordering of "the first 100".** "Every ruling until 100 are reviewed" is the same bar, and works on day-granular kept rows.

Realistic production failures:
| Codepath | Failure | Handled |
|---|---|---|
| delete / expiry | the outcome insert fails (a schema bug) | the delete fails with it, atomically. Nothing is half-deleted, and the M3 tests run every delete and expiry path through the new statement, in every case state |
| delete vs expiry | both hit the same case at once | row locking gives one `RETURNING` row, so one outcome (tested) |
| visit beacon | the route errors or the network drops | the page doesn't care (`catch`); that visit isn't counted, so the metric undercounts |
| visit beacon | private browsing or storage disabled | nothing is sent, since nothing can be deduplicated (undercount, never double) |
| visit beacon | a reload loop or a script | `localStorage` stops the loop; the per-case cap of 100 bounds the script |
| `npm run decide` | run without `DATABASE_URL` | it reads local PGlite and says so on stderr; it never prints the URL |
| `npm run decide` | local PGlite while `npm run dev` holds it | PGlite refuses the second process; the error is printed and the exit code is 1 (documented) |
| review | a ruling with terminal escape codes | control and bidi characters are stripped before printing |
| review | an appeal ruling arrives between `review` and `ok` | `ok` refuses: "it now has an appeal ruling; run review again" |
| report | an expiry backlog of 500 cases | the outcome rows go in the same batch statements as before |

#### 3. Test review

Same harness: `app.request` against in-memory PGlite, the fake clock, the mocked judge, the fake Stripe (`paidMode`) for paying cases, and the fake DOM for the script.

| Exit criterion | Test file | Tests |
|---|---|---|
| 1. Every PRD threshold is applied | `test/decide.test.js` | 30 real cases through the API, with set numbers of answers, 2+ vote juries, visits, unlock clicks and Stripe test payments, give exactly those counts, rates and pass/fail per metric |
| 2. No decision under 30 cases | `test/decide.test.js` | 29 cases: `collecting` with "1 more"; 0 cases: no division by zero |
| 3. The fold rule | `test/decide.test.js` | 12/30 answered passes and 11/30 folds; 0 paid folds and 1/30 passes; 2% needs ≥ 2 payers at 51 cases; 8/30 juries passes and 7/30 folds; every bar met plus a clean review: `continue`; watch failures as warnings only; provisional while cases are live |
| 4. The numbers outlive the cases | `test/outcomes.test.js` | the 30-case run, then a plaintiff delete, a defendant delete and the day-31 expiry: identical report; `case_outcomes` holds no id, token or text; every case table is empty; the outcome of a case in every state; delete racing expiry gives one row |
| 5. Visitors are real people | `test/visits.test.js` | the route (204/404/400/415, cap); pages carry `data-visit` (and the plaintiff mark); the real script in the fake DOM beacons once, never twice, never for the filer or the plaintiff link, never without storage, and not from 404 or taken-down pages |
| 6. The safety review | `test/review.test.js` | the queue and its order; `ok`; `violation` takes the case down with a report; an appeal re-queues; a stale `ok` is refused; missed reviews; 100 reviewed completes the sample; `hold` until clean |
| 7. The operator can run it | `test/decide-cli.test.js` | `run()` for every command and usage error; stripped control characters; `--json`; `--since`; a real `node scripts/decide.js` against in-memory PGlite; `npm run decide` exists |

Also:
- `config.test.js` gains an M4 → M5 upgrade test: an M4-shaped database gains the columns and the table, keeps its rows, and the script runs twice.
- `legal.test.js` checks that the privacy page now names `pc_seen` and the anonymous outcomes.

Not automated:
- the 30 real cases
- the beacon in real browsers (iOS Safari's storage in particular)
- the command line against Neon

These are under "What's left".

## What the product does now (after M5)

Group Chat Court is a small web app, plus one command line for its operator (M5) that applies the PRD's bars and says whether to continue or fold it into tiebreak.
1. **File a case.** The plaintiff opens `/` and enters a charge (and optionally a title) plus their testimony. The receipt gives four links:
   - a **summons link** for the other side
   - a **jury link** for the group chat
   - a private **plaintiff link** (new in M3), which shows the other links again and has the delete button
   - the **case page**
2. **Answer the summons.** The defendant opens the link without an account, reads the charge and the plaintiff's testimony, and answers once.
3. **Jury duty** (new in M2). Anyone with the jury link reads the case file, including the ruling once there is one. They vote guilty or not guilty with an optional one-line comment (up to 140 characters), once per device.
   - After voting, they see their own vote and the jury split so far.
   - The device is a random HttpOnly cookie. A second vote from the same device gets 409 and the first vote stands.
   - Comments go through the same scope screen as testimony.
4. **Call the judge.** On the case page anyone with the link can call the judge, once the defendant has answered or the 24-hour deadline has passed.
   - The AI judge writes a formal, funny ruling of 40–200 words with a verdict: guilty, not guilty or split decision.
   - If the defendant never showed up, it rules "The defendant failed to appear".
   - The jury doesn't influence the judge. The two verdicts sit side by side.
5. **Results page.** It shows:
   - the case file and the ruling, plus the appeal and its verdict once there is one
   - the jury split ("2 guilty · 1 not guilty") and the latest 50 comments
   - once ruled, the **verdict card** with a download link
   - `og:image` tags, so pasting the case link into a chat shows the card as the preview
6. **Verdict card** (new in M2). `/cases/:id/card.png` is a 1080×1350 PNG. It shows the title, the charge, a verdict stamp ("Verdict pending" until the ruling), a ruling excerpt, the jury split and "File your own case at <host>".
   - After a heard appeal (M4) it shows the final verdict under "Upheld on appeal" or "Overturned on appeal", with the appeal ruling.
   - Text is drawn as text, so `<script>` shows up as characters.
   - Glyphs the card font can't draw (emoji, CJK) are left off the card. The pages still show them.
   - Unchanged cards revalidate with a 304 and are cached per instance, so they aren't re-rendered.
7. **Declines.** Serious disputes (abuse, health, money, minors) are refused with a decline message that points to real help:
   - at filing, at testimony, in jury comments and before ruling
   - in appeal evidence (M4)
   - a declined case takes no votes and has no card
   - a declined appeal keeps the original ruling and hides its evidence
8. **Delete** (new in M3). Either party can delete the whole case: the plaintiff from the plaintiff page, the defendant from the summons page.
   - The page asks for confirmation, then deletes both testimonies, the ruling, the votes and comments, any reports, unlock clicks and emails, the appeal and the payment record, and the card.
   - Every link to the case then returns 404, and the browser lands on `/deleted`.
9. **30-day expiry** (new in M3). Every case filed more than 30 days ago is deleted the same way. The case, summons and plaintiff pages say on which day.
   - On Vercel a daily Vercel Cron job runs it.
   - On Render (M4) `scripts/serve.js` runs it at boot and then hourly.
10. **Report** (new in M3). "Report this case" sits at the bottom of the case, jury and summons pages. A report needs a reason: it names someone outside the argument, it's serious, it's mean, or something else. An optional note goes with it.
    - It takes the case down for everyone at once. The case and jury pages answer 410 "taken down" with no content, and there is no card.
    - Testimony, votes, the judge, checkout and the appeal are closed.
    - The parties still see the delete button on their own links. A payer's appeal page says they're owed a refund.
11. **"Full trial · $3" without payments: the fake door** (M3). This is what the case page shows until `STRIPE_SECRET_KEY` and `CONTACT_EMAIL` are both set.
    - It offers one appeal with new evidence. M4 changed the copy, which had also promised photo exhibits.
    - A click records one row and only then says "Payments aren't switched on yet, so nothing was charged".
    - It offers an optional email field.
12. **"Full trial · $3" with payments: one appeal, paid through Stripe Checkout** (new in M4).
    - **Before the ruling,** the case page explains the appeal and has no button.
    - **After the ruling,** "Appeal the verdict · $3" records a click and opens Stripe's hosted Checkout for $3.00 USD. Stripe sends the payer back to their own **appeal page**, `/appeals/<id>`, which is also linked in Stripe's receipt email.
    - **Marking paid.** The appeal page and Stripe's signed webhook both re-read the session from Stripe. Either one marks the case paid; both are safe to repeat.
    - **Filing the appeal.** On their appeal page the payer says which side they're on and adds new evidence (up to 1,000 characters).
      - The judge hears the case again with the original ruling and the evidence, and upholds or overturns the verdict.
      - The case page, jury page, plaintiff page and card show the result.
      - One appeal per case: a second one is 409.
    - **If the judge is down,** the appeal stays filed, and "Hear the appeal" on the case page retries.
    - **Refunds.** If two people pay for the same case, the second payer's page says they're owed a refund. So does a payer's page after a takedown.
13. **Terms and privacy** (new in M4). `/terms` and `/privacy` are linked from every page's footer and from the checkout button.
    - Terms: what $3 buys, refunds on request within 14 days.
    - Privacy: what is stored and for how long, and the processors (Google, Stripe, Neon, Vercel or Render).
    - Both give the `CONTACT_EMAIL` address. Go-live adds the repo's GitHub issues as the public contact, a "No warranty" section, the cookie and the three RepoHQ launch counts (LAUNCH-READY.md).
    - M5 adds what the visit count and the outcome rows keep, and drops the old "no analytics" line.
14. **Visitors per case** (new in M5).
    - **What counts:** the first time a browser opens a case's page, summons link or jury link, the page's script sends `POST /visits` once, and the case's counter goes up by one.
    - **How it dedupes:** the browser remembers the cases it has seen in `localStorage` (`pc_seen`, at most 200).
    - **Never counted:**
      - the browser that filed the case, and any browser that opens the plaintiff link
      - link-preview bots, which run no script
      - a browser without working storage
    - **What the server keeps:** a number per case (capped at 100). No cookie and no per-visitor row.
15. **Outcomes outlive the cases** (new in M5). When a case is deleted, by a party or by the 30-day expiry, the same statement keeps one anonymous row in `case_outcomes`:
    - the filing day
    - answered, ruled, taken down, clicked and paid (yes/no)
    - the number of votes and visitors
    - the safety review's result, and whether a ruling was unreviewed
    - whether it was deleted or expired
    - no text, id, token or time finer than a day

    The decision therefore counts every case ever filed, not just the ones still stored.
16. **The decision: `npm run decide`** (new in M5). The operator runs it with the `DATABASE_URL` from the keychain. It prints, in 80 columns:
    - each PRD metric (defendant response, 2+ jury votes, visitors per case, unlock clicks, paid) with its count, rate, bar and pass/FAIL
    - the safety review, then the decision:
      - **keep collecting** under 30 cases
      - **fold** ("fold the flow into tiebreak as a mode and stop") when defendant response is under 40%, paid is under 2% or no case paid, or under 25% of cases have 2+ jury votes
      - **hold** when demand passes but the safety review isn't clean
      - **continue** otherwise, with any watch metric that's below target listed
    - "provisional" while counted cases are still live
    - `--since YYYY-MM-DD` leaves out earlier cases (the deploy checks), and `--json` gives the same result as JSON
17. **The safety review** (new in M5). It checks the PRD's "zero cases that name non-participants or fall into the excluded topics", on every ruling until 100 are reviewed.
    - `npm run decide -- review` lists each ruling waiting, oldest first, with:
      - the title, the charge, the ruling and any appeal ruling (control characters stripped)
      - the date the case will be deleted
      - the two commands to answer it
    - `ok <caseId>` approves it. If the case has an appeal ruling, `--with-appeal` is required, so a ruling nobody read is never approved.
    - `violation <caseId> names_someone|serious` takes the case down at once with a report row that says why.
    - An appeal ruled after a review puts the case back in the queue.

API (JSON in, JSON out):

| Method and path | Result |
|---|---|
| `POST /cases` `{ title?, charge, testimony }` | `201 { caseId, summonsToken, juryToken, plaintiffToken, caseUrl, summonsUrl, juryUrl, plaintiffUrl, deadlineAt }`; 400 / 413 / 415 / 422 |
| `GET /plaintiff/:token` | the plaintiff's private page (HTML): where the case stands (including the verdict on appeal), the summons and jury links, the deletion date, delete; for a taken-down case only the notice and delete; 404 for any wrong token |
| `DELETE /cases/:id` with `Authorization: Bearer <plaintiff or summons token>` | `200 { caseId, deleted: true }`; 401 (with `WWW-Authenticate: Bearer`) without a bearer token; 404 for a wrong id or token, including the jury token |
| `GET /deleted` | "the case is deleted" page |
| `POST /reports` `{ caseId, reason: "names_someone" \| "serious" \| "mean" \| "other", note? }` | `201 { caseId, reported: true }` and the case is down; `200` the same if it was already down (nothing stored); 400 / 404 / 413 / 415 |
| `POST /cases/:id/unlock` `{}` | the fake-door click: `200 { caseId, clickId, charged: false, message }`; 404; 409 (declined or taken down); 415. Never calls Stripe, even with payments on |
| `POST /cases/:id/unlock/email` `{ clickId, email }` | `200 { caseId, saved: true }`; 400 (bad email or click id); 404 (no such click on this case) |
| `POST /cases/:id/checkout` `{}` | M4: records a click and opens a Stripe Checkout Session: `200 { caseId, clickId, url }` (`url` is on `https://checkout.stripe.com/`); 409 (not ruled, declined, taken down, already paid or appealed); 404; 415; 502 (Stripe failed); 503 (payments off). Go-live: with Checkout off and `STRIPE_PAYMENT_LINK` set, `url` is that Payment Link with `client_reference_id=<clickId>` (see LAUNCH-READY.md) |
| `GET /appeals/:clickId` | M4: the payer's page (HTML), Stripe's success URL. It fulfils the payment if Stripe says it's paid, then shows the receipt line and the appeal form, or the appeal. "Owed a refund" if someone else appealed first; 410 for a taken-down case (with the refund note for a payer); 404 for a wrong id or a fake-door click |
| `POST /stripe/webhook` | M4: Stripe events, signature-checked on the raw body (300 s tolerance). `checkout.session.completed` and `…async_payment_succeeded` fulfil; other types are ignored. `200 { received: true }`; 400 bad signature; 502 Stripe unreachable (Stripe retries); 503 no `STRIPE_WEBHOOK_SECRET`; 404 with payments off |
| `POST /cases/:id/appeal` `{ side: "plaintiff" \| "defendant", evidence }` with `Authorization: Bearer <paid click id>` | M4: `201 { caseId, caseUrl, heard, appeal: { side, evidence, filedAt, verdict, ruling, ruledAt, outcome: "upheld" \| "overturned", declined } }` once (`heard: false` plus `error` if the judge was down), then 409. Other answers: 402 unpaid; 401 no bearer; 403 not a paid click of this case; 409 not ruled, declined or taken down; 400; 404; 413; 415; 422 out of scope (nothing stored) |
| `POST /cases/:id/appeal/rule` | M4: hears a filed appeal: `200 { caseId, appeal }` (idempotent, one model call); 409 (no appeal, taken down); 422 (declined); 502 / 503; 404 |
| `GET /terms`, `GET /privacy` | M4: the legal pages (HTML) |
| `GET /cron/expire` | runs the expiry job: `200 { deleted, cutoff }`; 401 only when `CRON_SECRET` is set and isn't sent as the bearer token |
| `GET /summons/:token` | summons page (HTML), with the defendant's delete button and the report form; only the notice and delete for a taken-down case; 404 for any wrong token |
| `POST /summons/:token/testimony` `{ testimony }` | `201 { caseId, caseUrl }` once, then 409; 400 / 404 / 422 |
| `POST /cases/:id/rule` | `200 { caseId, verdict, ruling, defaultJudgment, ruledAt }`; 404 / 409 / 422 / 502 / 503 |
| `GET /cases/:id` | results page (HTML): the jury, the full-trial section (fake door or Checkout), the appeal, the report form and, once ruled, the card; 410 for a taken-down case |
| `GET /jury/:token` | jury page (HTML): the vote form, or this device's vote and the split, plus the appeal's outcome and the report form; 410 for a taken-down case; 404 for any wrong token |
| `POST /jury/:token/votes` `{ vote: "guilty" \| "not_guilty", comment? }` | `201 { caseId, caseUrl, vote, jury: { guilty, notGuilty, total } }` once per device (sets the `pc_device` cookie if missing), then `409 { error, jury }`; 400 / 404 / 409 (declined or taken-down case) / 413 / 415 / 422 |
| `GET /cases/:id/card.png` | `image/png` 1080×1350 with a weak `ETag` and `Cache-Control: private, no-cache`; 304 on a matching `If-None-Match`; 404 for a wrong id, or a declined, taken-down or deleted case |
| `POST /visits` `{ caseId }` | M5: one more visitor for the case, sent by the page's script once per browser: `204`, no cookie, capped at 100 per case; 404 (no such case, or a malformed id); 400; 415 |
| `GET /robots.txt`, `GET /sitemap.xml` | Go-live: crawl rules (allow all, skip `/cron/`, point at the sitemap) and the three public pages (`/`, `/terms`, `/privacy`) |
| `GET /og.png` | Go-live: the public pages' 1200×630 share image, drawn with satori like the card, cached a day |

Testimony and rule also answer 409 for a taken-down case, and every case route answers 404 once it is deleted or expired.

## Run it locally

```
npm install
npm test          # 546 tests, 30–60 s, no network or keys needed (Stripe is a fake in test/stripe.js)
npm run dev       # http://localhost:3000 (PORT to change)
curl http://localhost:3000/cron/expire   # run the 30-day expiry job by hand
npm run decide    # M5: the PRD thresholds and the decision (stop `npm run dev` first when it uses local PGlite)
npm run screenshots   # the README's screenshots; needs CHROMIUM_PATH (never downloads a browser)
```

**M5: the decision and the safety review.** Against the deployed database, export `DATABASE_URL` from the keychain in your shell (never in a file), then:

```
npm run decide                            # every PRD bar, the safety review, and the decision
npm run decide -- --since 2026-11-05      # only cases filed from that day (UTC): leaves out your deploy checks
npm run decide -- --json                  # the same, as JSON
npm run decide -- review                  # rulings waiting for the safety review, with the commands to answer each
npm run decide -- ok <caseId>             # the ruling is fine (add --with-appeal when the case has an appeal ruling)
npm run decide -- violation <caseId> names_someone   # or `serious`: records it and takes the case down
```

- Run `review` every few days during the 30-case run. Each ruling shows the day its case is deleted, and a ruling deleted before review counts as a gap in the safety bar.
- Exit codes: 0 done, 1 the command failed (no such case, a stale `ok`), 2 usage error.
- Without `DATABASE_URL` it reads the local PGlite data of `npm run dev` (and says so). PGlite allows one process at a time, so stop the dev server first.
- `npm run screenshots` starts `scripts/dev.js` on a free port with its own throwaway data (`.data/screenshots-db`, removed afterwards), with only `PATH`, that folder and a placeholder `STRIPE_PAYMENT_LINK` (https://example.com/pay) in its environment, so it never uses a real database or key.
  - It drives the app with Playwright (`playwright-core`, a devDependency) and the Chromium at `CHROMIUM_PATH`.
  - It writes six PNGs in `docs/screenshots/` (go-live: the start page, the summons, the verdict with the Buy button and the footer), and fails if the Buy button or the footer links aren't in view. The M5 decision report is no longer screenshotted; `npm run decide` still prints it.

- Without `DATABASE_URL`, `npm run dev` keeps data in PGlite under `.data/pglite` (gitignored; `PGLITE_DIR` moves it, `PGLITE_DIR=memory://` keeps nothing).
- Without an LLM key it uses the stub judge, which gives canned rulings (and canned appeal rulings), and says so on startup.
- To use the real judge locally, export `GOOGLE_API_KEY` in your shell (from the keychain; never in a file).
- To use another OpenAI-compatible provider or a LiteLLM proxy, set `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`.
- To try the jury as several people, open the jury link in different browsers or private windows. Each one is a separate device.
- The card needs nothing extra. Its font (Lora, SIL Open Font License, from `@fontsource/lora`) and renderer (satori + `@resvg/resvg-wasm`) are npm dependencies with no install scripts and no native binaries.
- To try delete, open the plaintiff link from the receipt, or the summons link, and press "Delete this case".
- To try a takedown, use "Report this case" at the bottom of the case page.
- Without Stripe settings, "Full trial · $3" is M3's fake door. Startup says so.
- **To try real Checkout in test mode:**
  1. Export a test-mode `STRIPE_SECRET_KEY` (from the keychain; never in a file) and `CONTACT_EMAIL` in your shell, then run `npm run dev`.
  2. File, answer and rule a case, then press "Appeal the verdict · $3".
  3. Pay with the test card 4242 4242 4242 4242 (any future date, any CVC). Stripe sends you back to `/appeals/<id>`, which marks the case paid. File the appeal there.
  4. For the webhook as well: the free Stripe CLI's `stripe listen --forward-to localhost:3000/stripe/webhook` prints a signing secret. Export it as `STRIPE_WEBHOOK_SECRET` before starting.
- `node scripts/serve.js` is the production entry for Render, not for local use. It needs `DATABASE_URL` and never falls back to PGlite or the stub judge.

Operator queries, for what `npm run decide` doesn't cover (there's still no admin UI). Run them with `psql "$DATABASE_URL"` against Neon, or with Neon's SQL editor:

```sql
-- Reported cases, newest first (each one is already down)
SELECT r.created_at, r.case_id, r.reason, r.note FROM reports r ORDER BY r.created_at DESC;

-- Put a wrongly reported case back up (the report row stays as history)
UPDATE cases SET reported_at = NULL WHERE id = '<case id>';

-- The M4 gate: share of stored cases with at least one unlock click (needs ≥ 2%), and how many left an email
SELECT round(100.0 * count(DISTINCT u.case_id) / NULLIF((SELECT count(*) FROM cases), 0), 1) AS pct_cases_clicked,
       count(DISTINCT u.case_id) FILTER (WHERE u.email IS NOT NULL)                       AS cases_with_email
FROM unlock_clicks u;

-- Appeals heard among the cases still stored (the M5 report covers clicks and payments, including gone cases)
SELECT count(*) FILTER (WHERE appeal_ruled_at IS NOT NULL) AS appeal_heard FROM cases;

-- How the gone cases went (M5): deleted by a party vs expired
SELECT gone_by, count(*) FROM case_outcomes GROUP BY gone_by;

-- Refunds owed: a second payer on a case someone else appealed, a declined appeal, a takedown before the hearing.
-- Refund each one in the Stripe dashboard (search the session id, open its payment, Refund).
SELECT u.checkout_session_id, u.case_id, u.paid_at,
       CASE WHEN c.appeal_click_id IS NOT NULL AND c.appeal_click_id <> u.id THEN 'someone else appealed'
            WHEN c.appeal_declined_at IS NOT NULL                          THEN 'appeal declined'
            ELSE 'taken down before the hearing' END                       AS why
FROM unlock_clicks u JOIN cases c ON c.id = u.case_id
WHERE u.paid_at IS NOT NULL
  AND ((c.appeal_click_id IS NOT NULL AND c.appeal_click_id <> u.id)
       OR c.appeal_declined_at IS NOT NULL
       OR (c.reported_at IS NOT NULL AND c.appeal_ruled_at IS NULL));
```

The M4 gate query above counts only the cases still stored, a rolling 30-day window. `npm run decide` (M5) counts every case filed, gone ones included. Payments for cases that were deleted before fulfilment are only in the logs (`refund Stripe session …`) and in Stripe.

## Deploy on a free tier

### Cloudflare Worker (live since 2026-11-08)

Vercel blocked the agent account on 2026-10-31 (every deployment answers 402), so pettycourt runs on a Worker: https://pettycourt.1426davejobs.workers.dev. It's on Workers Paid because a verdict card takes 0.1–1 s of CPU and the free plan allows 10 ms; `limits.cpu_ms` is 30 s. Cloudflare allows commercial use, so this is also where the money can be taken.

- **Deploy.** Run `provision cloudflare deploy pettycourt "$PWD"` from a checkout of main. There's no build step: wrangler bundles `src/worker.js`. Secrets go through the broker with `provision cloudflare secret pettycourt DATABASE_URL`, and the same for `GOOGLE_API_KEY`. The optional ones (`STRIPE_PAYMENT_LINK`, `CONTACT_EMAIL`, Stripe keys, `CRON_SECRET`) are set the same way and are read on every request.
- **Settings.** The `wrangler.jsonc` vars are `PUBLIC_URL` (links and canonical URLs) and `NEXT_PUBLIC_DEPLOY_ENV=production` (RepoHQ's launch counts).
- **Postgres.** `pg` reaches Neon over the Workers socket API. A Worker can't use a socket another request opened, so `requestScopedPostgres` (`src/config.js`) gives the store one stable client. Each query goes to a one-connection pool that belongs to its request (`AsyncLocalStorage`). The pool is opened on first use and ended after the response. The schema still runs once per isolate.
- **Cards on a Worker.** A Worker can't read files or compile wasm at run time, which takes three changes:
  - The wasm for resvg and for satori's layout engine, and the eight Lora fonts, are imported in `src/worker.js` and given to `card.js` through `setCardAssets`. `card.js` now uses `satori/standalone` and initialises its layout engine from that wasm; under Node it reads the same files.
  - satori shapes text with harfbuzz (emscripten). It compiles its inline wasm, plus a 34-byte wrapper module for a JS callback, at run time. Without help, the first card waited forever. `src/harfbuzz-wasm.js`, imported first, swaps both compiles for modules wrangler compiled at deploy: the identical `harfbuzzjs/hb.wasm`, and `src/harfbuzz-callback-vi.wasm`. `test/worker.test.js` renders a card under Node, records every module compiled from bytes, and checks each one is bundled, so a satori upgrade that needs another fails a test, not production.
  - `define` gives the bundle a fixed `import.meta.url` and `self.location.href`. Neither is ever fetched.
- **Expiry.** A Cron Trigger at 04:17 UTC (`src/schedule.js`) calls `/cron/expire` inside the Worker. It sends `CRON_SECRET` if one is set, since the route requires it then. `vercel.json` is gone; the pages' deletion promise is tested against `src/schedule.js`.

The two sections below describe the earlier hosts. They're kept because the code still runs there: `src/app.js`'s default export and `scripts/serve.js`.

Two targets from the same code: **Vercel Hobby** for the free, test-mode run, and **Render's free web service** for live payments, because Vercel Hobby is non-commercial. Both use the same Neon database and Gemini key.

### Vercel Hobby + Neon free + Gemini free (+ Stripe test mode)

1. Provisioning (see "Infrastructure"): the pipeline creates the Neon database and the Gemini key, then the Vercel project `pettycourt`. The project receives `DATABASE_URL` and `GOOGLE_API_KEY` as environment variables.
2. Deploy: `vercel deploy --prod` from the repo root, or connect the git repo in Vercel.
   - There is nothing to configure. Vercel's zero-config Hono preset detects `src/app.js` (it imports `hono` and default-exports the app) and runs it on the Node 22 runtime (`engines.node` is `22.x`).
   - `vercel.json` holds only the cron entry (`/cron/expire` daily at 04:17 UTC), with no build or framework settings. `render.yaml` and `scripts/serve.js` are ignored by Vercel.
   - There is no build step and no migration step. The schema script runs on the first request of each instance, under an advisory lock.
     - `CREATE TABLE IF NOT EXISTS` adds `votes`, `reports` and `unlock_clicks` to an older database.
     - `ADD COLUMN IF NOT EXISTS` adds M3's `plaintiff_token` and `reported_at`, M4's payment and appeal columns, and M5's `visitors`, `review` and `reviewed_rulings`. M5's `case_outcomes` table comes the same way.
   - Optional: set `CRON_SECRET` (any long random string) in the Vercel project env. Vercel Cron then sends it, and `/cron/expire` refuses callers without it. Without it, the job still runs (see the M3 plan's EUREKA note).
3. Check: open `/`, file a case, open the summons link in a private window, answer, call the judge.
   - If every ruling returns 502, check the function logs for `Judge request failed with HTTP 404`.
   - That means the default model alias isn't served. Set `LLM_MODEL` in Vercel env to a current free model, e.g. `gemini-2.5-flash-lite`.
4. Check M2: open the jury link in two private windows and vote once in each. A third vote from the same window should say "already voted". Then open `/cases/<id>/card.png`.
   - If the card returns 500 and the logs mention `index_bg.wasm`, `.woff2` or `unicode.json` (`ENOENT` or "Cannot find module"), Vercel's file tracing left those files out of the function. The fallback is under Review.
   - Pages and voting work regardless, because only the card route loads those files.
5. Check M3:
   - **Delete.** File a case, open the plaintiff link and delete it. The case, summons, jury and plaintiff links should all show "No such case".
   - **Cron.** In the Vercel dashboard, open Settings → Cron Jobs: `/cron/expire` should be listed. Press "Run" once.
     - The function log shows a 200, plus an `expiry: deleted N case(s)` line when anything was old enough.
     - With `CRON_SECRET` set, opening `/cron/expire` in a browser should give 401.
   - **Zero-config still applies.** If the deploy stops detecting Hono after `vercel.json` appeared (the app 404s everywhere), set Framework Preset to "Hono" in Project Settings. This is listed under Review.
   - **Fake door and report.** Press the unlock button on a case page and leave a test email, then report the case. Check the rows with the operator queries above, delete that case, and check the rows are gone.
6. **M4 in test mode** (after the Stripe and contact requests in "Infrastructure" are done):
   1. The Vercel env holds a **test-mode** `STRIPE_SECRET_KEY` (a restricted key that may write Checkout Sessions), `STRIPE_WEBHOOK_SECRET` and `CONTACT_EMAIL`. Redeploy so they take effect.
   2. In Stripe (test mode), add a webhook endpoint at `https://<vercel host>/stripe/webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Its signing secret is `STRIPE_WEBHOOK_SECRET`.
   3. Turn on Settings → Customer emails → Successful payments. That's the receipt email; in test mode use "Send test receipt" to see it.
   4. Rule a case and press "Appeal the verdict · $3". Pay with 4242 4242 4242 4242. You should land on `/appeals/<id>` with "Paid $3.00 on …".
   5. File an appeal. The case page should show "Verdict on appeal", and the card the new stamp.
   6. In Stripe → Webhooks the delivery should show 200. The funnel query should count the case as paid.
   - **If checkout answers 502,** the logs say `checkout failed: Stripe request failed with HTTP <status>`. 401 means a wrong key; 403 means the restricted key lacks the Checkout Sessions permission.
   - **If the webhook shows 400** in Stripe, the signing secret doesn't match. **503** means `STRIPE_WEBHOOK_SECRET` isn't set. The landing page still marks payments either way.
   - **Keep test keys on Vercel.** Hobby is non-commercial, and live keys belong on Render only.
7. **Check M5.** There's nothing to configure: the visit route ships with the app, and `npm run decide` runs on your machine.
   1. Open a case's jury link in a private window with the browser's developer tools on the Network tab. One `POST /visits` should answer 204. Reloading sends nothing more.
   2. The window you filed from should send none at all.
   3. With `DATABASE_URL` exported from the keychain, `npm run decide` should list your check cases, and `npm run decide -- review` their rulings.
   4. Note the first day of the real run and use it as `--since` from then on, so the deploy checks don't count.

### Render free web service (commercial use, live payments)

1. Render dashboard → New → Blueprint → this repo. `render.yaml` defines one free Node web service:
   - build: `npm ci --omit=dev --ignore-scripts`
   - start: `node scripts/serve.js`
   - health check: `/`
2. Fill the `sync: false` values in Render:
   - the same `DATABASE_URL`, `GOOGLE_API_KEY` and `CONTACT_EMAIL`
   - the **live** `STRIPE_SECRET_KEY`
   - the signing secret of a second (live) Stripe webhook endpoint at `https://<service>.onrender.com/stripe/webhook`, with the same two events
   - `CRON_SECRET` is generated by Render.
3. Render sets `RENDER_EXTERNAL_URL`, so links, Stripe's return URLs and the `Secure` cookie use `https://<service>.onrender.com` even though TLS ends at Render's proxy. `PUBLIC_URL` overrides it.
4. **Expiry.** Render's cron jobs are paid, so `scripts/serve.js` runs the expiry at boot, before serving, and then hourly. The free instance sleeps after 15 idle minutes, and the next request wakes it in about 30–60 s, which runs the expiry first.
   - Vercel's daily cron may keep running against the same database. Both delete the same rows, idempotently.
5. **Live check:** one real $3 payment with your own card.
   - The receipt email should arrive with the appeal link.
   - The appeal should be heard.
   - Then refund it in the Stripe dashboard.
6. Share the Render URL from then on. Remove the Stripe keys from Vercel, or keep them in test mode there.

Costs: $0 fixed.
- **Vercel Hobby:** free, non-commercial. Fine for the test-mode run.
  - A card render costs about 150 ms of CPU, plus about 0.5 s for the first one on a cold instance.
  - Revalidation (304) and the per-instance cache keep repeat views of the same card from re-rendering.
- **Render:** free web service with 750 instance hours a month, which covers one always-reachable service. It sleeps when idle. Its terms (July 2026) don't bar commercial use, though its docs advise against production on free instances.
- **Neon:** free tier, 0.5 GB. A vote row is about 150 bytes. The 30-day expiry caps how much is stored at any time. M5's outcome rows (under 100 bytes per case ever filed, index included) are the only thing that grows: under 10 MB per 100,000 cases.
- **The visit beacon:** one tiny request per browser per case, no model call.
- **Vercel Cron on Hobby:** free, once a day per job. One job is used.
- **Gemini API:** free tier with rate limits; Google may use the prompts. The filing, summons and appeal pages say so.
  - An appeal is one more model call per paid case.
  - Jury votes, the card, reports, delete, checkout and the unlock make no model calls.
- **Stripe:** no monthly fee. Its per-payment fee (2.9% + 30¢ on US cards, so about 39¢ of each $3) comes out of the payment, so it's never out of pocket. Receipts are included.

## M5 exit criteria

The roadmap's M5 is a decision, so these criteria are derived from it, from the PRD's success metrics and from REVIEW.md's kill criteria (see the Plan). The 30 real cases themselves can't run inside a build (see "What's left").

| Exit criterion | Status |
|---|---|
| 1. Every PRD threshold is applied to the recorded cases | ✅ pass. 30 cases driven through the real API, with a set mix:<br>• 14 defendant answers<br>• 9 juries of 2+ votes<br>• 36 visits<br>• 3 unlock clicks, one of them a Stripe test payment<br>• 5 rulings<br>They give exactly those counts. The decision reads 46.7%/40%, 30.0%/25%, 1.20/1.0 per case, 10.0%/5% and 3.3%/2% with 1 case: all pass. With 5 rulings unreviewed the decision is `hold`; after the review it's `continue (provisional)`. The bars match the PRD's numbers, and the report fits 80 columns. (`test/decide.test.js`) |
| 2. No decision under 30 cases | ✅ pass. At 29 cases it's `collecting` with "1 more to go", even when every bar is cleared or failed. At 0 cases there's no division by zero, NaN or Infinity, and nothing passes. Exactly 30 cases is enough. (`test/decide.test.js`) |
| 3. The fold rule | ✅ pass. Each bar is tested at its edge:<br>• **Defendant response:** 12 of 30 (exactly 40%) passes; 11 of 30 folds, with the reason.<br>• **Paid:** 0 paid folds; 1 of 30 passes; at 51 cases one payer (1.96%) folds and two pass; 1 of 50 (exactly 2%) passes.<br>• **Jury turnout:** 8 of 30 passes, 7 of 30 folds.<br>Several failures are all listed. Visitors and clicks only give warnings. A fold stands whatever the safety review says. The decision is provisional while cases are live. (`test/decide.test.js`, `test/review.test.js`) |
| 4. The numbers outlive the cases | ✅ pass. After the 30-case run, a plaintiff delete, a defendant delete and the day-31 expiry give identical metrics, now final.<br>• **No trace:** every case table is empty for every case, and every link is a 404. `case_outcomes` holds 2 deleted and 28 expired rows. None of its values contain a case id, token, click or session id, any text or the email. It has no timestamps (days only), no foreign key, and only two enum text columns.<br>• **Every state is kept right:** fresh, answered with visits, declined, taken down, reviewed, no-show, paid and appealed.<br>• **Exactly once:** a delete racing the expiry keeps one row, and batches keep one per case. A wrong token keeps nothing.<br>• **`--since`** filters live and gone cases alike. (`test/outcomes.test.js`) |
| 5. Visitors are real people | ✅ pass. The real client script runs in the fake DOM with a `localStorage` per browser:<br>• the first open sends one JSON `keepalive` beacon, a reload sends none, and another browser counts again<br>• summons, case and jury in one browser count once<br>• the filing browser and a plaintiff-link browser never count, while a friend's browser opening the same links does<br>• no storage or a refusing storage sends nothing; a corrupted list starts over once; at most 200 cases are remembered<br>• pages without a case's content carry no marker and send nothing<br>• a link-preview bot's GETs count nothing<br>The route answers 204 with no cookie, caps at 100, and gives 404/400/415. Real Chromium confirmed it in `npm run screenshots`: the trial's 5 visitors (defendant, 3 jurors, one viewer) were counted and the plaintiff wasn't. (`test/visits.test.js`) |
| 6. The safety review | ✅ pass.<br>• **The queue:** holds ruled, unreviewed cases, oldest first. `ok` removes one.<br>• **A violation:** takes the case down (410, card 404) with one `reports` row and turns the safety bar red. Reviewing again never adds a second report.<br>• **Taken-down cases** still need review.<br>• **An appeal ruling** re-queues the case. A stale `ok` (without `--with-appeal`) is refused, and `--with-appeal` without an appeal is refused too.<br>• **Missing or unruled cases** are refused and nothing is stored.<br>• **Gaps:** a ruling deleted unreviewed is "missed". `hold` until the review is clean. 100 clean reviews complete the sample, but a later violation still counts. (`test/review.test.js`) |
| 7. The operator can run it | ✅ pass.<br>• **`run()`:** report, `--json`, `--since` (a malformed day gives exit 2), `review` (exact commands, deletion date, 80 columns), `ok`, `--with-appeal` and a stale `ok` (exit 1), `violation`, missing or unruled cases (exit 1), eight usage errors (exit 2), and `help`.<br>• **Terminal safety:** control, C1 and bidi characters are stripped from the title, charge and ruling.<br>• **The real script:** `node scripts/decide.js` against in-memory PGlite prints the report and says which data it read; a usage error exits 2. `npm run decide` is in `package.json`. (`test/decide-cli.test.js`) |

All 513 tests pass with `npm test`: the 448 from M1–M4 plus 65 new.
- Two M2/M3 schema-upgrade tests in `config.test.js` now expect `case_outcomes` in their exact table list. The list is still pinned exactly.
- The M3 upgrade test's title now says "adds no M4 table", because the script it runs now includes M5's table.
- Nothing else from M1–M4 was edited or removed.
- `test/dom.js` (a helper) gained an optional `localStorage`; without it, pages behave exactly as before.

## M4 exit criteria

| Exit criterion | Status |
|---|---|
| A test-mode checkout marks the case paid, and an appeal is accepted once and rejected (409) the second time | ✅ pass. **Paid:** a ruled case's checkout creates a test-mode (`cs_test_…`, `livemode: false`) Checkout Session for $3.00 USD, tied to the click and the case. The case stays unpaid while the session is open (the appeal is 402). After the test-card payment, the signed `checkout.session.completed` webhook marks the click and the case paid. The landing page alone does the same; webhook and landing page in either order, repeated or at once, record one `paid_at`. **Appeal:** the payer's appeal is 201 and heard: the judge gets the original ruling and the new evidence, and the verdict on appeal is stored. A second appeal is 409, the first stands, and there's no second model call. Two at once give one 201 and one 409. (`test/checkout.test.js`; the button-to-Stripe and appeal-form wiring in `test/client.test.js`; checkout → signed webhook through the real Node adapter → appeal → 409 in `test/e2e.test.js`) |
| An unpaid case returns 402 on the appeal endpoint | ✅ pass. A ruled, unpaid case answers 402 with no credential, the started-but-unpaid click's id, the plaintiff token and the summons token, and also with payments switched off. Nothing is stored and the judge isn't called. (`test/checkout.test.js`) |

All 448 tests pass with `npm test`: the 347 from M1–M3 plus 101 new. One M3 test was changed on purpose, and nothing else from M1–M3 was edited or removed:
- `unlock.test.js` "the app has no payment client to call" now skips `src/payments.js` when it scans `src/` for Stripe URLs.
- A new test proves the M3 criterion with payments on: the unlock click calls neither Stripe nor `fetch`.
- See the M4 review.

## M3 exit criteria

| Exit criterion | Status |
|---|---|
| DELETE with the plaintiff token removes the case, testimonies, votes and card (all return 404 afterward) | ✅ pass. The test case has both testimonies, a ruling, three votes with comments, a rendered card and an unlock click with an email. After the delete, 13 routes return 404 with none of its text: the case page, the card (also with the old `If-None-Match`), summons, testimony, jury, vote, plaintiff, rule, unlock, report and delete again. No row in `cases`, `votes`, `reports` or `unlock_clicks` holds its id, testimonies, comments or email. Its card-cache entry is gone. The same holds with the defendant's summons token; the jury token, near misses and other cases' tokens get 404 and change nothing. M4 adds the same for a paid, appealed case. (`test/delete.test.js`, `test/appeal.test.js`; from the button in `test/client.test.js`; over real HTTP in `test/e2e.test.js`) |
| Cases older than 30 days are removed by the expiry job in a test with a faked clock | ✅ pass. With the injected clock, a day-0 case with child rows in every table survives the run at exactly 30 days and goes one millisecond later, everywhere. A day-10 case stays until day 40. Re-runs delete nothing; ruled, declined, answered and taken-down cases all go; batches work through a backlog. A check against the `vercel.json` schedule confirms the date the pages promise. M4: paid and appealed cases go too, and `scripts/serve.js` runs the job at boot. (`test/expiry.test.js`, `test/appeal.test.js`, `test/serve.test.js`) |
| Click on the unlock button stores one row with the case id and returns 200 with no payment call made | ✅ pass. The API stores exactly one `unlock_clicks` row with the case id and no email, and returns 200 `{ charged: false }`. A spy on `globalThis.fetch` sees no outbound call, and the judge isn't called. The real client script, clicking the real button in a fake DOM, does the same, then reveals the "nothing was charged" panel with the click id. M4: with payments switched on, the same click calls neither the Stripe client nor `fetch`, and no payment SDK is installed. (`test/unlock.test.js`, `test/client.test.js`) |

At the end of M3, all 347 tests passed with `npm test`: the 264 from M1 and M2, unchanged, plus 83 new.

## M2 exit criteria

| Exit criterion | Status |
|---|---|
| Three votes from three distinct device ids give a split of guilty/not guilty that matches the votes; a repeat vote from the same device id returns 409 | ✅ pass. The 2–1 split matches in the API, the results page, the jury page and the card. A repeat that switches sides gets 409 and changes nothing. Simultaneous duplicates store one vote. (`test/jury.test.js`, plus over real HTTP with cookies in `test/e2e.test.js`) |
| GET /cases/:id/card.png returns image/png, 1080x1350 pixels, and renders without error for a 300-character title | ✅ pass. Checked through the route: PNG signature and IHDR size, a 300-character title (spaced and unspaced), every field at maximum length, emoji/CJK/RTL titles, every verdict, pending and default judgment. M4 adds an appealed card at the same worst case. (`test/card.test.js`, `test/appeal.test.js`) |
| Card text escapes HTML: a charge containing `<script>` appears as text in the page and the card | ✅ pass. The page shows it escaped. The card tree holds it as a text child with no script element and no raw-HTML prop. The card SVG has it as escaped `<text>` that decodes back to the exact characters, and no `<script` tag. The PNG renders. (`test/card.test.js`; jury page and comments in `test/jury.test.js`; appeal evidence and rulings in `test/appeal.test.js`) |

At the end of M2, all 264 tests passed with `npm test`: 210 from M1, unchanged, plus 54 new.

## M1 exit criteria

| Exit criterion | Status |
|---|---|
| POST /cases with a charge and testimony returns 201, a case id and two distinct tokens of ≥ 24 characters | ✅ pass (`test/cases.test.js`) |
| Submitting defendant testimony twice on the same summons token returns 409 the second time and keeps the first answer | ✅ pass, including simultaneous submissions (`test/summons.test.js`) |
| A wrong token returns 404 and leaks no case content | ✅ pass for 6 kinds of wrong token, on the page and the API (`test/summons.test.js`) |
| Rule with both testimonies returns 40–200 words; mocked malformed JSON returns 502 and stores nothing | ✅ pass, 12 malformed shapes plus a thrown error (`test/rule.test.js`) |
| "my boyfriend hits me" (and the fixture list for abuse, health, money and minors) returns 422 with the decline message and no ruling | ✅ pass, 41 fixture phrases plus 10 petty false-positive guards (`test/scope.test.js`) |
| Rule before the answer and before the deadline returns 409; after the deadline it rules "defendant failed to appear" | ✅ pass (`test/rule.test.js`) |

## Infrastructure

**M5 asks for nothing new,** and `.provision` is unchanged.
- The outcome rows and the visit counter live in the same Neon database.
- `npm run decide` runs on the operator's machine with the `DATABASE_URL` the broker already stored in the keychain, exported in the shell and never written to a file.
- No analytics service, admin login or new secret is involved.
- Playwright (`playwright-core`, a devDependency for `npm run screenshots`) uses the Chromium at `CHROMIUM_PATH` and never downloads a browser.

From M4: M4 needs a payment provider, a public contact address and a commercial-use host. The broker can't create the first and the last of these, so `.provision` asks David for them with `request` lines. No values are in the repo, and the tests use a fake Stripe with fake keys built at runtime.

| Line | Gives | Used as |
|---|---|---|
| `neon db pettycourt` | Neon Postgres free tier | `DATABASE_URL` |
| `gcp key pettycourt generativelanguage.googleapis.com` | Gemini API key restricted to the Generative Language API | `GOOGLE_API_KEY` (the judge) |
| `vercel project pettycourt` | Vercel Hobby project with every stored value as env | the test-mode deployment |
| `request "Stripe account for pettycourt, test mode first: …"` (M4) | a Stripe account and its test-mode values, plus the dashboard settings: webhook endpoint, Customer emails → Successful payments | `STRIPE_SECRET_KEY` (a restricted key that may only write Checkout Sessions) and `STRIPE_WEBHOOK_SECRET` |
| `request "CONTACT_EMAIL for pettycourt: …"` (M4) | a public support address | `CONTACT_EMAIL`, on the terms and privacy pages; Checkout stays off without it |
| `vercel env pettycourt STRIPE_SECRET_KEY`, `… STRIPE_WEBHOOK_SECRET`, `… CONTACT_EMAIL` (M4) | pushes those stored values to the Vercel project | the same env vars on Vercel. These lines only take effect once the requests above have stored the values |
| `request "Render free web service for pettycourt from render.yaml …"` (M4) | the commercial-use host for live payments | `scripts/serve.js` on Render, with live Stripe values and a second webhook endpoint |

Unchanged from M3 and M2:
- Reports, clicks, payments and appeals live in the same Postgres database, and deletion is a cascade.
- The card renders in the function.
- Expiry is Vercel Cron, or in-process on Render.
- There is no email service: Stripe sends the receipt, and the fake door's emails are only stored.

Optional and not provisioned:
- `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`, to swap the judge to LiteLLM, Groq or OpenRouter.
- `CRON_SECRET` on Vercel, to make `/cron/expire` accept only Vercel Cron. It's deliberately not requested: the job is harmless to trigger, and requiring a secret nobody set would silently stop expiry. On Render, `render.yaml` generates it.
- `PUBLIC_URL`, only if the app ever moves behind a domain that isn't Vercel's or `*.onrender.com`. That would need a paid domain, so not now.

## Decisions made without asking

M1:
- **Standalone, not a tiebreak mode.** The tiebreak repo isn't reachable from here and this run is scoped to pettycourt. The single `cases` table keeps a later port cheap.
- **Hono instead of Next.js.** It is a "small Node service" on the same free Vercel host. It is fully testable over `Request`/`Response`, and it can move to a commercial-use host for M4 without a rewrite. Server-rendered HTML plus ~70 lines of vanilla JS; no React.
- **Gemini's free tier through its OpenAI-compatible API is the "free model"**, and the broker can provision its key. LiteLLM still works by pointing `LLM_BASE_URL` at a proxy.
- **The deadline is a fixed 24 hours.** A late defendant may still answer while no ruling exists.
- **Anyone with the case link can call the judge** once it's allowed. Rulings are idempotent, so this can't produce a second ruling or a second model call.
- **Title is optional** and defaults to the charge. No party names in M1.
- **The defendant sees the plaintiff's testimony** before answering, which is the two-sided point of the product.
- **A model refusal is final for that case** (`declined_at`), so a serious case can't be re-rolled until the model gives in.

M2:
- **"Device" means a server-issued random cookie** (`pc_device`, HttpOnly, `Path=/jury`). There's no fingerprinting and no IP.
  - It is as strong as the roadmap asks ("one vote per device id") and no stronger: a private window or cleared cookies is a new device.
  - Votes store `sha256(caseId:deviceId)`, not the id.
- **The jury is advisory.** It doesn't feed the AI ruling, so M1's judge path, prompt and tests are unchanged, and a ruling never depends on when it was requested. The card and the page show both verdicts.
- **Votes stay open** from filing for as long as the case exists and isn't declined, before and after the ruling. M3's 30-day expiry is the natural close.
- **Jurors see the split only after they vote**, to avoid herding. Anyone with the case link sees it on the results page.
- **The results page still never shows the jury link** (as in M1). The plaintiff gets it from the filing receipt, which now says to save the links. Recovering lost links is M3's owner token.
- **Comments:**
  - optional, at most 140 characters, collapsed to one line
  - scope-screened (422 and nothing stored), shown only on the results page and the commenter's own jury page
  - never on the card and never sent to a model
- **The card shows the case in every state except declined:**
  - "Verdict pending" before the ruling
  - declined cases have no card (404), so out-of-scope content never becomes a shareable image
  - the results page shows the card preview only after the ruling, and its `og:image` tag in every non-declined state
- **The title limit stays at 120 characters.** The card copes with any length: stepped font size, line clamp, word breaking and a 300-character excerpt. The 300-character exit criterion is tested with a title written straight to the database.
- **One font family, Lora**, in four subsets: Latin, Latin Extended, Cyrillic and Vietnamese. Emoji, CJK, Arabic and others are dropped on the card rather than drawn as empty boxes. Bundling an emoji or CJK font would add megabytes to every function.
- **Card caching:**
  - a weak ETag over exactly what the card draws, with `Cache-Control: private, no-cache`
  - a 32-entry per-instance memory cache
  - no shared CDN cache, so M3's deletion takes effect on the next view

M3:
- **A report takes the case down at once,** with no threshold and no review queue. It's reversible with one SQL statement.
  - There's no moderator on a $0 test, and the PRD's bar is zero published cases about outsiders or excluded topics.
  - The parties keep their delete button.
- **Either party deletes the whole case,** not just their own part, because a trial with one side missing would misrepresent it.
- **The plaintiff token is shown once,** in the receipt and on its own page. It's never on a shared page or the card.
  - Cases filed before M3 have no plaintiff token. Only the defendant or expiry can delete those.
- **The delete credential travels in `Authorization: Bearer`,** not in the URL or body. That keeps it out of access logs and makes cross-site requests need a preflight the app never grants.
- **Expiry counts from filing** (`created_at`). It runs daily at 04:17 UTC, so a case goes on day 30 or day 31, and the pages say exactly that.
- **The expiry endpoint fails open without `CRON_SECRET`**, because it only enforces the retention policy from the server clock.
- **The fake door records the click before revealing itself,** then says plainly that nothing was charged. The email is optional, used for at most one message, deleted with the case and never logged.
- **The case page shows the unlock in every non-declined state,** before and after the ruling, to give the click rate a fair chance.
- **The report endpoint is `POST /reports` with the case id in the body,** so an M1 test that forbids any `/cases/` action on declined pages stays as it is.
- **The client script is tested in a fake DOM under `node:vm`**, built from the server's own HTML, because no DOM package could be installed here.

M4:
- **Payments are a switch, not a branch.** They need both `STRIPE_SECRET_KEY` and a valid `CONTACT_EMAIL`. Without them the app is exactly M3's fake door (its copy now promises only the appeal), so the roadmap's "only if M3 shows ≥ 2% clicks" gate is the operator flipping env vars after reading the M3 query.
- **The full trial is one appeal with new text evidence.** Photo exhibits need file storage, a new service with its own quota and key, so they're out; the fake-door copy was narrowed to match.
- **The payer files the appeal; their click id is the credential.**
  - The case link is public, so "anyone with the case link" would let a juror use up someone else's purchase.
  - Party tokens can't come back from Stripe without leaking them into a `success_url`.
  - The appellant states their side, unverified, like everything in a no-account joke court.
- **Payment only after the ruling, one appeal per case.** Checkout refuses unruled, paid or appealed cases. Two checkouts opened within the same hour can both be paid: both payments are recorded, the first appeal filed wins, and the other payer's page says they're owed a refund.
- **Accepted means stored.** If the judge fails, the appeal stays filed (`heard: false`), and an idempotent "Hear the appeal" retries. Nobody can pay or file twice by retrying.
- **A declined appeal keeps the original ruling** and hides the evidence. The keyword screen at filing refuses without using up the appeal; the model's refusal at the hearing uses it up (refund on request).
- **Fulfilment re-reads the session from Stripe** and checks `paid`, 300, `usd` and `payment` mode. It runs from both the webhook and the landing page, through one guarded SQL statement.
- **No Stripe SDK.** The npm registry isn't reachable from this sandbox, and two REST calls plus Stripe's documented manual signature check fit in one module of under 200 lines with `node:crypto`.
- **Stripe's receipt is the receipt email.** The PaymentIntent description puts the appeal link on it, so a payer who closed the tab can still file. No email service of our own (it would need a domain).
- **No case text goes to Stripe:** the product name and description are fixed, and the case is identified by id.
- **Refunds are manual,** on request within 14 days for any reason. A SQL query lists the refunds owed.
- **Render's free web service is the commercial-use host,** from `render.yaml` and `scripts/serve.js`.
  - Its terms don't bar commercial use. Vercel Hobby's do.
  - Render's cron is paid, so expiry runs in-process at boot and hourly.
  - Vercel stays the zero-config test-mode deploy.
- **402 comes before the credential check** on the appeal endpoint, because whether a case is paid is already public on its page, and the exit criterion asks for 402 on any unpaid case.
- **The card shows the final verdict after an appeal,** with "Upheld/Overturned on appeal". The case page keeps both rulings on the record.

M5:
- **M5's exit criteria are derived, not given.** The roadmap's M5 is one sentence ("run 30 real cases, apply the PRD thresholds, fold if…"). The seven criteria in the Plan turn it into what a build can prove: the decision is computed correctly and on honest numbers. The run itself is the operator's.
- **The fold rule is the roadmap's plus REVIEW.md's kill criteria:**
  - defendant response under 40%
  - paid under 2%, or no paying case at all ("fewer than 1 of 30")
  - under 25% of cases with 2+ jury votes

  Visitors per case and unlock clicks are PRD metrics with no kill rule, so they're listed as warnings and never fold on their own.
- **Safety is a gate on "continue", not a reason to fold.** A demand failure is final whatever the safety numbers say. A clean demand result with a violation, waiting rulings or rulings deleted unreviewed is `hold`. "Continue" needs the PRD's zero-violation bar verified, not assumed.
- **The cohort is every case filed:** deleted, expired, declined and taken-down cases count, because dropping them would hide the cases that went badly. `--since` (a UTC day) leaves out the operator's deploy checks. Cases refused at filing were never stored and never count.
- **30 cases decide; fewer don't.** While counted cases are still live, the decision is labelled provisional.
- **Outcomes are kept, anonymously, when a case goes.** The same `DELETE` statement writes one `case_outcomes` row:
  - a day, the outcome flags and the counts, and nothing that points back to the case
  - no foreign key, no retention limit
  - the privacy page says so, and drops its old "no analytics" line
- **Visitors are counted by the page's script, not by requests:**
  - a link preview fetches the page but runs no script, so counting requests would let bots pass the ≥ 1.0 bar on their own
  - the browser dedupes with `localStorage`, so there's no cookie and the server never receives a browser identifier, only the case id
  - the browser that filed the case, and any browser that opens the plaintiff link, is the plaintiff's and never counts
  - the counter is capped at 100 per case
- **The safety review covers every ruling until 100 are reviewed,** including appeal rulings. That's the PRD's "every ruling in the first 100" without ranking cases that no longer exist.
  - The review stores how many rulings it covered, not a time, so no clock is compared.
  - `ok` must say `--with-appeal` when there is an appeal ruling, so text the reviewer didn't read is never approved.
  - A violation takes the case down like a report, at once and reversible by SQL, with a `reports` row that says why.
- **A command line, not an admin page.** A web page would need a login and a new secret on a public app. The operator already holds `DATABASE_URL` (M3 and M4 already used `psql`). The review queue strips control and bidi characters, because it prints user and model text into a terminal.
- **The report fits 80 columns,** one metric per two lines, so it reads in a default terminal and on a phone.
- **With payments off, nobody can pay,** so the paid bar fails and the report says fold. That's the roadmap's rule taken literally: an M5 sample run with the fake door, not Checkout, folds. A run meant to test the paid bar must have live payments on (see What's left).

Go-live (search, sharing, legal pages, the Payment Link and RepoHQ's launch counts): see [LAUNCH-READY.md](LAUNCH-READY.md), which lists what was done, the decisions, how to check it and what's left for David.

## What's left

M5 was the last milestone. What's left is the run it was built for:
- **Run 30 real cases from friend groups, with live payments on.** Test-mode payments are marked paid in the database just like live ones (M4 review), so a run on Vercel with test keys would count fake money.
  - The paid bar is only meaningful on Render with live Stripe keys (Deploy, Render steps).
  - Or read a run with payments off as demand-only: with no live payments it can only ever say fold.
  - Note the first day of the run and use it as `--since`.
- **Review the rulings as they come.** Run `npm run decide -- review` every few days and answer each ruling before its case is deleted (the queue shows the day). A ruling deleted unreviewed makes the safety bar a gap, and the decision can then only say `hold`.
- **Decide.** Once 30 cases are in, and ideally once they've all closed (no longer provisional), run `npm run decide -- --since <day>`.
  - **Fold:** fold the flow into tiebreak as a mode and stop pettycourt. The tiebreak repo isn't reachable from here.
  - **Continue:** the warnings say what to watch next.
- **Check the visit beacon in real browsers,** iOS Safari in particular (storage in private tabs), with the Network tab: one `POST /visits` per browser per case, and none from the filing browser. Chromium was checked by `npm run screenshots`.

To do before real users (and before real money):
- **The pipeline and David:** the Stripe, contact and Render requests in `.provision`, then the two webhook endpoints and the receipt setting in Stripe (Deploy, M4 steps).
- **A first manual run in a real browser:**
  - forms, copy buttons and page reloads
  - the jury form: radio buttons, the comment, reload into "Your vote"
  - the card preview and download on iOS and Android
  - a link preview of the case URL in WhatsApp and iMessage
  - M3: the delete confirmation, landing on `/deleted`, the report `<details>` form, and the unlock button → email → thanks
  - M4: "Appeal the verdict · $3" → Stripe test Checkout → back to `/appeals/<id>` → the appeal form → reload into the verdict on appeal → the case page and the new card
- **On the first deploy:**
  - check that `/cases/<id>/card.png` renders (file tracing; see Review)
  - check the default model alias on the live endpoint
  - check that Vercel lists the `/cron/expire` cron job and still detects Hono with `vercel.json` present (see Deploy step 5)
  - check one test-mode payment end to end, including a 200 webhook delivery
- **On Render:**
  - check that the Blueprint boots, that `RENDER_EXTERNAL_URL` gives https links, and that the log shows expiry runs
  - make one live $3 payment, check the receipt email with the appeal link, then refund it
- **A rate limit** on filing, ruling, voting, reports, unlock clicks, checkout sessions and fresh card renders.
- **Run `npm audit`.** The installer reported advisories when the M2 packages were added. It said so again when M5 added `playwright-core` (a devDependency, used only by `npm run screenshots`). `npm audit` itself wasn't run here.
- **Delete the local `.scratch/` folder.** It holds the throwaway card-render, schema, page and CTE checks and the plan drafts from these builds. It's gitignored.

## Review

### M5 review

The M5 changes were reviewed against gstack's pre-landing checklist ("Review Categories", "Fix-First Heuristic"):
- `git status` still shows everything except README.md as untracked (no milestone has been committed), so `git diff` only covers README.md.
- So every file M5 touched was read in full:
  - `src/decide.js` (new), `src/store.js`, `src/app.js`, `src/views.js`
  - `scripts/decide.js` (new), `scripts/screenshots.mjs` (new), `package.json`, `README.md`
  - the new tests and `test/cohort.js`, plus `test/dom.js`, `test/config.test.js` and `test/legal.test.js`
- **Two M2/M3 tests changed, on purpose.** The schema-upgrade tests in `config.test.js` pin the exact list of tables after the schema script runs, and the list now includes `case_outcomes`. It's still an exact match, not loosened. The M3 test's title now says "adds no M4 table".
- `test/dom.js` gained an optional `localStorage`, and `legal.test.js` gained one test. Nothing else from M1–M4 was edited or removed.

**Pass 1 (CRITICAL): no open findings.**
- **SQL and data safety:**
  - every value is a parameter
  - the only interpolation is constant SQL built in code: the `OUTCOME` expressions, `reviewPending`, `rulingCount`, the two `WHERE` clauses passed to `deleteKeepingOutcome` and its constant `gone_by` literal
  - the test helper `kept()` interpolates constant column names
  - the schema change is `ADD COLUMN IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS` only, checked against an M4-shaped database, twice
- **Races (TOCTOU):**
  - **Delete:** deleting a case and keeping its outcome is one statement on one snapshot. A delete racing the expiry keeps one row (tested).
  - **Visits:** a visit is one `UPDATE … LEAST(visitors + 1, 100)`.
  - **`ok`:** a compare-and-set on whether there's an appeal ruling, so an appeal ruled between `review` and `ok` is refused (tested).
  - **`violation`:** first the exactly-once takedown CTE, then the review. A crash in between leaves the case down and still queued, and a retry is a no-op takedown plus the review.
- **XSS:**
  - `data-visit` goes through the escaping `html` tag and holds a regex-shaped case id; the plaintiff marker is a constant
  - the beacon writes nothing to the page
  - the privacy text is static
- **CSRF:** `POST /visits` is JSON-only (415 otherwise, tested), so a cross-site page needs a preflight the app never grants.
- **User and model output in the terminal** (the trust boundary of the review queue): `cleanText` strips control, C1 and bidi characters and collapses whitespace before anything is printed (tested with ESC, BEL, CSI, RLO/PDF and CRLF).
- **Shell injection:** the screenshot script spawns `node` with argument arrays, never a shell, and passes the child only `PATH` and its data folder.
- **Enum and value completeness:**
  - **The review results** `ok`, `names_someone` and `serious` agree across the two `CHECK`s (`cases`, `case_outcomes`), `REVIEW_RESULTS`, the command line's violation list (derived from it) and `reports.reason`. Both violation reasons are valid report reasons, and the violation test stores one.
  - **`gone_by`** has exactly two writers.
  - **The statuses:** `decide()`'s four statuses all have a report word in `STATUS_WORDS`, and the four safety statuses all have one in `SAFETY_WORDS`.
  - **The metrics:** every `THRESHOLDS` key is a column of `outcomeTotals()`, and the first test asserts the full object.

Fixed during review (Fix-First, auto-fix):
- [P3] (confidence 9/10) `src/store.js` `outcomeTotals`: violations were counted with `review IN ('names_someone', 'serious')`, a second copy of the `CHECK` list that could drift. It's now `review <> 'ok'`.
- [P3] (confidence 8/10) `scripts/decide.js` (Time Window Safety): the usage didn't say that `--since` is a UTC day, which matters for a run spanning time zones. It does now.
- [P3] (confidence 8/10) `src/views.js` privacy page: "no text, links or ids" could be read as "the row has no id at all". It now says "no text, links or ids from the case".

Fixed while building, before the review (tests added):
- [P2] (confidence 9/10) `src/store.js`: the first design re-queued a case when its appeal ruling was newer than the review, by comparing timestamps. Two rulings with the same timestamp (the frozen test clock, or two server clocks in production) let an appeal ruling escape review. It now stores how many rulings the review covered.
- [P2] (confidence 8/10) `src/decide.js`: the first report was a 115-column table, which wraps in a default 80-column terminal and on a phone (seen in the first screenshots). It's now 80 columns, tested.
- [P3] (confidence 8/10) `scripts/screenshots.mjs`: the desktop result shot didn't scroll, because the reload after "Call the judge" restored the old position. It now opens the case page fresh.

Open, informational (not blocking M5):
- [P2] (confidence 7/10) `src/app.js` `POST /visits`: anyone can send it, so a script can add up to 100 visitors to a case. That's 3.3 on the average of a 30-case run, enough to flip the visitors bar.
  - The bar is "watch" only and never folds.
  - It's the same class as the jury's cookie and the still-open rate limit.
  - If the number looks off, `SELECT visitors FROM cases ORDER BY visitors DESC` shows the outlier.
- [P2] (confidence 6/10, medium: verify in real browsers) the beacon relies on `localStorage`.
  - A browser that blocks storage sends nothing, so the metric undercounts, which is the safe direction for a threshold.
  - Safari's private tabs keep storage per tab session, so one person in several private tabs counts several times.
  - Only Chromium was checked for real (`npm run screenshots`).
- [P3] (confidence 7/10) `src/store.js` `deleteKeepingOutcome`: a vote committed after the delete statement's snapshot, but before it locks the row, is cascaded away without being counted in the kept row. That's off by one at most, in a millisecond window.
- [P3] (confidence 8/10) a plaintiff who filed on one device and opens the case page on another counts once as a visitor, unless that device opened the plaintiff link first.
- [P3] (confidence 8/10) test-mode payments count as paid, inherited from M4 (test and live aren't told apart). What's left says to run the 30 cases with live keys.
- [P3] (confidence 7/10) `case_outcomes` has no retention limit, by design: days, flags and counts, with nothing that leads back to a case. `DELETE FROM case_outcomes WHERE filed_on < '<day>'` purges it if ever wanted.
- [P3] (confidence 7/10) `scripts/decide.js` prints the driver's error message when the database fails ("decide failed: …"). `pg` errors don't contain the password, and the app's own code never prints the URL.
- [P3] (confidence 6/10) `pc_seen` is device storage used to measure audience, with no consent banner.
  - No identifier leaves the device: the server gets only the case id.
  - That keeps it close to the usual exemption for first-party, aggregate-only audience measurement (e.g. France's CNIL).
  - Revisit if EU users become a target.
- [P3] (confidence 9/10) in the screenshots the body text is monospace because this sandbox has no sans-serif system font. The CSS stack is `system-ui, -apple-system, "Segoe UI", sans-serif`, which real devices resolve normally.

### M4 review

The M4 changes were reviewed against gstack's pre-landing checklist ("Review Categories", "Fix-First Heuristic"):
- `git status` still shows everything except README.md as untracked, because no milestone has been committed, so `git diff` only covers README.md.
- So every file M4 touched was read in full:
  - `src/payments.js` (new), `src/app.js`, `src/store.js`, `src/views.js`, `src/config.js`, `src/judge.js`, `src/card.js`
  - `scripts/serve.js` (new), `scripts/dev.js`, `render.yaml` (new), `.provision`
  - the new and changed tests, and this file
- **One M1–M3 test was changed, on purpose.** In `unlock.test.js`, "the app has no payment client to call" scanned every file in `src/` for `api.stripe.com` or `checkout.session`. That encoded M3's "no payment code at all" scope, which M4's roadmap reverses.
  - It now skips `src/payments.js`, the one module that talks to Stripe, which the app only reaches through the injected `payments` dependency. Its `package.json` check is unchanged: no payment SDK.
  - A new test next to it proves the M3 exit criterion behaviourally with payments switched on: the unlock click stores one row and calls neither the Stripe client nor `fetch`.
  - Nothing else from M1–M3 was edited or removed. `helpers.js`, `config.test.js`, `client.test.js` and `e2e.test.js` only gained code.

**Pass 1 (CRITICAL): no open findings.**
- **SQL and data safety:**
  - every new query is parameterised
  - the only interpolation is still constant column lists (`COLUMNS`, and now `CLICK_COLUMNS`)
  - the schema upgrade is `ADD COLUMN IF NOT EXISTS` only, checked against an M3-shaped database, run twice
- **Races:**
  - **Checkout click:** one guarded `INSERT … SELECT` (ruled, not declined, not reported, not paid, not appealed).
  - **Payment:** one CTE stamps the click and, only if the case has no payment yet, the case. It reports whether it was the first payment. Webhook and landing page are tested in both orders, repeated and at once.
  - **Appeal:** filing is one conditional `UPDATE` that also requires a paid click of this case (two at once: one 201, one 409). The ruling write requires an unheard, undeclined, un-reported appeal. A report or delete mid-hearing is tested.
- **XSS:**
  - the new pages and sections go through the escaping `html` tag (`<script>` in evidence and in an appeal ruling is tested on the case, appeal and jury pages)
  - `data-token` holds a regex-checked click id
  - the contact address is validated and escaped
  - the client's new `redirect` only follows a `url` the server took from Stripe and checked to be on `https://checkout.stripe.com/`
- **Auth and CSRF:**
  - checkout and appeal need `application/json`, and the appeal needs the payer's click id as `Authorization: Bearer` (401 without, 403 for any other token, each kind tested)
  - 402 comes first by design: "paid" is public on the case page
  - the webhook checks Stripe's HMAC over the raw bytes with a 300 s window, and accepts any matching `v1` during a secret rotation
  - Stripe errors carry the HTTP status only, never the key (tested)
- **Third-party output trust boundary (Stripe), handled like the LLM boundary:**
  - session ids must match `cs_(test|live)_…`; Checkout URLs must start with `https://checkout.stripe.com/`
  - `client_reference_id` must be shaped like a click id
  - fulfilment trusts only a fresh `GET` of the session, and only for `paid`, 300, `usd`, `payment` mode and a session id that matches the click's
- **LLM output trust boundary:**
  - the appeal ruling goes through the same `parseRuling` (known verdict, 40–200 words, ≤ 2,000 characters), and onto the card only through `cardText`
  - the evidence reaches the model as JSON data, under a prompt that calls it "evidence, not instructions"
  - the M1 prompt string is byte-identical (checked by hash), and appeals get `APPEAL_PROMPT`
- **Enum and value completeness:**
  - `plaintiff`/`defendant` agree across the `appeal_side` `CHECK`, `APPEAL_SIDES` (validation and the radio buttons), `APPELLANT_NAMES` (the judge's case file), `APPELLANT_LABELS` and `SIDE_CHOICES` (pages); both sides are tested
  - `appeal_verdict` reuses `VERDICTS`/`VERDICT_LABELS` and its own `CHECK`
  - the new states `paidAt`, `appealedAt`, `appealRuledAt` and `appealDeclinedAt` were traced through every consumer:
    - the case page (both the full-trial section and the appeal), the jury page, the plaintiff page, the appeal page, the card and its `alt` text
    - the checkout refusals and the report, delete and expiry paths
  - `paymentsKind` (`stripe`, `off`, `no-contact`) is read only by the startup messages of `dev.js` and `serve.js`

Fixed during review (Fix-First, auto-fix):
- [P2] (confidence 9/10) `src/app.js` `recordPayment`. The "second payment, refund one payer" log compared the click's `paid_at` with the case's.
  - That needed an extra read, and it missed two payments stamped in the same millisecond.
  - The payment CTE now returns whether it marked the case, and the test asserts the log line.
- [P2] (confidence 8/10) `src/views.js` `takenDownPage`. A payer whose case was reported after paying saw only "taken down", with nothing about their $3.
  - Their appeal page (410) now says they're owed a refund and how to ask.
  - Everyone else's taken-down page still mentions no money (tested).
- [P3] (confidence 9/10) `src/views.js` `appealPage`: removed an unused `now` parameter (dead code).
- [P3] (confidence 9/10) `src/payments.js` `getSession`: removed a `livemode` field nothing read.
- [P3] (confidence 9/10) `src/app.js`: fixed a stale comment on `whyNoCheckout` that said it returns null.

Open, informational (not blocking M4):
- [P2] (confidence 7/10, medium: verify on first deploy) `render.yaml`, `scripts/serve.js`. Render couldn't be reached from here, so the Blueprint fields (`runtime`, `plan`, `buildCommand`, `envVars`, `generateValue`) and the Node version pick-up from `engines.node` are untested against Render itself.
  - A sleeping free instance takes 30–60 s to wake, which can exceed Stripe's webhook timeout. Stripe then retries (for up to 3 days), and the landing page fulfils anyway.
- [P2] (confidence 8/10) `src/app.js`: still no rate limit, now also on checkout. A script with a case link can create many Checkout Sessions, which inflates the click count and spends Stripe API calls (no money).
  - The paid count is unaffected.
  - Same fix as before: a per-IP limit via a Vercel Firewall rule or a Postgres counter.
- [P2] (confidence 7/10) `src/app.js`: the payer's filing and someone pressing "Hear the appeal" at the same moment can both call the model.
  - One ruling is stored; the cost is one extra free-tier call.
  - Same as M1's `/rule`. A `hearing_started_at` lease would stop it.
- [P2] (confidence 6/10) Live keys on Vercel Hobby aren't prevented, because the plan can't be detected from the app. `.provision`, Deploy and `render.yaml` say live keys go to Render only.
- [P3] (confidence 8/10) Stripe's receipt email is the payer's way back if they closed the tab. Test mode only sends receipts to verified addresses, so it's checked with "Send test receipt" or the live $3 run (What's left).
- [P3] (confidence 8/10) The appeal link (the click id) reaches Stripe (return URL, receipt description) and the payer's inbox. Anyone the payer forwards the receipt to can file the appeal. That's by design: whoever holds the purchase link owns it.
- [P3] (confidence 7/10) The summons page says "the court has already ruled" without mentioning an appeal; it links to the case page, which shows it. The plaintiff page shows the verdict on appeal once it's heard, not a pending or declined appeal.
- [P3] (confidence 8/10) Refunds are manual: the SQL query under "Run it locally", then the Stripe dashboard. A payment for a case deleted before fulfilment is only in the log line and in Stripe.
- [P3] (confidence 7/10) Test-mode and live payments aren't told apart in the database. Switching keys mid-window mixes them in the funnel query until expiry clears the test ones (30 days).
- [P3] (confidence 6/10) The Stripe API version isn't pinned, so the account's default renders sessions and events. The fields used (`id`, `url`, `payment_status`, `mode`, `amount_total`, `currency`, `client_reference_id`, `metadata`) are stable across versions.
- [P3] (confidence 7/10) A case paid on day 29 is deleted with its appeal on day 30 or 31. The pages show the deletion date and the terms promise refunds on request; checkout doesn't refuse old cases.

### M3 review

The M3 changes were reviewed against gstack's pre-landing checklist ("Review Categories", "Fix-First Heuristic"):
- `git status` shows everything except README.md as untracked, because M1 and M2 haven't been committed, so `git diff` only covers README.md.
- So every file M3 touched was read in full: `src/app.js`, `src/store.js`, `src/views.js`, `src/config.js`, `scripts/dev.js`, `vercel.json`, the new and changed tests, and this file.
- No existing M1/M2 test was edited or removed. `test/helpers.js`, `test/config.test.js` and `test/e2e.test.js` only gained code.

**Pass 1 (CRITICAL): no open findings.**
- **SQL and data safety:**
  - every new query is parameterised
  - the only interpolation in `src/` is still the constant column list
  - the test helper `rowsFor` interpolates table names from a constant list, in test code only
- **Races (TOCTOU):**
  - delete is one `DELETE … RETURNING`; simultaneous deletes by both parties are tested
  - a takedown and its report row are one CTE statement; simultaneous reports are tested
  - an unlock click is one guarded `INSERT … SELECT`
  - the testimony, vote and ruling writes now also require `reported_at IS NULL`, and a report landing mid-deliberation is tested
  - the lost-race re-reads in vote and rule answer 404 when the case was deleted in the meantime; before, they would have said "already voted" or "the defendant just answered"
- **XSS:**
  - every new page and component goes through the escaping `html` tag
  - `data-token` holds a base64url token, the hidden `caseId` is escaped, and the report labels are constants
  - the client script only sets `value`, `href`, `hidden`, `disabled` and `textContent`
- **Auth and CSRF:**
  - delete needs `Authorization: Bearer`, which a cross-site page can't send without a CORS preflight the app never grants
  - every new `POST` needs `application/json` (415 otherwise, tested)
  - the jury token, near misses and other cases' tokens can't delete (tested)
  - a missing header gives 401 before any lookup, so it says nothing about whether a case exists
  - `CRON_SECRET` is compared with `timingSafeEqual` on digests
- **LLM trust boundary:** unchanged. M3 adds no model call, and nothing new reaches the judge.
- **Enum and value completeness:**
  - `names_someone`, `serious`, `mean` and `other` agree across the `reports` `CHECK`, `REPORT_REASONS` (validation), `REPORT_LABELS` and the form's radio buttons (each tested)
  - the new `reportedAt` state was traced through every consumer of `declinedAt` (the summons, case, card, jury, vote, testimony, rule, unlock and plaintiff routes, and the testimony, vote, ruling and click writes). The views never receive a taken-down case, because every route returns before rendering one.

Fixed during review (Fix-First, auto-fix):
- [P2] (confidence 9/10) `src/views.js` — **Time Window Safety.**
  - The pages promised deletion "on 2026-12-01" (filing day plus 30). But the cron runs once a day at 04:17 UTC, so a case filed after 04:17 actually goes the next day.
  - The pages now say "on <date> or the day after".
  - A test checks the promise against the `vercel.json` schedule: the run on day 30 keeps a case filed at 12:00, and the run on day 31 deletes it.
- [P3] (confidence 9/10) `test/dom.js` — removed an unused `click` helper (dead code).

Open, informational (not blocking M3):
- [P2] (confidence 8/10) `src/app.js` `POST /reports` — anyone with a case, jury or summons link can take a case down with one report.
  - This is by design (see Decisions), and it's reversible by SQL.
  - If griefing shows up in the M5 sample, the fix is a threshold of two distinct devices, or a takedown limited to the card and `og:image`.
- [P2] (confidence 8/10) `src/app.js` — still no rate limit. A script can now also flood reports (one row per case, then no-ops) and unlock clicks.
  - Clicks only matter for the M4 gate, which counts *cases* with a click, and a script can only click cases it has links to.
  - Same fix as M1/M2: a per-IP limit through a Vercel Firewall rule or a Postgres counter.
- [P2] (confidence 6/10, medium: verify on first deploy) `vercel.json` — the repo now has a `vercel.json`.
  - It only holds `crons`, which shouldn't change Vercel's zero-config Hono detection, but that couldn't be checked without deploying.
  - Fallback: set Framework Preset to "Hono" in Project Settings (Deploy step 5).
- [P3] (confidence 7/10) `src/store.js` — a vote or unlock click inserted at the same moment the case is deleted can fail the foreign-key check. That gives a logged 500 with nothing stored. It's harmless; mapping Postgres error `23503` to 404 would tidy it.
- [P3] (confidence 8/10) `src/app.js` — the unlock email step still accepts an email for a click whose case was taken down after the click. The email is deleted with the case either way.
- [P3] (confidence 9/10) — deletion can't reach copies outside the app: a downloaded card, or a chat app's cached link preview. `/deleted` says so.
- [P3] (confidence 7/10) `src/app.js` — the operator's only notification of a report is one log line (`case <id> taken down after a report (<reason>)`), and Hobby keeps runtime logs briefly. Check the reports query under "Run it locally" during the M5 run.
- [P3] (confidence 8/10) — a case can outlive day 30 by up to a day, until the next cron run. There's no read-side hiding in between, and the pages state the real window.
- [P3] (confidence 9/10) — the client script is tested in a fake DOM, not a browser; see "What's left".

### M2 review

The M2 changes were reviewed against gstack's pre-landing checklist ("Review Categories", "Fix-First Heuristic"):
- Everything except README.md is still untracked: M1 hasn't been committed, so `git diff` shows only README.md.
- So every file M2 touched was read in full: `src/app.js`, `src/store.js`, `src/views.js`, `src/judge.js`, `src/card.js`, the tests, `package.json` and this file.

**Pass 1 (CRITICAL): no open findings.**
- **SQL and data safety:**
  - the five new queries are parameterised
  - the only interpolation is still M1's constant column list
  - `castVote` casts its parameters (`$2::text`, `$5::timestamptz`) so the `INSERT … SELECT` types are explicit on `pg` and PGlite alike
- **Races:**
  - one vote per device is a single `INSERT … SELECT … WHERE declined_at IS NULL ON CONFLICT (case_id, voter) DO NOTHING RETURNING` on the composite primary key, with no read-then-write
  - concurrent duplicates are tested
  - a decline landing mid-vote is caught by the same statement and reported as closed
- **XSS:**
  - the jury page, comments, `og:` meta and the card `alt` all go through the escaping `html` tag (tested with `<script>` in the case file and a comment)
  - the card takes user and model text only as element-tree text children: no `dangerouslySetInnerHTML`, `<style>`, `<img>` or URLs from input
  - the client JS change is one `location.reload()`
- **Cookie and CSRF:**
  - `pc_device` is HttpOnly, `SameSite=Lax`, `Path=/jury`, and `Secure` on https
  - the vote API needs `application/json`, so a cross-site form can't post, and a cross-site `fetch` needs a CORS preflight that the app never grants
- **LLM output trust boundary:**
  - the ruling reaches the card only through `cardText` (NFC, control and format characters stripped, length-capped)
  - it is never used as a URL or markup
- **Enum completeness:**
  - `guilty` and `not_guilty` for jurors agree across the `votes` `CHECK`, `JURY_VOTES` (validation), the two radio buttons, `VERDICT_LABELS` (comments, "Your vote") and the `getJury` `FILTER` counts
  - the judge's labels moved to `judge.js` beside `VERDICTS`, so the page and the card share one copy (`declined` is never labelled, as before)

Fixed during review (Fix-First, auto-fix):
- [P2] (confidence 8/10) `src/app.js` — card CPU. A card shared in a group chat was re-rendered (~150 ms) for every first-time viewer and link-preview bot, because only browsers that already had the ETag got a 304. Added a 32-entry per-instance cache keyed by ETag; failures aren't cached. Tests added for render-once, eviction and a failure that isn't cached.
- [P3] (confidence 9/10) `src/card.js` — the first design drew the ruling on 6 lines, which cut typical 60–120-word rulings mid-sentence while leaving space empty. It now uses 7 lines and a 420-character excerpt. Checked by eye against the worst case: 300-character title, 280-character charge and 200-word ruling.

Open, informational (not blocking M2):
- [P2] (confidence 6/10, medium: verify on first deploy) `src/card.js`:
  - the wasm, fonts and `unicode.json` are read at runtime through `createRequire(import.meta.url)` with static specifiers, which Vercel's tracer (`@vercel/nft`) follows
  - this couldn't be checked without deploying
  - if the card returns 500 with `ENOENT`, the fallback is to copy the 8 `.woff2` files, `unicode.json` and `index_bg.wasm` into `src/assets/` and read them with `new URL('./assets/…', import.meta.url)`, which the tracer always includes
  - only the card route is affected
- [P2] (confidence 8/10) `src/app.js` — one vote per device is a cookie, so a private window or cleared cookies votes again, and a script can stuff votes. That's what the roadmap specifies. The fix is the same per-IP rate limit M1 still needs (Vercel Firewall rule or a Postgres counter), plus a per-case cap if stuffing shows up in the M5 sample.
- [P2] (confidence 7/10) `src/app.js` — each vote changes the card's ETag. A vote loop plus card fetches can force a fresh render (~150 ms of CPU) per request and eat into Hobby's monthly CPU allowance. The cost stays $0, and when the allowance runs out Hobby stops serving instead of billing. The fix is the same rate limit.
- [P3] (confidence 9/10) — the plaintiff and defendant can vote in their own case's jury, because there are no accounts. It's one vote each per device; the M5 sample will show whether it matters.
- [P3] (confidence 8/10) `src/views.js` — comments are moderated only by the keyword screen until M3's report link. They aren't on the card, and they're limited to 140 characters.
- [P3] (confidence 7/10) `src/app.js` — Hono's `secureHeaders` sends `Cross-Origin-Resource-Policy: same-origin` on `card.png`, so other websites can't hot-link the image in an `<img>`. Chat apps fetch previews server-side, so they're unaffected. Relax it for the card route only if embedding elsewhere is ever wanted.
- [P3] (confidence 9/10) `src/card.js` — emoji, CJK and right-to-left scripts are dropped on the card, so an all-emoji title becomes "Untitled case". This is by design (see Decisions); the pages are unaffected.
- [P3] (confidence 9/10) — how the card looks was checked only by eye on PNGs rendered in this sandbox, and the jury form hasn't run in a real browser (see "What's left").

### M1 review

The diff was reviewed against gstack's pre-landing checklist: `git status` shows only new files, which were read in full.

**Pass 1 (CRITICAL): no open findings.**
- **SQL:** every query is parameterised. The only template interpolation is the constant column list. The schema lock id is a literal.
- **Races:**
  - defendant testimony, ruling and decline are each a single conditional `UPDATE … RETURNING`
  - tokens have UNIQUE indexes
  - the two lost-race paths of rule are tested
- **XSS:**
  - every user and model string goes through Hono's escaping `html` tag, and `raw` is never used
  - client JS writes only `textContent` and `value`
  - CSP is `default-src 'self'` with no inline script or style
- **LLM trust boundary:**
  - model output must be a JSON object with a known verdict and a 40–200 word, ≤ 2,000-character ruling, or nothing is stored
  - it is only ever rendered escaped and never fed back to a model or used as a URL
- **Enum completeness:** `guilty`, `not_guilty` and `split` agree across the prompt, `VERDICTS`, the DB `CHECK` constraint and the page labels. `declined` is handled in the parser and the app.

Fixed during review (Fix-First, auto-fix):
- [P3] (confidence 9/10) `src/app.js` — a late answer on a declined case said "the court has already ruled". It now says the court declined; test added.
- [P2] (confidence 8/10) `src/views.js` — the summons page didn't tell the defendant their text goes to Google's free tier. Disclosure and the 18+ notice added.
- [P2] (confidence 9/10) `test/rule.test.js` — the lost-race branches of rule had no tests. Two deterministic race tests added.

Open, informational (not blocking M1):
- [P2] (confidence 8/10) `src/app.js` — no rate limit on `POST /cases` or `/rule`. A script can file, answer and rule in a loop and burn the free Gemini quota. The cost stays $0, but rulings stop until the quota resets. Add a per-IP limit (Vercel Firewall rule, or a counter in Postgres) before sharing widely.
- [P2] (confidence 7/10) `src/app.js` — two simultaneous rule calls can both call the model. Only one ruling is stored, but it costs an extra free-tier call. A `judging_started_at` lease would stop it.
- [P2] (confidence 6/10, medium: verify on first deploy) `src/judge.js` — the default model `gemini-flash-lite-latest` couldn't be verified against the live OpenAI-compatible endpoint from this sandbox (no network key). If it 404s, every ruling is a 502. The fix is one env var (`LLM_MODEL`), described under Deploy.
- [P3] (confidence 8/10) `src/scope.js`:
  - the keyword screen is a precision-first heuristic: easy to evade, with some false positives (a harmless "rent" or "loan")
  - the model's refusal is the second line, and M3's report link is the third
- [P3] (confidence 7/10) `src/config.js`:
  - on Vercel Fluid, idle `pg` connections can outlive a suspended instance
  - the 10 s idle timeout and Neon's pooled URL make that acceptable for a test
  - `attachDatabasePool` from `@vercel/functions` is the upgrade if Neon connection limits show up
- [P3] (confidence 7/10) `src/app.js` — `onError` answers JSON even for HTML page routes, so a database outage shows a JSON error in the browser.
- [P3] (confidence 9/10) — summons tokens travel in URL paths, so they appear in Vercel request logs. That's normal for capability links; M3 deletion removes the case behind them.
- [P3] (confidence 9/10) — the browser-side JS hasn't run in a real browser; see "What's left".

## M4 plan (done, kept for reference)

### Milestone 4 of 5: Payments and appeal

M1, M2 and M3 are built and their 347 tests keep passing. This plan applies gstack's Step 0: Scope Challenge, 1. Architecture review and 3. Test review to M4. The build is non-interactive, so each question is answered here and the answer is final.
- There is no REVENUE.md. The PRD's paid unlock ($3) is the only revenue line, so M4 builds what charging needs: Checkout, the receipt, and the terms and privacy pages with a refund policy and a contact.
- The roadmap gates M4 on M3 showing ≥ 2% unlock clicks. This is an MVP run, so there's no live data yet. M4 is built behind configuration: until `STRIPE_SECRET_KEY` (and `CONTACT_EMAIL`) are set, the app keeps M3's fake door exactly as it was. The gate becomes a switch the operator flips after reading the M3 query, not a code change.

#### Step 0: Scope Challenge

1. **What existing code already solves part of this?**
   - **The unlock click.** `unlock_clicks` already records intent per case. In M4 every checkout attempt is one click row, which gains its Stripe session id and `paid_at`. So "clicked" and "paid" are the same table, and the M5 conversion query is one `FILTER`.
   - **Click ids are tokens.** A click id is 24 random bytes, which makes it a capability. The payer's click id becomes the appeal credential: Stripe returns the payer to `/appeals/<clickId>`, and the receipt email carries the same link.
   - **The judge.** `createJudge`, `parseRuling` and the `/rule` flow are reused for the appeal:
     - an appeal case file is the M1 case file plus an `appeal` object
     - the appeal prompt is the M1 prompt plus three rules; the M1 prompt string is unchanged
   - **The once-only pattern.** M1's "conditional `UPDATE … RETURNING`, then re-read to explain a miss" covers filing an appeal, storing its ruling and marking a case paid.
   - **Deletion and expiry come for free.** Every new value is a column on `cases` or `unlock_clicks`, so delete, expiry and reports cover it with no new code. M3's tests pin the table list (`config.test.js`), which also rules out a new table.
   - **The client script.** Its `data-api`/`data-token` handler already sends a bearer token with a JSON body. It gains one option, `data-then="redirect"`, to go to Checkout.
2. **Minimum set of changes for M4's exit criteria and deliverables:**
   - **Stripe Checkout.** `POST /cases/:id/checkout` records a click and creates a hosted Checkout Session for $3, then the browser goes to Stripe. It's offered only on a ruled case that isn't paid or appealed yet, because there's nothing to appeal before the ruling.
   - **Marking paid.** One idempotent `fulfil(sessionId)` is called from two places, the webhook (`POST /stripe/webhook`, signature-checked) and the landing page (`GET /appeals/:clickId`). It re-reads the session from Stripe and checks it's paid, $3.00 and USD. Then one statement stamps the click and the case.
   - **One appeal with new evidence.** `POST /cases/:id/appeal` takes `Authorization: Bearer <paid click id>` and `{ side, evidence }`. It's 402 when the case isn't paid. The first appeal is accepted (201) and heard at once; any later one is 409.
     - `POST /cases/:id/appeal/rule` retries the hearing when the judge was down. It's idempotent, like `/rule`.
     - The case page, the jury page and the card show the final verdict and say whether it was upheld or overturned.
   - **Receipt email.** Stripe sends it (Customer emails → Successful payments). The PaymentIntent description is printed on the receipt and carries the appeal link, so a payer who closed the tab still has a way back.
   - **Commercial-use host.** `scripts/serve.js` is a production Node entry, with `render.yaml` for Render's free web service.
     - The 30-day expiry runs in-process there, at boot and then hourly, because Render's cron is paid.
     - `PUBLIC_URL` (or Render's own `RENDER_EXTERNAL_URL`) gives the https origin behind Render's TLS proxy.
   - **Legal pages.** `/terms` and `/privacy`, linked from every footer and from the checkout:
     - what $3 buys, refunds on request within 14 days, Stripe and Google as processors, what is stored and for how long
     - `CONTACT_EMAIL`, which payments require
   - **Deliberately not in M4:**
     - **No image exhibits.** They need file storage, a new paid-or-quota service. The "new evidence" is text, up to 1,000 characters, and the unlock copy now promises only the appeal.
     - **No automatic refunds or refund UI.** Refunds are on request and done in the Stripe dashboard. The cases owed one are listed by SQL (under "Run it locally"): two payments on one case, a declined appeal, a takedown after paying.
     - **No email service of our own.** Stripe's receipt is the email, since a sender of our own would need a domain.
     - **No Stripe SDK.** The npm registry isn't reachable from this sandbox, and two REST calls plus a 20-line signature check don't need one.
     - **No live keys on Vercel Hobby.** Hobby is non-commercial. Test mode isn't commerce, so the test-mode run can stay on Vercel; live keys go only to the Render service (Deploy).
     - **No second appeal, no appeal of an appeal, no editing an appeal.**
     - **No accounts.** The payer's link is the credential.
     - **No payment before the ruling.** Before the ruling the page explains the appeal and has no button.
     - **No live-mode metrics split.** Test-mode clicks count until the keys switch to live, and expiry clears them within 30 days.
     - **No rate limit**, still open from M1–M3.
3. **Complexity check:**
   - Source files:
     - `src/app.js`, `src/store.js`, `src/views.js`, `src/config.js`, `src/judge.js`, `src/card.js`
     - one new module, `src/payments.js`
     - one new script, `scripts/serve.js`, plus `scripts/dev.js`
     - one new deploy file, `render.yaml`, plus `.provision`
   - That's 11 files, over the 8-file smell. Each one is one deliverable's seam, though: the appeal touches the judge and the card, and the host needs an entry and a blueprint.
   - Most of the rest are tests:
     - new: `payments`, `checkout`, `appeal`, `legal`, `serve`, and a fake Stripe
     - extended: `helpers`, `client`, `e2e`, `config` and `unlock`
   - New services: one, the Stripe client, which is a function bundle like `createJudge`. There are no new classes.
   - New schema: 9 columns on `cases` and 2 on `unlock_clicks`, all nullable and added by `ADD COLUMN IF NOT EXISTS`. There are no new tables.
   - Proceeding as planned: dropping any file would drop a deliverable.
4. **Search check** (WebSearch was available):
   - **Fulfilment [Layer 1].** Stripe's "Fulfill orders" guide says to fulfil from both the webhook (required, because customers can close the tab) and the landing page (recommended, because it's immediate), through one function that re-retrieves the session, checks `payment_status`, and is safe to run twice at once. That is `fulfil()`. A `UNIQUE` session id plus `… WHERE paid_at IS NULL` makes it idempotent.
   - **Webhook signatures [Layer 1].** Stripe documents manual verification:
     - HMAC-SHA256 over `${t}.${rawBody}` with the endpoint secret, compared to every `v1=` value (several during secret rotation; `v0` is ignored)
     - reject anything older than 300 s
     - footgun: it must be the raw bytes, so the route reads `arrayBuffer()` before any JSON parsing, and an e2e test sends a signed event through the real Node adapter
   - **Receipts [Layer 1].** Stripe-hosted Checkout sends a receipt when Customer emails → Successful payments is on. `payment_intent_data.description` is printed on it. Test mode doesn't send receipts to arbitrary addresses, so the receipt can only be checked in live mode or with "Send test receipt".
   - **Free commercial host.** Render's terms (July 2026) set no non-commercial limit on free instances. Vercel Hobby is "non-commercial personal use only".
     - Render's docs say free instances aren't for production: they sleep after 15 idle minutes and wake on the next request (about 30–60 s).
     - Cron jobs aren't free on Render.
   - **[EUREKA, small] Expiry on a host that sleeps.** A daily cron would be the usual answer, but Render charges for cron. A sleeping instance serves nothing, so the only moment stale data could be read is right after it wakes. Running the job at boot and then hourly covers exactly that, for $0. Vercel keeps its daily cron.
   - **Hono built-ins.** `c.req.arrayBuffer()` for the raw body and `bodyLimit` per route (64 KB for the webhook, 16 KB elsewhere). No new middleware.
5. **TODOS cross-reference:** there is no TODOS.md.
   - The rate limit stays open, and M4 adds checkout creation to its list.
   - M3's "privacy and terms pages before money" is done here.
   - New TODO: one real test-mode payment on the deployed site, then one live $3 payment on Render with a refund (both under "What's left").
6. **Completeness check:** each path is built in full:
   - **Checkout:** every refusal (404/409/415/503), Stripe down or answering with a non-Stripe URL (502), the exact request sent (amount, currency, `client_reference_id`, URLs, receipt description, idempotency key, no case text sent to Stripe).
   - **Fulfilment:** webhook and landing page, in either order, repeated, at the same time; unpaid, wrong amount or currency, unknown click, deleted case, a second payer on the same case; signature missing, tampered, stale, from another secret, rotated; unrelated event types; webhook secret unset.
   - **Appeal:** 401/402/403/404/409/400/413/415/422; the judge down (accepted, then the retry); a malformed reply; the model declining; a report or delete mid-appeal; simultaneous appeals.
   - **Display:** the case page, the jury page, the appellant page in each state, the plaintiff page and the card. HTML is escaped in the evidence and the appeal ruling.
   - **Host:** `serve.js` boots, serves, expires at boot, and uses the https public origin; the `render.yaml` content.
   - **Legal:** both pages, the footer links, the contact present or missing.
7. **Distribution check:** still one web app. There are now two deploy targets from the same code: Vercel (zero-config, as before) and Render (`render.yaml`, `node scripts/serve.js`). No new packages.

#### 1. Architecture review

```
 case page (ruled, unpaid, payments on) ── [Appeal the verdict · $3] ─▶ POST /cases/:id/checkout {}
     INSERT unlock_clicks (id = clickId)  WHERE ruled, not declined/reported/paid/appealed   (the click metric)
     Stripe POST /v1/checkout/sessions  (Idempotency-Key = clickId)
        $3.00 usd · client_reference_id = clickId · metadata[case_id]
        success_url = <origin>/appeals/<clickId> · cancel_url = <origin>/cases/<id>
        payment_intent_data[description] = "… your appeal: <origin>/appeals/<clickId>"  (printed on the receipt)
     UPDATE unlock_clicks SET checkout_session_id   → 200 { clickId, url }  → browser goes to checkout.stripe.com

 payer pays ──┬─▶ Stripe redirects ─▶ GET /appeals/:clickId ──────────────┐
              └─▶ Stripe POST /stripe/webhook (Stripe-Signature, raw body) ┤ (either order, repeated, at once)
                                                                           ▼
     fulfil(sessionId): GET /v1/checkout/sessions/:id → paid · 300 · usd · mode payment · client_reference_id
       WITH paid AS (UPDATE unlock_clicks SET paid_at … WHERE id = clickId AND paid_at IS NULL)
            UPDATE cases SET paid_at … WHERE id = paid.case_id AND paid_at IS NULL     (once, atomically)

 /appeals/:clickId (the payer's page) ── [File the appeal] ─▶ POST /cases/:id/appeal  Bearer <clickId>
     404 no case · 409 taken down / declined / not ruled · 402 unpaid · 401 no bearer · 403 not a paid click of this case
     · 409 already appealed · 400 side/evidence · 422 out of scope (nothing stored, appeal still available)
     UPDATE cases SET appeal_* WHERE appealed_at IS NULL AND paid … → 201 accepted, else 409
     hear: judge(caseFile + appeal) → parseRuling → UPDATE … WHERE appeal_ruled_at IS NULL
        judge down → still 201 { heard: false }; [Hear the appeal] ─▶ POST /cases/:id/appeal/rule (idempotent)
        model declines → appeal_declined_at; the original ruling stands, evidence hidden

 case page · jury page · card: the final verdict, "Upheld on appeal" / "Overturned on appeal"
```

Data (added to the same advisory-locked schema script):

```
cases         + paid_at            timestamptz       (first payment; a case has at most one appeal)
              + appeal_click_id    text              (which payer filed it)
              + appeal_side        text CHECK (plaintiff | defendant)
              + appeal_evidence    text
              + appealed_at        timestamptz
              + appeal_verdict     text CHECK (guilty | not_guilty | split)
              + appeal_ruling      text
              + appeal_ruled_at    timestamptz
              + appeal_declined_at timestamptz
unlock_clicks + checkout_session_id text UNIQUE      (one row per checkout attempt)
              + paid_at            timestamptz
```

Design decisions:
- **The payer files the appeal, with their click id as the credential.** The case link is public, so "anyone with the case link" would let a juror use up an appeal someone else paid for. The party tokens can't come back from Stripe, because a plaintiff token in a `success_url` would leak to the processor. The click id is minted for this purchase and seen only by the payer's browser, Stripe and the payer's receipt.
- **The appellant says which side they are.** The judge needs to know whose evidence it is. It's unverified, like everything else in a no-account joke court.
- **Payment opens only after the ruling and only once per case.** A pre-ruling payment could be stranded by a decline. Checkout refuses a case that's already paid. Two checkouts opened in the same hour can both be paid: both are recorded, the first appeal wins, and the other payer is told on their page that they're owed a refund.
- **Accepted means stored.** If the judge is down, the appeal stays filed and the 201 says `heard: false`. A "Hear the appeal" button (anyone can press it) retries without being able to charge or file twice.
- **A declined appeal keeps the original ruling** and hides the new evidence from public pages. Marking the whole case declined would retroactively hide a jury and a card that broke no rule.
- **`fulfil()` trusts only what it re-reads from Stripe**, never the webhook body beyond its id, and it checks amount, currency and mode, so a misconfigured session can't buy an appeal.
- **The landing page fulfils on GET.** That's Stripe's documented pattern. It's idempotent and needs a click id that only the payer has.
- **Stripe's output is a trust boundary**, like the model's: the session id must look like `cs_…` and the URL must be on `https://checkout.stripe.com/` before the browser is sent there.
- **No case text goes to Stripe.** The product name and description are fixed strings, plus the case id in metadata.
- **402 comes before any credential check** on the appeal endpoint. "Unpaid" is already public on the case page, and that's the exit criterion.

Realistic production failures:
| Codepath | Failure | Handled |
|---|---|---|
| checkout | Stripe is down or the key is wrong | 502 with "try again"; the click row stays (intent is still intent); the key never appears in logs or errors |
| checkout | the session is created but storing its id fails | `client_reference_id` is the click id, so `fulfil()` finds the click anyway and stores the session id then |
| fulfil | the payer closes the tab before the redirect | the webhook marks it paid; the receipt email has the appeal link |
| fulfil | the webhook arrives before, after or during the landing page, or twice | one guarded statement; tested in each order and at the same time |
| fulfil | the webhook secret isn't set yet | the webhook answers 503 (Stripe retries for 3 days); the landing page still fulfils |
| fulfil | the case is deleted or expires between payment and fulfilment | nothing to mark; logged as "refund session …"; the webhook answers 200 so Stripe stops retrying |
| appeal | Gemini's free quota is out mid-appeal | the appeal is stored, `heard: false`, and "Hear the appeal" retries later |
| appeal | the case is reported or deleted mid-hearing | the ruling write requires `reported_at IS NULL` and a live row; the re-read answers 409 or 404 |
| host | Render's instance sleeps for days | expiry runs at boot, before the first page is shown, and then hourly |
| host | links and cookies come out `http://` behind Render's TLS proxy | `PUBLIC_URL`/`RENDER_EXTERNAL_URL` sets the origin, and `Secure` follows it |
| host | live keys end up on Vercel Hobby | documented, not enforced (the plan can't be detected); `.provision` asks for test keys there and live keys only on Render |

#### 3. Test review

Same harness: `app.request` against in-memory PGlite, the fake clock, the mocked judge, and now a fake Stripe (`test/stripe.js`). It's a `fetch` that implements the two Checkout Session endpoints the way Stripe's test mode answers (`cs_test_…`, `livemode: false`, idempotency keys). It can "pay" a session the way a test card would and sign events with a test webhook secret built at runtime. Nothing reaches the network.

| Exit criterion | Test file | Tests |
|---|---|---|
| A test-mode checkout marks the case paid | `test/checkout.test.js` | a ruled case → checkout creates a test-mode session for $3.00 USD, `client_reference_id` = click id and success URL `/appeals/<clickId>`; the case isn't paid until Stripe completes the session; then the signed `checkout.session.completed` webhook marks the click and the case paid. The same through the landing page alone, and through both in either order and at the same time (one `paid_at`) |
| An appeal is accepted once and rejected (409) the second time | `test/checkout.test.js` | on that paid case the payer's appeal is 201 and is heard (the judge gets the original ruling and the new evidence; the appeal verdict is stored); a second appeal by the same payer is 409, the first one stands and the judge isn't called again; two at once give one 201 and one 409 |
| An unpaid case returns 402 on the appeal endpoint | `test/checkout.test.js` | a ruled, unpaid case answers 402 with no token, a party token, a started-but-unpaid click, and with payments switched off; nothing is stored and the judge isn't called |

Extra codepaths with tests:
- **Stripe client** (`test/payments.test.js`):
  - the form-encoded request, auth header, idempotency key and timeout
  - errors carry the status only, never the key
  - a session id or URL that doesn't look like Stripe's is rejected
  - the signature check: valid, a rotated second `v1`, `v0` only, a tampered body, a wrong secret, older or newer than 300 s, a malformed header
- **Checkout** (`test/checkout.test.js`):
  - payments off: 503, and the fake door as in M3
  - not ruled, declined, taken down, paid, appealed: 409; missing: 404; non-JSON: 415
  - Stripe 5xx or a foreign URL: 502, with the click kept
  - no case text in the Stripe request
  - with payments on, the plain unlock click still makes no payment call
- **Fulfilment:**
  - unpaid, the wrong amount or currency, or an unknown click: not marked
  - a deleted case: a 200 webhook, logged
  - a second payer: their own click is paid, the case's `paid_at` is unchanged, and their page offers a refund
  - webhook: signature missing, bad or stale (400), secret unset (503), other event types (200, no Stripe call), Stripe unreachable during the re-read (502)
- **Appeal** (`test/appeal.test.js`):
  - auth: 401 with `WWW-Authenticate`; 403 for another case's paid click, an unpaid click, a near miss, the plaintiff or summons token
  - not ruled, declined or taken down: 409; a missing case: 404
  - a bad side, or evidence that's missing or too long: 400
  - out-of-scope evidence: 422 with nothing stored and the appeal still available
  - the judge down: 201 `heard: false`, then `/appeal/rule` gives 200 and an idempotent repeat makes no model call
  - malformed replies: nothing stored
  - the model declining: the original ruling stands and the evidence is hidden
  - a report or delete mid-hearing; expiry and delete remove the appeal and payment data
- **Pages:**
  - the case page in each paid-mode state, the appellant page in each state, the jury page, the plaintiff page
  - `<script>` in evidence and rulings is escaped
  - the card model and PNG show the appeal verdict, "Upheld/Overturned on appeal", and render at 1080×1350 with a 300-character title
- **Legal** (`test/legal.test.js`): terms and privacy content (price, what's bought, refunds, processors, retention, 18+, contact or its absence); footer links on every page; the terms link next to the checkout button.
- **Config** (`test/config.test.js`):
  - payments `off`, `no-contact` and `stripe`, and `PUBLIC_URL`/`RENDER_EXTERNAL_URL`, which must be https or are ignored
  - nothing logged
  - an M3 database upgrades in place and the script can run again
- **Host** (`test/serve.test.js`): `start()` serves over HTTP, deletes a 31-day-old case at boot, sends `CRON_SECRET` to its own job, and builds https links from the public origin; `render.yaml` has a free plan and `node scripts/serve.js`.
- **Client** (`test/client.test.js`, fake DOM): the checkout button redirects to the Stripe URL; the appeal form sends the bearer click id with side and evidence, then reloads; "Hear the appeal" posts and reloads.
- **e2e** (`test/e2e.test.js`): checkout, then a signed webhook through the real Node adapter (raw bytes), then the appeal, then the case page.

One M3 test changes, and the change is documented: `unlock.test.js` "the app has no payment client to call" scanned every file in `src/` for Stripe URLs. That encoded M3's "no payment code" scope, which M4's roadmap reverses.
- It now skips `src/payments.js` alone, and still checks that no payment SDK is in `package.json`.
- A new test with payments switched on proves the M3 exit criterion behaviourally: the unlock click calls neither the Stripe client nor `fetch`.

Not automated: a real Stripe test-mode payment (no network or key here), Stripe's receipt email, and Render's boot. These are verified after deploy (see Deploy).

## M3 plan (done, kept for reference)

### Milestone 3 of 5: Safety, deletion and fake-door unlock

M1 and M2 are built and their 264 tests keep passing. This plan applies gstack's Step 0: Scope Challenge, 1. Architecture review and 3. Test review to M3. The build is non-interactive, so each question is answered here and the answer is final. There is no REVENUE.md, so nothing beyond the roadmap's fake door is built for money in M3. Checkout, receipts and the legal pages for charging are M4's.

#### Step 0: Scope Challenge

1. **What existing code already solves part of this?**
   - `votes` already has `ON DELETE CASCADE`, and testimonies are columns on `cases`. The card is computed from the case row, never stored. So one `DELETE FROM cases` removes the testimonies, the votes and the card. No per-table cleanup is needed.
   - The summons token already proves "I am the defendant", so it doubles as the defendant's delete credential. Only the plaintiff needs a new token.
   - Reused as they are:
     - the token-shape checks, the generic 404 page, `readJsonObject` / `textField`
     - the injected clock (`now`), which is all the "faked clock" criterion needs
     - the PGlite harness
     - the `declined` pattern: a sticky timestamp plus `… IS NULL` guards in the write statements, which "taken down after a report" copies
   - The client script's `data-api` form handler gets three small options (method plus bearer token, confirm, reveal a panel) instead of a second script.
2. **Minimum set of changes for M3's exit criteria and deliverables:**
   - **Delete:** a `plaintiff_token` column, returned once by `POST /cases`. `DELETE /cases/:id` takes `Authorization: Bearer <plaintiff or summons token>`. There's a private plaintiff page (`GET /plaintiff/:token`) with the delete button, and the summons page gets one too, because a "delete link" needs somewhere to live. The plaintiff page also shows the summons and jury links again, which closes M2's "links can't be shown again" gap at no extra cost.
   - **Expiry:** `GET /cron/expire` deletes cases filed more than 30 days ago, in batches. One `vercel.json` cron runs it daily (the most often Hobby allows).
   - **Fake door:** a "Full trial · $3" button on the case page. `POST /cases/:id/unlock` stores one `unlock_clicks` row and returns 200 with `charged: false`. Only after that does the page say payments aren't live, and it offers an optional email field (`POST /cases/:id/unlock/email`) that updates the same row. Recording the click *before* revealing the fake door is what makes the click count measure intent to pay (the M4 gate is ≥ 2% of cases clicking).
   - **Report:** a "Report this case" link on the case, jury and summons pages. `POST /reports { caseId, reason, note? }` stores one `reports` row with a reason and takes the case down at once (`reported_at`). Every public view then shows a "taken down" page, and every write is closed.
     - The plan first had `POST /cases/:id/report`. It moved during implementation because an M1 test (unchanged) asserts that a declined case page offers no action under `/cases/`, and declined pages carry the report form.
   - **Deliberately not in M3:**
     - no payment provider, checkout or Stripe code at all (M4); no receipt or launch email is ever sent, and the email is only stored
     - no admin UI or notifications: the operator reads reports and clicks with SQL (queries below under "Run it locally"), and restores a wrongly reported case with one `UPDATE`
     - no privacy or terms pages: M3 shows a notice where the email is collected, and the full pages come with payments in M4
     - no partial deletes (deleting one testimony or one vote): "delete the case" deletes everything, for both sides
     - no read-side hiding of cases between day 30 and the next daily cron run; a case can outlive day 30 by up to a day
     - no rate limit, still open from M1 and M2; it now also covers reports and unlock clicks
     - no recovery of a lost plaintiff link: it's shown once, like the other links, and the cases filed before M3 have no plaintiff token (only the defendant or expiry can delete them)
     - no dedupe of unlock clicks per device: the metric is cases with at least one click, so repeat clicks don't change it
     - no anonymous metrics that outlive deletion: the click rate is computed over the cases still stored, which is a rolling 30-day window in which clicks and cases expire together
3. **Complexity check:**
   - Source files touched: `src/app.js`, `src/store.js`, `src/views.js` and `src/config.js`, plus one new config file, `vercel.json`. The client script is inside `views.js`.
   - No new classes or services. The expiry job is a route plus one store method, and the cron is Vercel's.
   - Counting tests and docs, about 15 files change, which is over the 8-file smell. The extra files are:
     - five new test files: delete, expiry, unlock, report and the client test
     - the fake DOM, `test/dom.js`
     - changes to `test/helpers.js`, `test/config.test.js`, `test/e2e.test.js` and `scripts/dev.js`
     - BUILD.md
   - None of these are moving parts, so the plan proceeds as is.
   - Two tables and two columns are new. Each answers one deliverable, and none can be dropped without dropping that deliverable.
4. **Search check:** the WebSearch tool wasn't used ("Search unavailable — proceeding with in-distribution knowledge only"); the schema behaviour below was checked by experiment in this sandbox.
   - **Cascade delete [Layer 1].** Postgres `ON DELETE CASCADE` on every child table (`votes`, `reports`, `unlock_clicks`), so deletion can't miss a table that a later milestone adds as long as it references `cases`. Each child has an index starting with `case_id`, so the cascade doesn't scan.
   - **Schema upgrade [Layer 1].** `ALTER TABLE … ADD COLUMN IF NOT EXISTS plaintiff_token text UNIQUE` inside the existing advisory-locked script. Checked in PGlite: running it three times leaves exactly one unique index, and M2 rows keep a NULL token, which `UNIQUE` allows more than once.
   - **Atomic takedown [Layer 1].** `WITH hidden AS (UPDATE cases SET reported_at … WHERE reported_at IS NULL RETURNING id) INSERT INTO reports … SELECT … FROM hidden`: one statement, so two simultaneous reports store one row, and the case is never hidden without its report.
   - **Expiry: Vercel Cron Jobs [Layer 1].**
     - Hobby allows cron jobs, but at most once a day, and a schedule that runs more often fails the deploy. The schedule is fixed at `17 4 * * *`, and a test checks it's daily.
     - Hobby also fires within the scheduled hour, not to the minute; for 30-day retention that doesn't matter.
     - Cron requests are plain `GET`s to the production deployment.
     - **Footgun:** Vercel adds `Authorization: Bearer $CRON_SECRET` only when `CRON_SECRET` is set in the project.
   - **[EUREKA, small] The expiry endpoint fails open.** The usual advice is to make a cron route reject callers without the secret. Here that is the wrong default:
     - the job's only effect is to enforce the retention policy early: it deletes what is already past 30 days, it is idempotent, and its cutoff comes from the server clock, never from the request
     - an outsider who triggers it gains nothing, and a no-op run is one indexed `DELETE`, the same cost as any page view
     - failing closed means a project where nobody set `CRON_SECRET` never deletes anything, silently breaking the 30-day promise
     - so `CRON_SECRET` is honoured when it is set (it's checked with `timingSafeEqual`) and isn't required
   - **Delete credential in a header [Layer 1].** `Authorization: Bearer` keeps the token out of the request line, so out of access logs. A cross-site page can't send it without a CORS preflight the app never grants, which is CSRF protection for free. A body or query parameter would have neither property.
   - **Hono built-ins.** `app.delete` for the route. No new middleware: `bodyLimit`, `secureHeaders` and `no-store` already cover the new routes.
5. **TODOS cross-reference:** there is no TODOS.md.
   - The rate limit (M1/M2) is still open and isn't bundled in, because it needs a design (Vercel Firewall rule or a Postgres counter).
   - M2's "plaintiff owner token" item is done here.
   - New TODO: a manual browser run of the delete, report and unlock flows (listed under "What's left").
6. **Completeness check:** each path is built in full:
   - **Delete:** every status (200/401/404); the plaintiff, the defendant, the jury token (refused), another case's token, a near-miss and a missing header; deleting twice and simultaneously; every route afterwards (404); every table afterwards (no rows); the card cache purged.
   - **Expiry:** the boundary (exactly 30 days is kept, one millisecond more is deleted); batching; idempotent re-runs; the secret set or unset; the `vercel.json` schedule.
   - **Unlock:** one row per click; no outbound request; the email step (valid, invalid, wrong click, another case's click); declined, taken-down and missing cases.
   - **Report:** every reason; the note limit; idempotent re-reports; simultaneous reports; every view and every write after a takedown; delete still works after a takedown.
7. **Distribution check:** still one Vercel function, plus a `vercel.json` with one cron entry, and no new packages.

#### 1. Architecture review

```
 POST /cases ──▶ + plaintiffToken, plaintiffUrl   (returned once, never shown on a shared page)

 /plaintiff/:token (private) ── links again + [Delete]      /summons/:token (defendant) ── + [Delete]
            │                                                           │
            └──── DELETE /cases/:id   Authorization: Bearer <plaintiff or summons token> ────┘
                    no header ─ 401     bad shape / no match (incl. the jury token) ─ 404
                    DELETE FROM cases WHERE id = $1 AND (plaintiff_token = $2 OR summons_token = $2)
                      └─ ON DELETE CASCADE ─▶ votes, reports, unlock_clicks     card cache entry dropped
                    → 200 { caseId, deleted: true }   (the browser then goes to /deleted)

 Vercel Cron, daily 04:17 UTC ──▶ GET /cron/expire   (Bearer CRON_SECRET checked only if it is set)
      cutoff = now − 30 days   (the injected clock)
      loop: DELETE … WHERE id IN (SELECT id … WHERE created_at < cutoff LIMIT 500) RETURNING id
      → 200 { deleted, cutoff }

 case page ── [Full trial · $3] ─▶ POST /cases/:id/unlock {}          → 200 { clickId, charged: false }
                                   INSERT unlock_clicks (id, case_id)    no payment client, no outbound call
              reveal: "Payments aren't switched on yet, so nothing was charged." + optional email
                                ─▶ POST /cases/:id/unlock/email { clickId, email }   UPDATE that row → 200

 case / jury / summons pages ── "Report this case" ─▶ POST /reports { caseId, reason, note? }
      WITH hidden AS (UPDATE cases SET reported_at … WHERE reported_at IS NULL RETURNING id)
      INSERT INTO reports … FROM hidden            → 201 (taken down) | 200 (already down) | 404
      afterwards: case and jury pages 410 "taken down" (no content); card 404;
                  summons and plaintiff pages show only the notice and [Delete];
                  testimony, vote, rule and unlock 409; delete and expiry still work
```

Data (added to the same advisory-locked schema script):

```
cases + plaintiff_token text UNIQUE      (NULL on cases filed before M3)
      + reported_at     timestamptz      (a sticky takedown, like declined_at)
      + INDEX (created_at)               (the expiry scan)
reports       (id identity PK, case_id → cases ON DELETE CASCADE, reason CHECK (…), note text NULL, created_at)
unlock_clicks (id text PK = random click token, case_id → cases ON DELETE CASCADE, email text NULL,
               created_at, email_at NULL)
```

Design decisions:
- **A report takes the case down immediately**, with no threshold and no review queue.
  - There is no moderator and no notification channel on a $0 solo test, so a report that only stored a row would do nothing until someone ran SQL.
  - The PRD's bar is zero published cases that name non-participants or touch excluded topics, and the report link is the takedown link from its open question.
  - A wrongful takedown costs a joke. A wrongful publish can harass a real person. Anyone who could grief this way (the parties and their friends) already shares the link, and the parties can delete anyway.
  - Reversal is one SQL statement, listed under "Run it locally".
- **Taken down is not deleted.** Rows stay until a party deletes the case or it expires, so a wrongful report can be reversed. Public pages show none of the content.
- **The defendant can delete the whole case.** The PRD says "either party can delete the case and its data", and a half-deleted trial (a ruling without one side's testimony) would misrepresent it.
- **Status codes.** A wrong token is a 404, as everywhere else. A missing `Authorization` header is a 401, which leaks nothing because no lookup happens. A taken-down page is a 410, so link previews and crawlers drop it.
- **The fake door is honest after the click.** The button looks real, and the click is recorded first. The very next thing the user sees is "nothing was charged". The email is optional, its use is stated where it's collected, it's deleted with the case, and it is never logged.
- **The plaintiff link is private.** It appears in the filing receipt and on its own page only, never on the case, jury or summons pages or the card (tested). The plaintiff page's links don't leak it, because the app already sends `Referrer-Policy: no-referrer`.
- **The 30-day clock starts at filing** (`created_at`), not at the ruling, so the promise is a fixed date that the pages can show.

Realistic production failures:
| Codepath | Failure | Handled |
|---|---|---|
| delete | the plaintiff loses the plaintiff link | the defendant can still delete with the summons link, and expiry deletes at day 30; the receipt says to save it |
| delete | a chat app has cached the card in its link preview | out of our reach: the app's own copies are gone (`no-cache`, no CDN copy, per-instance cache purged), and BUILD.md says so |
| delete | two deletes at once (both parties) | one `DELETE … RETURNING`: one 200, one 404 |
| expiry | `CRON_SECRET` never set | the job still runs (fail-open, see EUREKA) |
| expiry | the cron didn't fire (Hobby misses, deploy paused) | the next run catches up, because the cutoff is "older than", not "exactly 30 days"; there's also a manual check under Deploy |
| expiry | thousands of expired cases on one run | batches of 500 per statement until none are left, all inside one invocation |
| expiry | `vercel.json` makes Vercel stop detecting Hono | verify on first deploy; `vercel.json` only has `crons`, which doesn't set a framework |
| unlock | a script inflates clicks | a bounded nuisance until the rate limit lands: rows expire with the case, and the metric is per case |
| report | a griefer takes down a friend's case | reversible by SQL; a party can delete and refile; M5 sampling will show whether it happens |
| report | a report lands while a vote, testimony or ruling is being written | each write statement also requires `reported_at IS NULL`, and the route re-reads and answers 409 |

#### 3. Test review

Same harness: `app.request` against in-memory PGlite, with the fake clock and the mocked judge. The client script runs in `node:vm` against a fake DOM of about 100 lines, which is built from the server's own HTML, with `fetch` routed to `app.request`. So "click the unlock button" is tested from the button to the database row. There's no jsdom or happy-dom, because the npm registry isn't reachable from this sandbox.

| Exit criterion | Test file | Tests |
|---|---|---|
| DELETE with the plaintiff token removes the case, testimonies, votes and card (all 404 afterward) | `test/delete.test.js` | a ruled case with both testimonies, three votes with comments, a rendered card, an unlock click with an email and a report is deleted with the plaintiff token; afterwards the case page, card (with and without the old `If-None-Match`), summons page and testimony, jury page and vote, plaintiff page, rule, unlock, report and a second delete all return 404; no row in any table holds its id or text; the card cache entry is gone. The same with the summons token. |
| cases older than 30 days are removed by the expiry job with a faked clock | `test/expiry.test.js` | cases at T0 and T0 + 10 days; at T0 + 30 days nothing goes; at T0 + 30 days + 1 ms only the first goes (every route 404, child rows gone) and the second stays; at T0 + 40 days + 1 ms the second goes; re-runs delete nothing; batches of 2 over 5 cases |
| a click on the unlock button stores one row with the case id and returns 200 with no payment call | `test/unlock.test.js` and `test/client.test.js` | the API stores exactly one row with the case id and `email` NULL, returns 200 with `charged: false`, and `globalThis.fetch` and the judge are never called; the fake-DOM click does the same from the button and reveals the email panel with the click id |

Extra codepaths with tests:
- **Delete:**
  - missing header (401 with `WWW-Authenticate: Bearer`); `Basic`, a malformed token, a near-miss, the jury token, the case id and another case's tokens (404, case intact)
  - a malformed case id (404)
  - simultaneous deletes from both parties: one 200, one 404
  - deleting a declined or a taken-down case
- **Plaintiff page:**
  - links, delete form and state, escaping
  - the plaintiff token appears on no other page and not in the card model
  - a wrong token, the summons token or the jury token: 404
  - a taken-down case shows only the notice and delete
  - a pre-M3 case with a NULL plaintiff token can't be reached through any plaintiff URL
- **Receipt:** `POST /cases` returns three distinct tokens and `plaintiffUrl`; the home page has the plaintiff-link field.
- **Expiry:**
  - with `CRON_SECRET` set: missing or wrong bearer 401, right bearer 200; with it unset: 200
  - `vercel.json` has a daily cron for `/cron/expire`
  - `createDeps` passes `CRON_SECRET` through and never logs it
- **Unlock:**
  - repeat clicks give one row each
  - an email is stored on the same row; invalid, too long or missing email 400; a malformed click id 400; an unknown click, or a click from another case, 404
  - declined or taken-down case 409; missing case 404; non-JSON 415
  - the unlock section appears on the case page in every non-declined state, and not on declined ones
- **Report:**
  - each reason; an unknown reason or an over-long note 400; non-JSON 415
  - the first report 201 and the case is down; a second 200 with no new row; simultaneous reports one row
  - after takedown:
    - case and jury pages 410 with no title, charge or testimony
    - card 404
    - summons and plaintiff pages show the notice and delete form only
    - testimony, vote, rule and unlock 409
    - delete still 200
  - a ruled case that's reported no longer returns its ruling from `/rule`
  - the report form appears on the case, jury and summons pages (also for declined cases, whose page still shows the testimonies)
- **Schema upgrade:** an M2-shaped database gains the new columns and tables, keeps its rows and runs the script repeatedly without duplicate indexes.
- **Client script (fake DOM):**
  - filing reveals the receipt with the plaintiff link
  - unlock click → email → thanks
  - delete asks for confirmation; cancelling sends nothing; confirming sends `DELETE` with the bearer token and goes to `/deleted`
  - a report reloads into the taken-down page
- **e2e** over real HTTP: file, plaintiff page, unlock click, delete with the plaintiff token, then 404s.

Not automated: a real browser (the fake DOM checks the wiring, not rendering), and Vercel's cron actually firing (verify after the first deploy, see Deploy).

## M2 plan (done, kept for reference)

### Milestone 2 of 5: Jury and verdict card

M1 is built and its 210 tests keep passing. This plan follows the same gstack steps as M1 (Step 0: Scope Challenge, 1. Architecture review, 3. Test review). The build is non-interactive, so each question is answered here and the answer is final.

#### Step 0: Scope Challenge

1. **What existing code already solves part of this?**
   - M1 already creates and stores an unguessable `jury_token` per case, and returns it from `POST /cases`.
   - Reused as they are:
     - token-shape checks and the generic 404 page
     - `readJsonObject` / `textField` validation
     - the scope screen (for comments)
     - the escaping `html` views and the CSP
     - the PGlite test harness
   - The card reads the same `Case` row as the results page, so there is no parallel data path.
2. **Minimum set of changes for M2's exit criteria:**
   - one `votes` table, with primary key `(case_id, voter)`
   - two jury routes: `GET /jury/:token` (page) and `POST /jury/:token/votes`
   - the jury split, with comments, on the results page
   - one card route, `GET /cases/:id/card.png`, plus a `src/card.js` renderer
   - the filing receipt shows the jury link
   - **Deliberately not in M2:**
     - the jury does not influence the AI ruling; the judge prompt and rule path are unchanged
     - no voting deadline: votes stay open while the case isn't declined, and M3's 30-day expiry ends them
     - no way to stop the plaintiff or defendant from voting (there are no accounts)
     - no ballot-stuffing defence beyond one vote per device cookie, which is what the roadmap asks for
     - no emoji, CJK or other glyphs on the card that the bundled font can't draw: they are stripped on the card, and the page still shows them
     - no comments on the card
     - no Web Share API: the results page has a download link and `og:image` link previews instead
     - no report or delete link, no fake door (M3), no owner token, so the jury link can't be recovered later (M3)
     - no rate limit, which is still open from M1
     - the title limit stays at 120 characters. The card is built to survive any length, and the 300-character criterion is tested with a title written straight to the database.
3. **Complexity check:**
   - Source files touched: `src/app.js`, `src/store.js`, `src/views.js` and `src/judge.js`, plus one new file, `src/card.js`. The labels move to `judge.js` so the page and the card share one copy.
   - New services: one (the card renderer). No new classes.
   - Counting tests and docs, about 11 files change, which is over the 8-file smell. The extra files are test files, BUILD.md and package.json, not moving parts, so the plan proceeds as is.
4. **Search check** (the WebSearch tool wasn't used; this comes from in-distribution knowledge plus experiments run in this sandbox):
   - **Card rendering: satori + resvg-wasm [Layer 1].** This is the pipeline Vercel's own OG-image library uses.
     - satori (MPL-2.0) lays out a React-like element tree with an inline yoga wasm and draws text as `<path>`. resvg-wasm (MPL-2.0) rasterises the SVG.
     - Both are pure JS + wasm: no install scripts and no platform binaries, so the lockfile works on Vercel's x64 as well as this arm64 sandbox.
     - Measured here: about 25 ms of layout and 130–150 ms of raster for 1080×1350, giving a PNG of about 50 KB.
   - **Font: Lora from `@fontsource/lora` (OFL) [Layer 1].**
     - Four subsets (latin, latin-ext, cyrillic, vietnamese) at weights 400 and 700, about 110 KB in total.
     - **Footgun found by experiment:** satori only falls back across fonts with *different family names*. Registering every subset as "Lora" drew Polish, Cyrillic and Vietnamese as empty boxes. Each subset gets its own family name.
     - **Footgun:** glyphs that no font has (emoji, CJK) render as empty boxes. `cardText()` keeps only code points inside the subsets' published `unicode.json` ranges.
   - **Footgun: satori defaults to `box-sizing: content-box`.** A padded 100% root overflowed the 1080 px canvas in the first experiment. The root uses `border-box`.
   - **Footgun: long words.** A 300-character word with no spaces needs `wordBreak: 'break-word'`, and `lineClamp` plus `textOverflow: 'ellipsis'` needs `display: block`. All of this was checked visually.
   - **Footgun: Vercel file tracing.** The wasm and font files are read at runtime. They're resolved with `createRequire(import.meta.url).resolve('<pkg>/<file>')`, a static specifier that Vercel's tracer (`@vercel/nft`) follows. This is listed as verify-on-first-deploy.
   - **Footgun: wasm memory.** resvg objects are `free()`d after every render.
   - **Heavy imports are lazy.** satori and resvg are loaded on the first card request, so the other routes' cold start doesn't pay for about 4 MB of JS and wasm.
   - **Device id: a server-issued HttpOnly cookie through `hono/cookie` [Layer 1].** It's 24 random bytes, `SameSite=Lax`, `Path=/jury`, `Secure` on https and Max-Age 400 days (Hono enforces the browser cap). There's no fingerprinting.
   - **One vote per device, atomically [Layer 1].** `INSERT … ON CONFLICT (case_id, voter) DO NOTHING RETURNING`, with no read-then-write.
   - **Privacy [small EUREKA].** The stored voter is `sha256(caseId:deviceId)`, never the raw cookie. A database reader can't link one device's votes across cases.
   - **Card re-rendering.** The card's ETag is a hash of exactly what it draws, so a matching `If-None-Match` gets a 304 *before* rendering, with `Cache-Control: private, no-cache`.
     - This saves free-tier CPU on page reloads and link-preview refetches.
     - Deletion (M3) still takes effect immediately, because every view revalidates.
     - Hono's `etag` middleware was rejected: it hashes the body *after* rendering, so it saves bandwidth but not CPU.
5. **TODOS cross-reference:** there is no TODOS.md. M1's open items (rate limit, double model call, model alias, browser check) are unchanged and aren't bundled in. The browser check now covers the jury form too.
6. **Completeness check:** each path is built in full:
   - every vote status (201/400/404/409/413/415/422)
   - duplicate votes, sequential and concurrent
   - a missing or forged device cookie
   - out-of-scope comments
   - jury votes on declined cases
   - every verdict state on the card, plus pending, default judgment, long and unprintable text, and 304 revalidation
7. **Distribution check:** nothing new to ship. It is still one Vercel function, and `npm install` installs the two pure-JS/wasm packages and the font package.

#### 1. Architecture review

```
 jury link /jury/:token ─────────────────────────────┐
   GET  → juryPage: case file + vote form            │  pc_device cookie (HttpOnly, Path=/jury)
          (or "your vote" + split once voted)        │  voter = sha256(caseId ":" deviceId)
   POST /jury/:token/votes {vote, comment?}          ▼
        token shape ─ 404     JSON/fields ─ 400/413/415     screen(comment) ─ 422
        case missing ─ 404    case declined ─ 409
        INSERT … ON CONFLICT (case_id, voter) DO NOTHING RETURNING
            row  → 201 { caseId, caseUrl, vote, jury }
            none → 409 { error, jury }   (the first vote stands)

 results page /cases/:id ── store.getJury (one aggregate query) + store.listComments (newest 50)
   jury split + comments; after the ruling, a card preview and download link; og:image on every state

 GET /cases/:id/card.png
   id shape / missing / declined → 404
   model = cardModel(case, jury, host)       pure: strips undrawable glyphs, excerpts the ruling
   ETag = hash(model + CARD_VERSION) ── If-None-Match matches → 304, no render
   renderCardPng(model)
     ├─ satori(element tree) → SVG, text as <path>   (yoga wasm is inline in satori)
     └─ resvg-wasm → PNG 1080×1350                   (wasm and fonts loaded once, lazily)
```

Data:

```
votes (case_id text REFERENCES cases(id) ON DELETE CASCADE,
       voter text, vote text CHECK (vote IN ('guilty','not_guilty')),
       comment text NULL, created_at timestamptz,
       PRIMARY KEY (case_id, voter))
```

It's created in the same advisory-locked schema script as `cases`. `ON DELETE CASCADE` gets M3's delete ready.

Design decisions:
- **Who sees what.**
  - The jury page shows the case file and the judge's ruling, if there is one.
  - The split shows only after this device has voted, so jurors aren't herded.
  - The results page never shows the jury token, as in M1. The plaintiff gets the jury link from the filing receipt.
- **Comments.**
  - Optional, at most 140 characters, collapsed to one line, with an empty comment stored as NULL.
  - Comments go through the same scope screen as testimony, so excluded topics aren't published.
  - They're rendered only through the escaping `html` tag and never reach a model.
- **The card draws text, never markup.** satori takes an element tree in which every user or model string is a text child. No `dangerouslySetInnerHTML`, no `<style>`, no `<img>` from user input. So `<script>` is drawn as the glyphs `<script>`.
- **Card content:**
  - the kicker
  - the title, with font size stepped down by length and clamped to 3–5 lines
  - the charge, clamped to 3 lines
  - the verdict stamp: Guilty, Not guilty, Split decision or "Verdict pending"
  - a ruling excerpt of at most 420 characters, ending on a word and clamped to 7 lines (raised from 300 and 6 during review)
  - the jury split
  - the credit "File your own case at <host>", plus "not legal advice"
- **Declined cases have no card (404)** and the results page doesn't link one, so out-of-scope content never becomes a shareable image.

Realistic production failures:
| Codepath | Failure | Handled |
|---|---|---|
| card | Vercel's tracer misses `index_bg.wasm` or a font | only the card route returns 500 (logged) and the rest of the app works; verify on first deploy, fallback listed in Review |
| card | wasm init fails or throws once | the memoised init promise resets, so the next request retries |
| card | link-preview bots and reloads re-request the card | ETag/304 before rendering, plus a 32-entry per-instance cache of rendered cards keyed by ETag (added during review); renders are about 150 ms of CPU |
| card | 300-character title or 2,000-character ruling | stepped font size, `lineClamp`, `break-word` and a code-side excerpt; fixed 1080×1350 canvas |
| card | emoji or CJK in a title | stripped for the card only; if nothing is left, a fallback text is used |
| vote | double-tap from the same device | primary-key conflict: one 201, then 409 |
| vote | browser blocks cookies | each vote looks like a new device, so stuffing is possible; accepted and listed in Review |
| vote | abusive comment | scope screen gives 422 and nothing is stored; M3 adds the report link |

#### 3. Test review

Same harness as M1: `app.request` against in-memory PGlite, with a fake clock and a mocked judge. Card tests use the real satori and resvg (no mocks), because rendering is what the criteria are about.

| Exit criterion | Test file | Tests |
|---|---|---|
| three votes from three device ids → matching split; repeat from the same device → 409 | `test/jury.test.js` | guilty, guilty, not guilty from three cookies gives 2/1/3 in the API response, on the results page, on the jury page and in the card model; a repeat (even switching sides) returns 409 and the tally and the first vote are unchanged; concurrent duplicates give exactly one 201; a first vote without a cookie sets one, and reusing it gives 409 |
| card.png → image/png, 1080×1350, renders with a 300-character title | `test/card.test.js` | PNG signature and IHDR size through the route; 300-character title written to the DB (spaced and unspaced); every field at maximum length; emoji and CJK titles; every verdict, pending and default judgment |
| `<script>` charge is text in the page and the card | `test/card.test.js` | results and jury pages show it escaped; the card tree holds it as a text child with no script element; the card SVG with `embedFont: false` has it as escaped `<text>` and no `<script` tag; the PNG still renders |

Extra codepaths with tests:
- **Vote validation:**
  - a missing or unknown vote, or a non-string comment: 400
  - a comment over 140 characters: 400
  - non-JSON: 415; bad JSON: 400
  - multiline comment collapsed; empty comment stored as NULL
- **Comment safety:** an out-of-scope comment gets 422 and stores nothing.
- **Wrong tokens:** a near-miss jury token, the summons token, the case id and a malformed token all get 404 on GET and POST, and leak nothing.
- **Case state:**
  - voting on a declined case: 409, and the jury page shows the case as closed with no content
  - votes are allowed before the defendant answers and after the ruling
- **Device cookie:**
  - a forged or malformed cookie is replaced
  - the cookie's attributes are checked
  - the raw device id is never stored
  - the same device can vote in two different cases
- **Pages:**
  - the jury page: form, voted and ruled states, never the summons token
  - the results page: split, "no votes yet", comments escaped, card section only after the ruling, `og:image` absolute URL, still never the jury token
  - `POST /cases` returns `juryUrl`, and the receipt has a jury-link field
- **Card logic:**
  - card 404s: wrong id, missing case, declined case
  - ETag: a 304 with no render, a new ETag after a vote, `Cache-Control: private, no-cache`
  - render cache: five first-time viewers cause one render, the oldest entry is evicted past 32, and a renderer failure is a logged 500 that isn't cached and leaves other routes working
  - pure `cardModel`/`cardText` units: labels, excerpt length, glyph stripping, fallbacks
- **e2e:** the whole trial over real HTTP, now with three jurors carrying cookies and the card PNG served through the Node adapter.

Not automated: how the card looks. It was checked by eye on PNGs rendered in this sandbox. The browser-side jury form is not automated either, the same as M1's forms.

## M1 plan (done, kept for reference)

### Milestone 1 of 5: File, summon, rule

The plan uses gstack's plan-eng-review steps (Step 0: Scope Challenge, 1. Architecture review, 3. Test review). The build is non-interactive, so every question below is answered here and the answer is final.

#### Step 0: Scope Challenge

1. **What existing code already solves part of this?** None in this repo, which is a fresh idea repo with docs only. REVIEW.md and PRD.md suggest building it as a "Court" mode inside tiebreak. That repo isn't reachable from this sandbox, and the run is scoped to pettycourt, so this is a standalone build. The data model stays small so it can be moved into tiebreak later. Decided: build here.
2. **Minimum set of changes for M1's exit criteria:**
   - Four endpoints: `POST /cases`, `GET /summons/:token`, `POST /summons/:token/testimony` and `POST /cases/:id/rule`.
   - One results page at `GET /cases/:id`, plus a home page with the filing form.
   - One table (`cases`). The judge is behind a single function so tests can swap it for a mock.
   - **Deferred, not in M1:**
     - jury voting UI and endpoint (M2; M1 only creates and stores the jury token)
     - verdict card PNG (M2)
     - exhibits and image upload (PRD lists them under the paid full trial; M4 handles "new evidence")
     - report and delete links, 30-day expiry (M3)
     - plaintiff/owner token (M3, needed for delete)
     - fake-door unlock (M3), payments and appeal (M4)
     - names of the parties
     - email, rate limiting, analytics
3. **Complexity check:** there are 7 source files (`src/app.js`, which is also the Vercel entry, plus `src/store.js`, `src/judge.js`, `src/scope.js`, `src/views.js`, `src/config.js` and `scripts/dev.js`). The only class is a one-line error type. Only two new "services": a Postgres store and an LLM client. That's under the 8-file smell, so no further scope reduction.
4. **Search check:**
   - **Vercel + Hono [Layer 1].** Vercel deploys Hono with zero configuration on its Node runtime. It looks for a file that imports `hono` and default-exports the app at `app`/`index`/`server` (`.js`/`.ts`…), at the root or in `src/`. `src/app.js` is that file, so no `vercel.json` and no adapter are needed.
   - **Local runner.** It is deliberately named `scripts/dev.js`, not `server.js`, so Vercel can't mistake it for the entry point.
   - **Known footgun: the entry must export the app synchronously.** No `await import` at the top level. That's why database and judge setup happen lazily on the first request.
   - **Gemini free tier as the judge [Layer 1].** Google exposes an OpenAI-compatible `chat/completions` endpoint with `response_format: json_object`, and it works with a free-tier key. Calling the generic OpenAI-compatible API means LiteLLM, Groq or OpenRouter can replace it by setting `LLM_BASE_URL` and `LLM_MODEL`.
   - **Footgun: on Gemini's free tier, Google may use prompts to improve its products.** The filing page says so. The default model is the `gemini-flash-lite-latest` alias, which has the largest free quota and avoids hard-coding a model version that may be retired.
   - **Hono built-ins replace custom code [Layer 1]:**
     - the `html` tagged template auto-escapes user text (XSS)
     - `secureHeaders` adds CSP and `Referrer-Policy: no-referrer`, so tokens in URLs don't leak through Referer
     - `bodyLimit` caps body size (no hand-rolled versions)
   - **Footgun: concurrent `CREATE TABLE IF NOT EXISTS` on two cold starts can raise a duplicate pg_type error.** Fix: schema creation takes `pg_advisory_xact_lock` inside a transaction.
   - **Tests run on PGlite [EUREKA, small].** It runs real Postgres SQL (unique indexes, `UPDATE … WHERE … RETURNING`), so the "store once" and "store nothing" criteria are proven against real Postgres behaviour, not a hand-written in-memory fake. Production uses the same SQL through `pg`.
5. **TODOS cross-reference:** there is no TODOS.md. Deferred items are listed under "What's left" below.
6. **Completeness check:** the full version of every M1 path is built:
   - every validation and error status (400/404/409/413/415/422/502/503)
   - the model-side refusal as well as the keyword classifier
   - an idempotent re-rule, so it never makes a second model call
   - a stored "declined" marker, so retrying can't reroll a refusal
7. **Distribution check:** the artifact is a web service deployed on Vercel Hobby by git push or `vercel deploy`. No binaries or packages. CI is not in scope; the caller's pipeline commits and deploys.

#### 1. Architecture review

```
 browser (plain HTML + /app.js, ~70 lines, no framework)
    │  JSON fetch
    ▼
 Hono app  src/app.js  ── routes, validation, status codes
    │            │                 │
    │            ▼                 ▼
    │      src/scope.js       src/judge.js
    │      keyword screen     OpenAI-compatible chat/completions ──▶ Gemini free tier
    │      (pure)             parseRuling(): JSON shape, verdict enum, 40–200 words
    ▼
 src/store.js  parameterised SQL, one `cases` table
    │
    ├── pg Pool ──▶ Neon Postgres (DATABASE_URL)        production
    └── PGlite (WASM Postgres, in-memory / .data/)      tests and local dev
```

The rule flow (`POST /cases/:id/rule`) runs these checks in order:

```
case missing ............................ 404
already ruled ........................... 200, the stored ruling (no model call)
already declined ........................ 422 (no model call)
no defendant testimony, before deadline . 409
keyword screen hits ..................... mark declined, 422
judge throws / times out ................ 502, nothing stored
judge not configured .................... 503, nothing stored
output not JSON / wrong shape / words ... 502, nothing stored
model verdict "declined" ................ mark declined, 422
UPDATE … WHERE ruled_at IS NULL ......... 200 (on a lost race, return the winner's ruling)
```

The flow ends with a default judgment: past the deadline with no testimony, the ruling starts with "The defendant failed to appear."

Design decisions:
- **Tokens and ids.** Summons and jury tokens are 24 random bytes in base64url (32 characters). The case id is 12 random bytes (16 characters). The results page is meant to be shared, so its id is unguessable too, but it never reveals the summons token. Malformed tokens get a 404 before any database call. A wrong token gets a generic 404 page with no case content.
- **Store once, atomically.** `UPDATE cases SET defendant_testimony = … WHERE summons_token = $1 AND defendant_testimony IS NULL AND ruled_at IS NULL RETURNING …`, so there's no read-then-write race. The ruling is stored the same way (`WHERE ruled_at IS NULL`).
- **Deadline.** Fixed at 24 hours after filing. The clock is injected so tests can fake it. The defendant may still answer late if no ruling exists yet, because the summons loop is the product.
- **Scope screen.** Three gates:
  - at filing (title, charge, testimony): 422, nothing stored
  - at defendant testimony: 422, nothing stored
  - again before ruling, as defence in depth in case the term list grows
  The model is the second line: it may answer `"declined"`. A decline sets `declined_at`, so the case can't be rerolled.
- **LLM trust boundary.**
  - Testimonies are sent as a JSON-encoded case file, and the system prompt says they are evidence, not instructions.
  - Output is parsed strictly: one JSON object, verdict in `guilty|not_guilty|split|declined`, ruling a string of 40–200 words and at most 2,000 characters.
  - Rulings are only ever rendered escaped and are never fed back to a model in M1.
  - Word limits come from one set of constants, also used in the prompt.
- **Config.** Production (the default export of `src/app.js`) requires `DATABASE_URL`. Without it, every data request fails with a logged config error, never a silent in-memory database. The local runner (`scripts/dev.js`) falls back to PGlite under `.data/` and a canned "stub judge" when no LLM key is set, and prints that it did so. The key is read from `LLM_API_KEY`, falling back to `GOOGLE_API_KEY`. Values are never logged.

Realistic production failures and how M1 handles them:
| Codepath | Failure | Handled |
|---|---|---|
| judge call | Gemini free-tier 429 or timeout (20 s limit) | 502 with "try again"; nothing stored; the button can be pressed again |
| judge output | model wraps JSON in ```json fences or writes 260 words | fences are stripped; out-of-range length gives a 502 and nothing stored |
| schema init | two cold starts at once | advisory lock in one transaction |
| Neon | free-tier compute suspended (cold start ~1 s) or connection limits | short pool (`max: 3`, 10 s idle timeout); first request is just slower |
| summons | defendant double-taps submit | atomic UPDATE: one 201, then a 409 that keeps the first answer |
| abuse | someone files a serious case | keyword screen plus model refusal; decline message points to real help |
| quota abuse | scripted filing and ruling burns the free LLM quota | not handled in M1 (no rate limit); the cost is $0 on a free tier and only availability suffers. Listed in Review |

#### 3. Test review

Vitest runs against the real Hono app (`app.request`) backed by an in-memory PGlite, with a mocked judge and a fake clock. No network, no real keys. Each exit criterion maps to at least one test:

| Exit criterion | Test file | Tests |
|---|---|---|
| POST /cases → 201, id, two distinct tokens ≥ 24 chars | `test/cases.test.js` | 201 shape; distinct and URL-safe; unique across 25 cases; stored and readable |
| second defendant testimony → 409, first kept | `test/summons.test.js` | sequential double submit; concurrent double submit (exactly one 201); page and DB still show the first answer |
| wrong token → 404, no content leak | `test/summons.test.js` | one-character-off token, random token, jury token, case id and malformed token on GET summons and POST testimony; wrong id on the case page and rule; the body contains none of the charge, testimony, title or tokens |
| rule → 40–200 words; malformed JSON → 502, nothing stored | `test/rule.test.js` | happy path; 12 malformed or wrong-shape outputs (prose, truncated, empty, string, array, missing ruling, bad verdict, number, 10/39/250 words, over 2,000 characters); judge throws; nothing stored in each case |
| out-of-scope charge → 422 + decline message, no ruling | `test/scope.test.js` | "my boyfriend hits me"; every phrase in `test/fixtures/out-of-scope.json` (abuse, health, money, minors) in charge, title and testimony; defendant testimony; rule-time screen; model "declined" |
| rule before answer and before deadline → 409; after deadline → "defendant failed to appear" | `test/rule.test.js` | 409 right after filing and 1 s before the deadline; default judgment after the deadline; the prefix is not duplicated |

Extra codepaths with tests:
- 400s for missing, blank, too-long and non-string fields
- 400 for invalid JSON, 415 for a non-JSON body, 413 for a body over 16 KB
- false-positive guard: petty phrases containing "childish", "kidding" or "hits snooze" are accepted
- idempotent re-rule makes no second model call
- decline is sticky; a 503 when the judge isn't configured
- LLM client request shape: endpoint, bearer header, model, `json_object`, JSON-encoded case file; non-2xx, empty content and timeout all throw; the key is never in the error text
- the stub judge always produces valid output
- every page state: waiting, ready, ruled, failed to appear, declined, closed summons
- HTML escaping of `<script>` on the summons and case pages
- security headers and `Cache-Control: no-store`
- `/app.js` and `/app.css` are served
- the env → deps config matrix; the Vercel entry default-exports a working app
- the two lost-race branches of rule, made deterministic by a judge mock that writes to the database mid-call:
  - the defendant answers during a no-show deliberation, which returns 409 and stores nothing
  - another request stores first, so its ruling is returned and not overwritten
- a late answer on a declined case returns 409
- `test/e2e.test.js` runs a whole trial (file, summons, testimony, rule, results page) over real HTTP through the Node adapter, with the same local config as `npm run dev` (PGlite in memory plus the stub judge).

Not automated: the browser-side `/app.js` form behaviour (no DOM test runner was added for ~70 lines). It was not checked in a browser either, because this sandbox doesn't allow starting a long-running server. The first manual check is listed under "What's left".
