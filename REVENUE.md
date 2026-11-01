# pettycourt: road to first dollar

**Plain answer: the evidence says almost nobody will pay.** The review scored it 4/10, and the demand and payment evidence is about 2/10. No source shows a paying customer for a joke-verdict app. The best case is a $3 one-time unlock, and the realistic expectation is $0 to a few dollars from the first 30 cases. David chose to build it anyway (2026-10-13), so this is the cheapest honest way to find out.

## Evidence strength
- **Who pays:** the plaintiff, an 18–35 year old mid-dispute in a group chat, a couple or a roommate house. They pay on impulse, from a personal card, and the amount is pocket change. They have no budget line. This is a category, not a findable person. *Strength: weak.*
- **What they pay today:** $0. They use ChatGPT or argue in the chat. *Strong evidence that the status quo is free.*
- **Competitor prices (fresh search, 2026-11-01):**
  - Squabbler: free for 2 arguments a day, Pro about $7.99/month with a 3-day trial ([appshunter](https://appshunter.io/ios/app/squabbler/id6780685865)).
  - SettleitGPT: subscription for unlimited arguments, price not shown ([App Store](https://apps.apple.com/us/app/settleitgpt/id6743547528)).
  - SettleThis: free with in-app purchases, price not found ([App Store](https://apps.apple.com/us/app/settlethis/id6745844056)).
  - From the research file: The Docket $0.99, Camera Court $1.99 per pack, Am I Wrong? $2.99/week or $9.99/month. The last one has about 50 installs and 1 rating ([AppGoblin](https://appgoblin.info/apps/6768784454)).
  - A joke legal-themed greeting card sells for about $3.89 ([Greeting Card Universe](https://Greetingcarduniverse.com/holidays/lawday/humorous-law-day-card-with-1492948)). I found no Etsy listing for a mock-court verdict.
  - Conclusion: the market is full of subscriptions with no visible paying-customer counts. A one-time purchase of $3 or less is the only price that fits an impulse joke.
- **Narrowest version worth paying for:** the free ruling and card stay free, because the card is the growth loop. Pay $3 once per case to unlock the jury, exhibits and one appeal. This is the PRD's design. Don't charge before a case has a defendant answer and 2 or more jury votes, since that is the moment someone cares about the appeal.

## Shortest path
1. **Host.** Vercel Hobby bars commercial use (research notes). Deploy on Cloudflare Pages/Workers or Netlify free tier before any payment link is live. Verify their current terms first.
2. **Stripe Payment Link at $3**, created by David. Pass the case id as `client_reference_id`. The success URL goes to `/cases/:id?paid=1`. Mark the case paid from a Stripe webhook if M4 has one. Otherwise use a manual check for the first few sales, since volume will be tiny.
3. **Legal pages:** privacy, terms, "entertainment, not legal advice", 18+ only, report/delete link. These must be live before charging.
4. **Seed 30 real cases** (see the channels in revenue.json). Measure against the PRD thresholds: 40% defendant response, 25% with 2+ jury votes, 1 or more of 30 paying.
5. **Start with the fake-door button** (M3). Take the real Stripe link live only if clicks reach 2% or more of cases. This costs nothing and avoids paying fees on a dead product.

## Risks, plainly
- Free ChatGPT does the base job, and the flow can be copied in a weekend.
- A joke buys once. There is no retention.
- If the defendant doesn't show, the loop is dead.
- Stripe takes 2.9% + $0.30, so a $3 sale nets about $2.61.
- Moderation and minors burden for a near-zero-time owner.
- Thirty cases need distribution, and the only channel is plaintiffs pasting links. David will probably have to seed cases himself with friends.

## Assignment
Run 5 cases with David's own friends this week. Watch whether the defendant answers. If the answer is no in 3 of 5, stop.

## Recommendation
Fold into tiebreak as a "Court" mode if the 30-case test misses. That reuses tiebreak's voting and $5 payment.
