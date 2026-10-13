# pettycourt — Roadmap

Suggested stack: Next.js on Vercel Hobby for the test (free, fast; swap host before taking money since Hobby bars commercial use); Postgres on Neon or Supabase free tier for cases, testimonies and votes; free model via LiteLLM for the ruling; satori (or canvas) to render the verdict card; Vitest for the rules. If built as a tiebreak mode, reuse its stack and voting tables instead.

## M1 — File, summon, rule (one weekend)
Deliverables:
- POST /cases creates a case with a charge and plaintiff testimony, returns a case id plus unguessable summons and jury tokens.
- GET /summons/:token shows the charge; POST /summons/:token/testimony stores the defendant's answer once.
- POST /cases/:id/rule calls the judge and stores a ruling; it refuses out-of-scope topics.
- Plain results page for the case with the ruling text.

Exit criteria (tests can run these):
- POST /cases with a charge and testimony returns 201, a case id and two distinct tokens of at least 24 characters.
- Submitting defendant testimony twice on the same summons token returns 409 the second time and keeps the first answer.
- A wrong token returns 404 and leaks no case content.
- Rule on a case with both testimonies returns a ruling of 40–200 words; with a mocked model returning malformed JSON it returns 502 and stores nothing.
- A charge containing "my boyfriend hits me" (or other abuse, health, money, minors terms from the fixture list) returns 422 with the decline message and stores no ruling.
- Rule before the defendant answers and before the deadline returns 409; after the deadline it rules with "defendant failed to appear".

## M2 — Jury and verdict card
Deliverables: jury link with one vote per device, comment field, jury split on the results page, PNG verdict card at /cases/:id/card.png.

Exit criteria:
- Three votes from three distinct device ids give a split of guilty/not guilty that matches the votes; a repeat vote from the same device id returns 409.
- GET /cases/:id/card.png returns image/png, 1080x1350 pixels, and renders without error for a 300-character title.
- Card text escapes HTML: a charge containing `<script>` appears as text in the page and the card.

## M3 — Safety, deletion and fake-door unlock
Deliverables: report link, delete-case link for plaintiff and defendant, 30-day expiry job, "Full trial $3" button that records a click and email without charging.

Exit criteria:
- DELETE with the plaintiff token removes the case, testimonies, votes and card (all return 404 afterward).
- Cases older than 30 days are removed by the expiry job in a test with a faked clock.
- Click on the unlock button stores one row with the case id and returns 200 with no payment call made.

## M4 — Payments and appeal (only if M3 shows at least 2% unlock clicks)
Deliverables: Stripe Checkout for the $3 full trial on a commercial-use host, one appeal with new evidence, receipt email.

Exit criteria:
- A test-mode checkout marks the case paid, and an appeal is accepted once and rejected (409) the second time.
- An unpaid case returns 402 on the appeal endpoint.

## M5 — Decide
Run 30 real cases from friend groups. Apply the PRD thresholds. If defendant response is under 40% or paid conversion is under 2%, fold the flow into tiebreak as a mode and stop.
