# pettycourt — PRD

## Problem
Friends, couples and roommates have small disputes ("you said five minutes away while still in the shower") that they want settled in a funny, face-saving way. Today they ask ChatGPT, post in the group chat, or use single-user AI-judge apps (The Docket, Am I Wrong? AI Judge, SettleitGPT). Those give a verdict from one side's story, so the other person never gets to answer and the "ruling" feels rigged. The result is not shareable as something both sides took part in.

## Target user
The plaintiff: someone aged roughly 18–35 in a group chat of 3–10 friends, a couple or a roommate house, mid-dispute and willing to send a link. Secondary users are the defendant and the jurors, who join through the link and are the growth loop. Excluded: anyone under 18, and any serious dispute (abuse, health, money, minors).

## Competitors & gap
The market has at least six small AI-judge apps and free ChatGPT (see RESEARCH.md). None found ask the other side to submit testimony via a summons link, or let friends vote as a real jury. The gap is the two-sided, multi-person flow with a verdict card. It is a thin gap: it is quick to copy, and no evidence yet shows anyone pays for it.

## MVP scope
- File a case on a web page: title, charge, plaintiff's testimony, optional exhibits (text or an image the plaintiff uploads).
- Summons link: an unguessable URL the plaintiff sends; the defendant opens it, reads the charge and submits testimony and exhibits, with no account.
- Jury link: anyone with it votes guilty or not guilty once per device, with an optional one-line comment.
- AI judge ruling in a formal, funny tone, produced after the defendant answers or after a deadline; refusal path for out-of-scope topics.
- Shareable verdict card (image) with the case title, ruling, jury split and a "file your own case" credit.
- Safety and deletion: pre-ruling classifier, report link, and either party can delete the case and its data.
- Free basic verdict; paid unlock ($3) for the full trial: jury, exhibits and one appeal. Payments are tested last, behind a fake-door button first.

## Non-goals
- No reading of private chats or screenshot ingestion in v1.
- No real-money anything, no legal advice, no serious disputes, no coaching or relationship therapy.
- No native apps, no accounts, no printed products in M1–M2 (printed verdict is a later test).
- No generated images.

## Success metrics
Numbers are test thresholds, not forecasts.
- Of 30 cases filed, at least 40% get a defendant testimony via the summons link (below that, the loop does not work).
- At least 25% of cases get 2 or more jury votes.
- Average of 1.0 or more new visitors who open the page per case beyond the plaintiff, i.e. the loop brings people in.
- At least 5% of cases click the paid unlock; at least 2% actually pay $3 within 30 days. If fewer than 1 of 30 cases pays, fold it into tiebreak as a mode rather than a product.
- Zero cases published that name non-participants or fall into the excluded topics, checked by sampling every ruling in the first 100.

## Open questions
- Will the defendant respond, and does a ruling against them end the fun? Test tone and a "split decision" default.
- Is the card shared back to the group chat enough to bring new plaintiffs?
- Build as a standalone product or a "Court" mode inside tiebreak (reusing its voting, sharing and $5 payment)? The default recommendation is the tiebreak mode first.
- Does a printable framed verdict sell, and what does print-on-demand cost per order? Not researched.
- Are there rules on AI-generated rulings about named individuals, and is a takedown link enough?
