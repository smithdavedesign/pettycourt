**Verdict: pass. Score 4/10.** A fun summons-and-jury twist on AI-judge apps, but nobody has shown they pay for a joke verdict, and the flow is copyable in a weekend. If it's worth anything, it's a "Court" mode inside tiebreak.

## Forcing questions

**Q1 Demand reality: 2/10.** The evidence is anecdotes (HuffPost/Reddit via the Substack piece; TechRadar on ChatGPT group chats). Six small competitors exist, which shows builders believe in it, not that users do. Am I Wrong? has ~50 installs and 1 rating, The Docket 0 reviews, Camera Court no ratings. No source shows a paying customer. Interest is not demand. Stronger evidence would be real group chats finishing cases unprompted, or anyone paying even $0.99. I'd change my mind on seeing 30 real cases with 40%+ defendant responses.

**Q2 Status quo: 5/10.** The workaround is free and easy: ask ChatGPT, or argue in the group chat. The single-user apps give a verdict from one side's story, so the real gap is the two-sided flow. But the pain is mild, so beating free needs fun, not utility.

**Q3 Desperate specificity: 3/10.** "18–35 in a group chat of 3–10 friends, couples, roommates" is a category you can't email. The consequence is a joke, not a career or daily-cost problem. The Show HN critics' warning stands: the loser quits ("that thing always says I'm wrong"). This is a "hypothetical users" pattern.

**Q4 Narrowest wedge: 5/10.** File, summon, rule is small and the card is a good artifact. But the paid wedge has no price evidence: $3/trial and $5/print versus a $0.99 "bribe the judge" comparable. The honest narrowest version is free, with no payment layer.

**Q5 (observation, can't be answered pre-product).** Watch M1 users for: does the defendant open the summons and actually write testimony? Does the plaintiff paste the ruling back into the group chat? Where do jurors stop? What does a defendant do after losing (rage-quit, rebuttal, or a new case)? Does anyone try serious disputes?

**Q6 Future-fit: 3/10.** ChatGPT group chats (up to 20 people) and chat apps will absorb "referee our argument". A novelty with no retention and no moat gets less essential, not more.

## Premises
1. The other side wants to submit testimony: untested; supported only by critiques of single-user apps.
2. A jury of friends and a joke tone avoid the quit risk: unsupported.
3. The defendant shows up via a link (40% target): unknown, and the crux of the loop.
4. Someone pays $3 for a joke trial: contradicted by the $0.99 comparable and no paying-customer data.
5. The links make a viral loop: plausible, unmeasured. RESEARCH notes nothing on card virality.

## Alternatives
- **Minimal:** a Court mode in tiebreak (reuses voting, sharing, $5 payments). Effort S, risk low. This is RESEARCH's own recommendation.
- **Ideal:** standalone pettycourt, full M1–M4 including appeal and print. Effort L, risk high, payments need a non-Hobby host.
- **Lateral:** a free verdict-card generator as top-of-funnel for tiebreak. Effort S.

Recommendation: the minimal one, and only if tiebreak itself shows traction. David has the tiebreak repo and the idea is explicitly an overlap.

## Scope reduction (narrowest wedge)
Free summons + testimony + AI ruling + card; no jury, appeal, print or payments until defendants respond.

## M1 feasibility
- Weekend: yes. Four endpoints, no accounts.
- Zero cost: yes for a free test (Vercel Hobby, Neon free, free model). Taking payment later needs another host.
- The one test: POST /cases returns two distinct 24+ char tokens; the second defendant submission returns 409 and keeps the first; rule returns a 40–200 word ruling.
- Distribution isn't a build problem but is the whole problem: the only channel is the plaintiff pasting links into group chats.

## Risks
- No evidence of willingness to pay.
- Copyable; free ChatGPT covers the base case.
- Defendant non-response kills the loop.
- Moderation, harassment and minors burden.
- Splits focus from tiebreak.

## Kill criteria
Under 40% defendant response, under 25% of cases with 2+ jury votes, or fewer than 1 in 30 cases paying: fold into tiebreak or stop.

## Why pass
Score is under the 6 bar: there is no demand or payment evidence and the one differentiator is cheap to copy. Not worth a standalone demand test; revisit as a tiebreak mode.
