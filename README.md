# pettycourt — Group Chat Court: a mock trial for petty arguments

**Live:** https://pettycourt.1426davejobs.workers.dev (a Cloudflare Worker since 2026-11-08; BUILD.md, "Deploy on a free tier").

## On the live site (2026-11-08)

Taken in Chromium against https://pettycourt.1426davejobs.workers.dev, at 1280×800 and as an iPhone 13, during one real case: filed, answered, ruled on by the live judge and then deleted.

![The live start page on desktop](docs/screenshots/live-home-desktop.png)
![The live start page on an iPhone 13](docs/screenshots/live-home-mobile.png)
![The live summons page on desktop](docs/screenshots/live-summons-desktop.png)
![The live summons page on an iPhone 13](docs/screenshots/live-summons-mobile.png)
![The live verdict on desktop: "Verdict: Split decision" in the case of the vanishing leftovers](docs/screenshots/live-verdict-desktop.png)
![The live verdict on an iPhone 13](docs/screenshots/live-verdict-mobile.png)

## Screenshots (local app)

Taken by `npm run screenshots` against the local app (stub judge, sample data, and a placeholder `STRIPE_PAYMENT_LINK` of https://example.com/pay), in Chromium at 1280×800 and as an iPhone 13, during one real trial with separate browsers for the plaintiff, the defendant and three jurors.

![The start page with a petty case typed in, on a desktop](docs/screenshots/home-desktop.png)
The start page: a plaintiff types in "The Great Shower Affair" and files it. Filing a case is the core action.

![The same filing form on a phone](docs/screenshots/home-mobile.png)
The filing form works on a phone.

![The summons page with the defendant's answer typed in, on a desktop](docs/screenshots/summons-desktop.png)
The other side opens the summons link, reads the charge and the plaintiff's testimony, and answers.

![The defendant's answer on the summons page, on a phone](docs/screenshots/summons-mobile.png)
The defendant answers from a phone, the way a summons arrives from the group chat.

![The bottom of the case page after the ruling: the verdict card, and the footer's Terms, Privacy and Contact links](docs/screenshots/verdict-desktop.png)
The result: the judge's split decision and the jury's 2–1 vote on the shareable verdict card, with the footer's Terms, Privacy and Contact links.

![The Buy the appeal · $3 button above the jury's split and comments, on a phone](docs/screenshots/verdict-mobile.png)
After the ruling, the "Buy the appeal · $3" button (shown because `STRIPE_PAYMENT_LINK` is set) sits above the jury's 2–1 split and comments.

For friends, couples and roommates in a petty dispute, it turns the argument into a summons link, a friend jury and an AI judge's funny ruling on a shareable card, and the invite brings the other side in.

- [Research](RESEARCH.md) — findings and sources
- [PRD](PRD.md)
- [Roadmap](ROADMAP.md)
- [Build notes](BUILD.md): what's built, how to run, test and deploy it
- [Launch readiness](LAUNCH-READY.md): search and sharing, legal pages, the Buy button, launch counts, and what's left before launch

Effort: Low · Confidence: Low

_Researched by the idea pipeline on 2026-10-13 ([original record](https://github.com/smithdavedesign/idea-factory/tree/main/ideas/pettycourt)); repo created on David's go-ahead 2026-10-13._
