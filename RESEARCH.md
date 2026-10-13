# pettycourt — Group Chat Court (seeded: seed-169f7a)

## Summary
- Friends settle a petty argument with a mock trial: the plaintiff files a case, the defendant gets a summons link, both submit testimony, friends vote as jury, and an AI judge writes a formal ruling plus a shareable verdict card.
- The differentiator versus the many "AI judge" apps is the summons-and-jury flow, which makes the other side and the friends join. That is a growth loop, not a revenue source.
- Paid demand is the weak link: every competitor found is tiny, nobody has shown a $3–$5 purchase for a joke, and the one comparable seen with a joke purchase charges $0.99. Treat this as a growth feature to test inside tiebreak before it becomes its own product.

## Evidence of the problem
- Couples and friends already use ChatGPT to referee arguments (HuffPost via a radio site; one Reddit anecdote of a partner returning with a "well-constructed argument"). Anecdotes only, no survey data. https://greatleadership.substack.com/p/overusing-ai-tools-hurts-critical-thinking-and-human-connection
- OpenAI shipped group chats for up to 20 people in ChatGPT, and the press frames argument-settling as a use. https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-enters-the-group-chat-globally
- At least six small apps launched in 2025–2026 around the same idea (below), which shows builders believe in the demand but not that users pay.
- Critics of the category (Show HN, Piece): "assumes there is always a winner and loser", and a partner who keeps losing will say "that thing always says I'm wrong" and quit. A jury of friends plus a joke tone may soften this, but it is an unanswered risk. https://hn.svelte.dev/item/48392474

## Who pays
- **Buyer:** a friend, partner or roommate in the middle of a silly dispute; the plaintiff pays, usually on impulse.
- **Price points seen:** $0.99 "bribe the judge" (The Docket); $1.99 per charge pack and $12.99 for all packs (Camera Court, a party game with shareable "Court Postcard" photos); $2.99/week or $9.99/month subscription (Am I Wrong? AI Judge); Etsy editable certificates around $2–$10, with sellers offering custom wording. A seed price of $3 per full trial and $5 per printed verdict sits inside that range.
- **Evidence they pay today:** weak. Am I Wrong? AI Judge lists subscriptions but AppGoblin shows about 50 installs, 1 rating, and modeled revenue "under $10K" a month, a ceiling not a measurement. Camera Court has no ratings yet. The Docket has 0 reviews and 1 follower. No source shows a paying customer count. Treat willingness to pay as unproven.

## Competitors & alternatives
| Name | Price | Gap |
|---|---|---|
| ChatGPT / any chatbot | Free | No summons, no jury, no card; but the default workaround |
| The Docket (Product Hunt, built on Groq + Vercel free tiers) | Free; $0.99 "bribe the judge" | Solo submit; has fake jury % and shareable card; no real other party, no real jury |
| Am I Wrong? AI Judge (iOS, released 2026-05-29) | $2.99/week, $9.99/month | Reads chat screenshots (privacy-heavy), appeals, tones, share cards; single user, no invited defendant |
| SettleitGPT (iOS) | Subscription (price not shown) | Pass-and-play, celebrity/cartoon judges; two people on one device |
| SettleThis (iOS) | Not verified | Online invite plus pass-and-play, rationale per ruling; closest to the flow |
| Piece (couples, Show HN) | Free, credits planned | Couples only, voice-recorded, on one phone |
| Camera Court (iOS party game) | Free; $1.99 packs, $12.99 bundle | In-person game with a jury, not a dispute tool |
| Your Honor, WTF?! (itch.io) | Free | Needs the Player2 app; party game |
| Etsy certificate templates | ~$2–$10 | Static, no AI, no jury |

## Technical notes
- Text only: one free-model call for the ruling (plus one for an appeal), a verdict card rendered from an HTML/SVG template (satori or canvas), jury votes as plain rows. Fits Vercel Hobby plus free Postgres for a test; taking payments later needs a commercial-use host or Stripe on a different host (Vercel Hobby forbids commercial use).
- Summons flow: signed unguessable URL per case, no accounts; defendant and jurors join by link; cases expire and can be deleted by either party.
- Safety layer: classifier pass up front declines abuse, health, money, minors, and anything naming non-participants; no chat screenshots in MVP, so nothing private is read unless pasted by a participant; a "not legal advice, entertainment" line on every page; report/takedown link on cards.
- A printable framed verdict needs print-on-demand per order (not researched here; cost and fulfilment unverified), so keep it out of M1.

## Risks & open questions
- Crowded: at least six AI-judge apps already exist and ChatGPT does it free; the flow is the only difference and it is copyable in a weekend.
- Novelty decay: a joke buys once; no repeat use, no retention evidence.
- The invite loop needs the defendant to actually show up and write testimony. Completion rate is unknown; a refused summons kills the case.
- Losers quit (critics above); jury votes may feel like public shaming and hurt relationships. Avoid harassment: a case can name only participants who join.
- Moderation burden for a near-zero-time owner; minors; harassment cases dressed as petty disputes.
- Gap in this research: no sales or download numbers beyond modeled AppGoblin estimates, nothing on TikTok/social virality of verdict cards, and no Etsy listing found for mock-court verdicts, so there is no direct signal that people buy printed verdicts.
- Overlap with tiebreak (live, two-option polls with voting and sharing and $5 payments). The jury vote is a poll; a "Court" mode in tiebreak reuses its voting, sharing and payments at much lower cost.

## Sources
- https://apps.apple.com/us/app/settleitgpt/id6743547528
- https://appgoblin.info/apps/6768784454
- https://www.producthunt.com/p/the-docket
- https://hn.svelte.dev/item/48392474
- https://apps.apple.com/app/6758064048
- https://mwm.ai/apps/ai-judgement/6748558666
- https://magmaroni.itch.io/your-honor-wtf
- https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-enters-the-group-chat-globally
- https://greatleadership.substack.com/p/overusing-ai-tools-hurts-critical-thinking-and-human-connection
- https://www.etsy.com/listing/4429806679/printable-gift-certificates-bundle
