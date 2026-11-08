// Server-rendered pages. Every interpolation goes through Hono's `html` tag, which escapes user and
// model text. The one `raw` is the public pages' JSON-LD (src/seo.js), which holds no user or model text
// and escapes `<`. Pages never print a token except on the page reached through that same token (the
// summons page, the jury page) or the plaintiff's private page, which shows the links the plaintiff was
// given at filing. The plaintiff token is never on a page anyone else sees.

import { html, raw } from 'hono/html';
import { VERDICT_LABELS } from './judge.js';
import { APPEAL_PRICE_LABEL } from './payments.js';
import { DECLINE_MESSAGE } from './scope.js';
import { ISSUES_URL, SHARE_IMAGE, SITE_NAME } from './seo.js';
import { APPEAL_SIDES, REPORT_REASONS, RETENTION_MS } from './store.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
export const COMMENT_MAX = 140;
export const NOTE_MAX = 500;
export const EMAIL_MAX = 254;
export const EVIDENCE_MAX = 1000;
export const REFUND_DAYS = 14;
export const UNLOCK_MESSAGE = "Payments aren't switched on yet, so nothing was charged.";
/** The fake-door click's answer once payments are on (the page uses Checkout then; the API still records interest). */
export const UNLOCK_INTEREST_MESSAGE = 'Nothing was charged: this only records interest. The appeal is paid through Stripe Checkout after the ruling.';

/** How pages name the appellant; keys match APPEAL_SIDES. */
const APPELLANT_LABELS = { plaintiff: 'The plaintiff', defendant: 'The defendant' };
const day = (date) => date.toISOString().slice(0, 10);

const REPORT_LABELS = {
  names_someone: "It names or describes someone who isn't part of the argument",
  serious: "It's about something serious: abuse, health, money or minors",
  mean: "It's bullying or harassment, not a joke",
  other: 'Something else',
};

/**
 * When the expiry job deletes this case. It runs once a day (04:17 UTC, src/schedule.js), so a case goes
 * at the first run after it turns 30 days old: on that day (UTC) or the next.
 */
const deletionNote = (c) => {
  const day = new Date(c.createdAt.getTime() + RETENTION_MS).toISOString().slice(0, 10);
  return `This case is deleted automatically 30 days after filing, on ${day} or the day after.`;
};

/** "2 guilty · 1 not guilty" — the same words as the verdict card. */
export const juryLine = (jury) => `${jury.guilty} guilty · ${jury.notGuilty} not guilty`;

/** "23 hours" / "1 hour" / "12 minutes"; null once the deadline has passed. */
export function timeLeft(deadline, now) {
  const ms = deadline.getTime() - now.getTime();
  if (ms <= 0) return null;
  const hours = Math.floor(ms / HOUR);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.ceil(ms / MINUTE));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// A case is shared by its links and listed nowhere, so every page but the public ones asks not to be indexed.
const NOINDEX = html`<meta name="robots" content="noindex">
`;

/**
 * The <head> of a public page (go-live): description, canonical, Open Graph and Twitter cards with the
 * share image, and the JSON-LD.
 * @param {ReturnType<typeof import('./seo.js').pageMeta>} meta
 */
function seoHead(meta) {
  return html`<meta name="description" content="${meta.description}">
<link rel="canonical" href="${meta.canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${meta.title}">
<meta property="og:description" content="${meta.description}">
<meta property="og:url" content="${meta.canonical}">
<meta property="og:image" content="${meta.image}">
<meta property="og:image:width" content="${SHARE_IMAGE.width}">
<meta property="og:image:height" content="${SHARE_IMAGE.height}">
<meta property="og:image:alt" content="${SHARE_IMAGE.alt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${meta.title}">
<meta name="twitter:description" content="${meta.description}">
<meta name="twitter:image" content="${meta.image}">
<script type="application/ld+json">${raw(meta.jsonLd)}</script>
`;
}

/**
 * @param {{ title: string, body: unknown, head?: unknown, visit?: { caseId: string, plaintiff?: boolean } | null,
 *   meta?: ReturnType<typeof import('./seo.js').pageMeta> | null }} page
 *   visit (M5): the page shows this case, so the client script counts the browser as a visitor once
 *   (or, with `plaintiff`, remembers it as the plaintiff's and never counts it).
 *   meta (go-live): a public page, so it's indexable and gets its own title and the SEO <head>; every
 *   other page stays noindex.
 */
function layout({ title, body, head = '', visit = null, meta = null }) {
  const main = visit
    ? html`<main data-visit="${visit.caseId}"${visit.plaintiff ? html` data-visitor="plaintiff"` : ''}>`
    : html`<main>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${meta ? seoHead(meta) : NOINDEX}<title>${meta ? meta.title : `${title} · ${SITE_NAME}`}</title>
${head}<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
${main}
${body}
</main>
<footer><a href="/">Group Chat Court</a>: a mock trial for petty arguments. Rulings are jokes, not legal advice. <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="${ISSUES_URL}">Contact</a></footer>
</body>
</html>`;
}

const statusLine = html`<p class="status" data-status role="status" aria-live="polite"></p>`;

/** The delete button for a party: `token` is their plaintiff or summons token, sent as a bearer token. */
function deleteSection(caseId, token) {
  return html`<section class="danger"><h2>Delete this case</h2>
<p>This deletes the case for everyone: both testimonies, the ruling, the jury's votes and comments, and the verdict card. It can't be undone.</p>
<form data-api="/cases/${caseId}" data-method="DELETE" data-token="${token}" data-confirm="Delete this case for everyone? This can't be undone." data-then="deleted" data-pending="Deleting the case…">
  <button>Delete this case</button>
  ${statusLine}
</form></section>`;
}

/** "Report this case": anyone with a link to the case can take it down. */
function reportForm(c) {
  return html`<details class="report"><summary>Report this case</summary>
<form data-api="/reports" data-then="reload" data-pending="Sending your report…">
  <input type="hidden" name="caseId" value="${c.id}">
  <fieldset>
    <legend>What's wrong with it?</legend>
    ${REPORT_REASONS.map(
      (reason) =>
        html`<label class="choice"><input type="radio" name="reason" value="${reason}" required> ${REPORT_LABELS[reason]}</label>`,
    )}
  </fieldset>
  <label>Anything else? <span class="optional">(optional)</span>
    <textarea name="note" maxlength="${NOTE_MAX}" rows="2"></textarea>
  </label>
  <p class="small">Reporting takes the case down for everyone straight away.</p>
  <button>Report and take it down</button>
  ${statusLine}
</form></details>`;
}

/** How long the operator takes to confirm a Payment Link payment by hand and email the appeal link. */
export const MANUAL_CONFIRM_DAYS = 2;

/**
 * "Full trial · $3". With payments on it's a Buy button (data-buy, which the client script reports as a
 * RepoHQ "checkout"), offered once the case is ruled and until it's paid; the appeal section takes over
 * after that. `checkout` is 'stripe' (M4's Checkout Session, confirmed by Stripe) or 'link' (go-live: the
 * Stripe Payment Link from STRIPE_PAYMENT_LINK, confirmed by hand). Without either it's M3's fake door.
 */
function unlockSection(c, { checkout }) {
  if (!checkout) return fakeDoor(c);
  if (c.appealedAt) return null;
  const byLink = checkout === 'link';
  if (c.paidAt) {
    return html`<section class="unlock"><h2>Full trial · paid</h2>
<p>This case's appeal is paid for. Whoever paid files it from ${
      byLink
        ? 'the link we emailed them'
        : 'the page Stripe sent them back to, which is also linked in their receipt email'
    }.</p></section>`;
  }
  if (!c.ruledAt) {
    return html`<section class="unlock"><h2>Full trial · $3</h2>
<p>After the ruling, either side can appeal once for $3: bring new evidence, and the judge hears the case again.</p></section>`;
  }
  return html`<section class="unlock"><h2>Full trial · $3</h2>
<p>Not happy with the verdict? Bring new evidence and the judge hears the case again. One appeal per case, filed by whoever pays.</p>
<form data-api="/cases/${c.id}/checkout" data-then="redirect" data-buy data-pending="Opening the secure checkout…">
  <button>${byLink ? 'Buy the appeal · $3' : 'Appeal the verdict · $3'}</button>
  ${statusLine}
</form>
<p class="small">${
    byLink
      ? `Payment by Stripe. We confirm payments by hand, then email you the link to file your appeal within ${MANUAL_CONFIRM_DAYS} days.`
      : 'Payment by Stripe, which emails your receipt with the link to your appeal.'
  } By paying you agree to the <a href="/terms">terms</a>. Refunds on request within ${REFUND_DAYS} days.</p>
</section>`;
}

/**
 * The fake door (M3, and M4 without payments configured): the click is recorded before anything says
 * payments aren't live, so the click count measures intent to pay. The email step is optional and only
 * appears after the click.
 */
function fakeDoor(c) {
  return html`<section class="unlock"><h2>Full trial · $3</h2>
<p>One appeal with new evidence after the ruling: the judge hears the case again.</p>
<form data-api="/cases/${c.id}/unlock" data-then="reveal" data-reveal="unlock-email" data-pending="One moment…">
  <button>Unlock the full trial · $3</button>
  ${statusLine}
</form>
<div id="unlock-email" hidden>
<p><strong>${UNLOCK_MESSAGE}</strong> The full trial isn't open yet. Want an email when it is?</p>
<form data-api="/cases/${c.id}/unlock/email" data-then="reveal" data-reveal="unlock-thanks" data-pending="Saving…">
  <input type="hidden" name="clickId" data-field="clickId">
  <label>Email <input type="email" name="email" maxlength="${EMAIL_MAX}" required autocomplete="email"></label>
  <p class="small">We'll only use it to tell you once if the full trial opens. It's deleted with this case, 30 days after filing at the latest.</p>
  <button>Email me</button>
  ${statusLine}
</form></div>
<p id="unlock-thanks" hidden>Thanks. We'll email you once if the full trial opens.</p>
</section>`;
}

/** @param {{ meta?: ReturnType<typeof import('./seo.js').pageMeta> | null }} [site] */
export function homePage({ meta = null } = {}) {
  return layout({
    title: 'File a case',
    meta,
    body: html`<p class="kicker">Group Chat Court</p>
<h1>Settle it in court.</h1>
<p class="lede">File a petty case, send the other side a summons link, let your friends vote as the jury, and let an AI judge rule on both stories. Free.</p>
<form data-api="/cases" data-then="reveal" data-reveal="filed" data-pending="Filing your case…">
  <label>Case title <span class="optional">(optional)</span>
    <input name="title" maxlength="120" placeholder="The Great Shower Affair">
  </label>
  <label>The charge
    <input name="charge" maxlength="280" required placeholder="Said &quot;five minutes away&quot; while still in the shower">
  </label>
  <label>Your testimony
    <textarea name="testimony" maxlength="2000" rows="6" required placeholder="Tell the court what happened."></textarea>
  </label>
  <p class="small">Petty disputes only: no abuse, health, money or minors. You must be 18 or older, and please don't name anyone who isn't part of the argument. The judge is an AI model (Google Gemini's free tier), so what you write is sent to Google and may be used to improve its products. Cases are deleted automatically 30 days after filing, and either side can delete one sooner.</p>
  <button>File the case</button>
  ${statusLine}
</form>
<section id="filed" hidden>
  <h2>Case filed.</h2>
  <p>Send this <strong>summons link</strong> to the other side. They have 24 hours to answer before the judge rules without them.</p>
  <p class="copy"><input readonly data-field="summonsUrl" aria-label="Summons link"> <button type="button" data-copy="summonsUrl">Copy link</button></p>
  <p>Send this <strong>jury link</strong> to the group chat. Anyone with it can vote guilty or not guilty, once per device.</p>
  <p class="copy"><input readonly data-field="juryUrl" aria-label="Jury link"> <button type="button" data-copy="juryUrl">Copy link</button></p>
  <p>Keep this <strong>plaintiff link</strong> to yourself. It shows these links again and lets you delete the case, so don't share it.</p>
  <p class="copy"><input readonly data-field="plaintiffUrl" aria-label="Plaintiff link"> <button type="button" data-copy="plaintiffUrl">Copy link</button></p>
  <p>Keep the <a data-field="caseUrl" href="/">case page</a>: that's where the ruling, the jury's votes and the verdict card will appear. Save your plaintiff link now, because it can't be shown again.</p>
</section>`,
  });
}

/**
 * The plaintiff's private page, reached only through the plaintiff token: the links again, and delete.
 * @param {import('./store.js').Case} c
 * @param {Date} now
 * @param {{ origin: string }} site
 */
export function plaintiffPage(c, now, { origin }) {
  const left = timeLeft(c.deadlineAt, now);
  let state;
  if (c.declinedAt) state = html`<p>The court declined to hear this case, so its summons and jury are closed.</p>`;
  else if (c.ruledAt) {
    state = html`<p><strong>Verdict: ${VERDICT_LABELS[c.verdict]}</strong>${
      c.appealRuledAt && html`. <strong>On appeal: ${VERDICT_LABELS[c.appealVerdict]}</strong> (${appealOutcome(c)})`
    }. The jury link still takes votes.</p>`;
  }
  else if (c.defendantTestimony !== null) {
    state = html`<p>The defendant has answered. <a href="/cases/${c.id}">Call the judge on the case page</a>.</p>`;
  } else if (left) state = html`<p>Waiting for the defendant: ${left} left to answer.</p>`;
  else state = html`<p>The defendant failed to appear. <a href="/cases/${c.id}">Call the judge on the case page</a>.</p>`;

  const links =
    !c.declinedAt &&
    html`<section><h2>Your links</h2>
<p>The <strong>summons link</strong> for the other side:</p>
<p class="copy"><input readonly value="${origin}/summons/${c.summonsToken}" data-field="summonsUrl" aria-label="Summons link"> <button type="button" data-copy="summonsUrl">Copy link</button></p>
<p>The <strong>jury link</strong> for the group chat:</p>
<p class="copy"><input readonly value="${origin}/jury/${c.juryToken}" data-field="juryUrl" aria-label="Jury link"> <button type="button" data-copy="juryUrl">Copy link</button></p></section>`;

  return layout({
    title: `Plaintiff's desk: ${c.title}`,
    visit: { caseId: c.id, plaintiff: true },
    body: html`<p class="kicker">Group Chat Court · Plaintiff's desk</p>
<h1>${c.title}</h1>
<p class="lede">This is your private plaintiff link. Don't share it: anyone with it can delete the case.</p>
<section><h2>Where the case stands</h2>${state}</section>
${links}
<p><a href="/cases/${c.id}">Open the case page</a>, which you can share with anyone.</p>
<p class="small">${deletionNote(c)}</p>
${deleteSection(c.id, c.plaintiffToken)}`,
  });
}

/**
 * What every page of a reported case shows instead of its content. A party (who reached the page
 * through their own token) also gets the delete button; someone who paid for its appeal (refundTo set,
 * to the contact address or '' if none is published) is told they're owed a refund.
 * @param {{ caseId?: string, token?: string, refundTo?: string | null }} [party]
 */
export function takenDownPage({ caseId, token, refundTo = null } = {}) {
  return layout({
    title: 'Case taken down',
    body: html`<p class="kicker">Group Chat Court</p>
<h1>This case was taken down.</h1>
<p>Someone reported it, so the court took it down for everyone and no longer shows what's in it.</p>
${refundTo !== null && html`<p>You paid for an appeal on this case, which can't be heard now, so you're owed a refund: ${refundLine(refundTo || null)}.</p>`}
${
  token
    ? html`<p>As one of the parties, you can delete it now. Otherwise it's deleted automatically 30 days after it was filed.</p>
${deleteSection(caseId, token)}`
    : html`<p>It's deleted automatically 30 days after it was filed.</p>`
}
<p><a href="/">File a petty case of your own</a></p>`,
  });
}

export function deletedPage() {
  return layout({
    title: 'Case deleted',
    body: html`<h1>The case is deleted.</h1>
<p>Both testimonies, the ruling, the jury's votes and the verdict card are gone from Group Chat Court. Copies outside it, such as a downloaded card or a chat app's link preview, are out of our reach.</p>
<p><a href="/">File a new case</a></p>`,
  });
}

/** @param {import('./store.js').Case} c */
export function summonsPage(c, now) {
  const closed = c.ruledAt || c.declinedAt;
  const left = timeLeft(c.deadlineAt, now);
  let answer;
  if (closed) {
    answer = html`<section><h2>This case is closed.</h2>
<p>${c.ruledAt ? 'The court has already ruled.' : 'The court declined to hear it.'} <a href="/cases/${c.id}">Read the case</a>.</p></section>`;
  } else if (c.defendantTestimony !== null) {
    answer = html`<section><h2>Your testimony is on the record</h2>
<p class="testimony">${c.defendantTestimony}</p>
<p><a href="/cases/${c.id}">Go to the case page</a> to call the judge.</p></section>`;
  } else {
    answer = html`<section><h2>Your testimony</h2>
<p>${left ? `You have ${left} to answer.` : "The deadline has passed, but the judge hasn't ruled yet, so you can still answer."} You can only answer once.</p>
<form data-api="/summons/${c.summonsToken}/testimony" data-pending="Submitting your testimony…">
  <label>Tell the court your side
    <textarea name="testimony" maxlength="2000" rows="6" required></textarea>
  </label>
  <p class="small">Petty disputes only, and you must be 18 or older. The judge is an AI model (Google Gemini's free tier), so what you write is sent to Google and may be used to improve its products. Rulings are jokes, not legal advice.</p>
  <button>Submit my testimony</button>
  ${statusLine}
</form></section>`;
  }
  return layout({
    title: 'You have been summoned',
    visit: { caseId: c.id },
    body: html`<p class="kicker">Group Chat Court · Summons</p>
<h1>You've been summoned.</h1>
<p class="lede">Case: <strong>${c.title}</strong></p>
<section><h2>The charge</h2><p class="charge">${c.charge}</p></section>
<section><h2>The plaintiff's testimony</h2><p class="testimony">${c.plaintiffTestimony}</p></section>
${answer}
<p class="small">${deletionNote(c)} You don't have to wait: as the defendant, you can delete it now.</p>
${deleteSection(c.id, c.summonsToken)}
${reportForm(c)}`,
  });
}

/** The defendant failed to appear: no answer and the deadline has passed. */
const isNoShow = (c, now) => c.defendantTestimony === null && !timeLeft(c.deadlineAt, now);

/** Charge and both testimonies, as the case page and the jury page show them. */
function trialRecord(c, now) {
  const left = timeLeft(c.deadlineAt, now);
  let defence;
  if (c.defendantTestimony !== null) defence = html`<p class="testimony">${c.defendantTestimony}</p>`;
  else if (!left) defence = html`<p class="absent">The defendant failed to appear before the deadline.</p>`;
  else defence = html`<p class="absent">Waiting for the defendant: ${left} left to answer.</p>`;
  return html`<section><h2>The charge</h2><p class="charge">${c.charge}</p></section>
<section><h2>The plaintiff's testimony</h2><p class="testimony">${c.plaintiffTestimony}</p></section>
<section><h2>The defendant's testimony</h2>${defence}</section>`;
}

const verdictSection = (c) => html`<section class="verdict"><h2>Verdict: ${VERDICT_LABELS[c.verdict]}</h2>
<p class="ruling">${c.ruling}</p>
<p class="small">An AI judge wrote this ruling for fun. It is not legal advice.</p></section>`;

/** "upheld" when the appeal kept the verdict, "overturned" when it changed it. */
export const appealOutcome = (c) => (c.appealVerdict === c.verdict ? 'upheld' : 'overturned');

/**
 * The appeal, once filed: the new evidence and the verdict on appeal. A declined appeal hides the
 * evidence and keeps the original ruling. `actions` adds "Hear the appeal" while it's unheard.
 * @param {import('./store.js').Case} c
 */
function appealSection(c, { actions }) {
  if (!c.appealedAt) return null;
  const who = APPELLANT_LABELS[c.appealSide];
  if (c.appealDeclinedAt) {
    return html`<section class="verdict appeal"><h2>The court declines to hear the appeal</h2>
<p>${who} appealed, but ${DECLINE_MESSAGE}</p>
<p>The original ruling stands.</p></section>`;
  }
  const evidence = html`<p>${who} appealed with new evidence:</p>
<p class="testimony">${c.appealEvidence}</p>`;
  if (c.appealRuledAt) {
    return html`<section class="verdict appeal"><h2>Verdict on appeal: ${VERDICT_LABELS[c.appealVerdict]} (${appealOutcome(c)})</h2>
${evidence}
<p class="ruling">${c.appealRuling}</p>
<p class="small">An AI judge wrote this ruling for fun. It is not legal advice.</p></section>`;
  }
  return html`<section class="appeal"><h2>On appeal</h2>
${evidence}
<p>The judge hasn't heard the appeal yet.</p>
${
  actions &&
  html`<form data-api="/cases/${c.id}/appeal/rule" data-then="reload" data-pending="The judge is hearing the appeal…">
  <button>Hear the appeal</button>
  ${statusLine}
</form>`
}</section>`;
}

/**
 * @param {import('./store.js').Case} c
 * @param {Date} now
 * @param {{ jury: import('./store.js').JuryTally | null, comments: import('./store.js').Vote[], origin: string,
 *   checkout?: 'stripe' | 'link' | null }} jurySide
 *   jury is null on a declined case, which shows neither the jury nor the card. checkout: payments are
 *   on, so "Full trial · $3" is a Buy button (M4's Stripe Checkout, or go-live's Payment Link) rather
 *   than the fake door.
 */
export function casePage(c, now, { jury, comments, origin, checkout = null }) {
  const noShow = isNoShow(c, now);
  const cardPath = `/cases/${c.id}/card.png`;

  let outcome;
  if (c.ruledAt) {
    outcome = verdictSection(c);
  } else if (c.declinedAt) {
    outcome = html`<section class="verdict"><h2>The court declines to rule</h2><p>${DECLINE_MESSAGE}</p></section>`;
  } else if (c.defendantTestimony !== null || noShow) {
    outcome = html`<form data-api="/cases/${c.id}/rule" data-pending="The judge is deliberating…">
  <button>Call the judge</button>
  ${statusLine}
</form>`;
  } else {
    outcome = html`<p>The judge rules once the defendant answers or the deadline passes.</p>`;
  }

  const jurySection =
    jury &&
    html`<section class="jury"><h2>The jury</h2>
${jury.total ? html`<p class="split">${juryLine(jury)}</p>` : html`<p class="absent">No jury votes yet.</p>`}
${
  comments.length > 0 &&
  html`<ul class="comments">${comments.map(
    (v) => html`<li class="comment"><strong>${VERDICT_LABELS[v.vote]}</strong>: “${v.comment}”</li>`,
  )}</ul>`
}
</section>`;

  const cardSection =
    jury &&
    c.ruledAt &&
    html`<section class="card"><h2>The verdict card</h2>
<p><img src="${cardPath}" width="1080" height="1350" alt="Verdict card: ${c.title}, ${VERDICT_LABELS[c.appealRuledAt ? c.appealVerdict : c.verdict]}"></p>
<p><a href="${cardPath}" download="group-chat-court-verdict.png">Download the verdict card</a> and post it in the group chat.</p></section>`;

  // Link previews in chat apps show the card; a declined case gets no shareable image.
  const head =
    jury &&
    html`<meta property="og:title" content="${c.title}">
<meta property="og:image" content="${origin}${cardPath}">
<meta property="og:image:width" content="1080">
<meta property="og:image:height" content="1350">
<meta name="twitter:card" content="summary_large_image">
`;

  return layout({
    title: c.title,
    head,
    visit: { caseId: c.id },
    body: html`<p class="kicker">Group Chat Court · Case file</p>
<h1>${c.title}</h1>
${trialRecord(c, now)}
${outcome}
${appealSection(c, { actions: true })}
${jury && unlockSection(c, { checkout })}
${jurySection}
${cardSection}
<p class="small">${deletionNote(c)}</p>
${reportForm(c)}`,
  });
}

/**
 * The jury link's page. The split only shows once this device has voted, so jurors aren't herded.
 * @param {import('./store.js').Case} c
 * @param {Date} now
 * @param {{ mine: import('./store.js').Vote | null, jury: import('./store.js').JuryTally | null }} juror
 */
export function juryPage(c, now, { mine, jury }) {
  if (c.declinedAt) {
    return layout({
      title: 'Jury duty',
      body: html`<p class="kicker">Group Chat Court · Jury duty</p>
<h1>This case is closed.</h1>
<p>The court declined to hear it, so there is nothing to vote on.</p>
<p><a href="/">File a petty case of your own</a></p>`,
    });
  }

  let ballot;
  if (mine) {
    ballot = html`<section class="jury"><h2>Your vote: ${VERDICT_LABELS[mine.vote]}</h2>
${mine.comment && html`<p class="testimony">“${mine.comment}”</p>`}
<p>The jury so far: <strong>${juryLine(jury)}</strong>.</p>
<p><a href="/cases/${c.id}">Go to the case page</a> to see the jury's comments${c.ruledAt ? '' : ' and the ruling when it comes'}.</p></section>`;
  } else {
    ballot = html`<section><h2>Your vote</h2>
<form data-api="/jury/${c.juryToken}/votes" data-then="reload" data-pending="Casting your vote…">
  <fieldset>
    <legend>Is the defendant guilty?</legend>
    <label class="choice"><input type="radio" name="vote" value="guilty" required> Guilty</label>
    <label class="choice"><input type="radio" name="vote" value="not_guilty"> Not guilty</label>
  </fieldset>
  <label>One-line comment <span class="optional">(optional)</span>
    <input name="comment" maxlength="${COMMENT_MAX}" placeholder="Showers do not count as travel.">
  </label>
  <p class="small">One vote per device. Your comment appears on the case page, so keep it petty and don't name anyone who isn't part of the argument. You must be 18 or older.</p>
  <button>Cast my vote</button>
  ${statusLine}
</form></section>`;
  }

  return layout({
    title: 'Jury duty',
    visit: { caseId: c.id },
    body: html`<p class="kicker">Group Chat Court · Jury duty</p>
<h1>You're on the jury.</h1>
<p class="lede">Case: <strong>${c.title}</strong></p>
${trialRecord(c, now)}
${c.ruledAt && verdictSection(c)}
${appealSection(c, { actions: false })}
${ballot}
${reportForm(c)}`,
  });
}

const SIDE_CHOICES = { plaintiff: "I'm the plaintiff (I filed the case)", defendant: "I'm the defendant (I was summoned)" };

/** "email court@example.com" as a link, or the repo's issues when no address is published. */
const contactLine = (contactEmail) =>
  contactEmail
    ? html`email <a href="mailto:${contactEmail}">${contactEmail}</a>`
    : html`open an issue at <a href="${ISSUES_URL}">${ISSUES_URL.replace('https://', '')}</a>`;

/** How a payer asks for a refund: by email with their appeal link, or in a public issue without it. */
const refundLine = (contactEmail) =>
  contactEmail
    ? html`${contactLine(contactEmail)} with this page's link`
    : html`${contactLine(null)} with the receipt number from Stripe's email. Issues are public, so don't post this page's link there`;

/**
 * The payer's page, reached through their click id (Stripe's success URL and the receipt's link):
 * the payment, then the appeal form, then the appeal.
 * @param {import('./store.js').Case} c
 * @param {import('./store.js').Click} click
 * @param {{ contactEmail: string | null, checking: boolean, receiptLinks?: boolean }} options  checking: Stripe
 *   couldn't be asked just now. receiptLinks: Stripe's receipt links back here (M4's Checkout; not a Payment
 *   Link, whose payments the operator confirms by hand and answers with this page's link).
 */
export function appealPage(c, click, { contactEmail, checking, receiptLinks = true }) {
  let body;
  if (!click.paidAt) {
    const status = checking
      ? html`We couldn't confirm the payment with Stripe just now.`
      : html`We haven't received this payment yet.`;
    body = html`<p>${status} If you've just paid, reload this page in a minute. Otherwise <a href="/cases/${c.id}">go back to the case</a> to try again.</p>`;
  } else {
    const receipt = html`<p class="paid">Paid ${APPEAL_PRICE_LABEL} on ${day(click.paidAt)}.${
      receiptLinks ? ' Stripe emails your receipt, with a link back to this page.' : ''
    } Keep this page's link: it's your appeal.</p>`;
    if (c.appealedAt && c.appealClickId !== click.id) {
      body = html`${receipt}
<p>Someone else already filed this case's one appeal, so your payment bought nothing. You're owed a refund: ${refundLine(contactEmail)}.</p>
${appealSection(c, { actions: false })}`;
    } else if (c.appealedAt) {
      body = html`${receipt}
${appealSection(c, { actions: true })}
<p><a href="/cases/${c.id}">Go to the case page</a> to see it with the jury and the verdict card.</p>`;
    } else {
      body = html`${receipt}
${verdictSection(c)}
<section><h2>File your appeal</h2>
<form data-api="/cases/${c.id}/appeal" data-token="${click.id}" data-then="reload" data-pending="The judge is hearing your appeal…">
  <fieldset>
    <legend>Who's appealing?</legend>
    ${APPEAL_SIDES.map(
      (side) => html`<label class="choice"><input type="radio" name="side" value="${side}" required> ${SIDE_CHOICES[side]}</label>`,
    )}
  </fieldset>
  <label>Your new evidence
    <textarea name="evidence" maxlength="${EVIDENCE_MAX}" rows="5" required placeholder="Exhibit A: the screenshot that changes everything."></textarea>
  </label>
  <p class="small">One appeal per case: once it's filed it can't be changed. Petty disputes only, and you must be 18 or older. The judge is an AI model (Google Gemini's free tier), so what you write is sent to Google and may be used to improve its products.</p>
  <button>File the appeal</button>
  ${statusLine}
</form></section>`;
    }
  }
  return layout({
    title: `Your appeal: ${c.title}`,
    body: html`<p class="kicker">Group Chat Court · Appeal</p>
<h1>Your appeal</h1>
<p class="lede">Case: <strong>${c.title}</strong></p>
${body}
<p class="small">${deletionNote(c)} The appeal is deleted with it.</p>`,
  });
}

/** The repo's issues, the public contact, as a link. */
const issuesLink = html`<a href="${ISSUES_URL}">${ISSUES_URL.replace('https://', '')}</a>`;

/**
 * @param {{ contactEmail: string | null, checkout: 'stripe' | 'link' | null,
 *   meta?: ReturnType<typeof import('./seo.js').pageMeta> | null }} site
 *   checkout: how the $3 appeal is sold right now (null: it isn't, the fake door is up).
 */
export function termsPage({ contactEmail, checkout, meta = null }) {
  const sale = checkout
    ? null
    : html`<p><strong>Payments are switched off for now, so the full trial can't be bought yet.</strong></p>`;
  return layout({
    title: 'Terms',
    meta,
    body: html`<p class="kicker">Group Chat Court</p>
<h1>Terms</h1>
<section><h2>What this is</h2>
<p>Group Chat Court is a mock court for petty arguments between friends, couples and roommates. An AI model writes the rulings for fun. They are jokes, not legal advice, and they decide nothing.</p></section>
<section><h2>Who can use it, and for what</h2>
<p>You must be 18 or older. Petty disputes only: no abuse, health, money or minors. Don't name or describe anyone who isn't part of the argument, and don't use it to bully anyone.</p></section>
<section><h2>Cases</h2>
<p>A case is shared by its links and isn't listed anywhere. Either party can delete it at any time from their own link, and every case is deleted automatically 30 days after it was filed, with everything attached to it. Anyone with a link can report a case, which takes it down at once.</p></section>
<section><h2>The full trial: ${APPEAL_PRICE_LABEL} (USD), once</h2>
${sale}
<p>Filing a case, the jury and the ruling are free. The full trial is one appeal for one case, paid once (${APPEAL_PRICE_LABEL}, no subscription) through Stripe after the ruling. The person who pays adds new evidence (text, up to ${EVIDENCE_MAX} characters), and the AI judge hears the case again and upholds or overturns the verdict. Each case can be appealed once, by whoever files first. The appeal ruling appears on the case page and the verdict card, and is deleted with the case.</p>
${
  checkout === 'link' &&
  html`<p>We confirm payments by hand: within ${MANUAL_CONFIRM_DAYS} days of paying, we email the link to file your appeal to the address you gave Stripe.</p>`
}
<p>Stripe processes the payment and emails your receipt. We never see your card details.</p>
<p><strong>Refunds:</strong> on request within ${REFUND_DAYS} days of paying, for any reason, including when the court declines to hear your appeal, the case is deleted or taken down before it's heard, or someone else filed the case's appeal first. ${
      contactEmail
        ? html`Email <a href="mailto:${contactEmail}">${contactEmail}</a> with your appeal link.`
        : html`Open an issue at ${issuesLink} with the receipt number from Stripe's email. Issues are public, so don't post your appeal link there.`
    }</p></section>
<section><h2>No warranty</h2>
<p>Group Chat Court is provided as is, without warranty of any kind. It can be down, lose a case or get one wrong, and its judge is an AI model that can rule badly. As far as the law allows, we aren't liable for anything that comes of using it, and if you paid for an appeal, the most we owe you is your ${APPEAL_PRICE_LABEL} back.</p></section>
<section><h2>Contact</h2>
<p>Questions, bugs or a takedown that went wrong: open an issue at ${issuesLink}. Issues are public, so don't post case links or personal details there.${
      contactEmail ? html` For refunds or anything private, email <a href="mailto:${contactEmail}">${contactEmail}</a>.` : ''
    }</p></section>
<p class="small">These terms can change; the version on this page is the one that applies. See also the <a href="/privacy">privacy page</a>.</p>`,
  });
}

/**
 * @param {{ contactEmail: string | null, checkout?: 'stripe' | 'link' | null,
 *   meta?: ReturnType<typeof import('./seo.js').pageMeta> | null }} site
 */
export function privacyPage({ contactEmail, checkout = null, meta = null }) {
  return layout({
    title: 'Privacy',
    meta,
    body: html`<p class="kicker">Group Chat Court</p>
<h1>Privacy</h1>
<section><h2>What is stored</h2>
<ul>
<li>What you write in a case: the title, the charge, both testimonies and any appeal evidence, plus the AI judge's rulings.</li>
<li>Jury votes and their optional one-line comments. A random device id in a cookie named <code>pc_device</code> (sent only to jury links) stops double votes; the database keeps a hash of it per case, never the id itself.</li>
<li>Reports, with their reason and optional note.</li>
<li>Clicks on "Full trial · $3", and an email address only if you leave one there.</li>
<li>For a paid appeal: the Stripe Checkout session id and when it was paid. We never see or store your card details.</li>
<li>How many different browsers opened a case's links. Your browser keeps a list of the cases it has opened (in its own storage, under <code>pc_seen</code>), so each browser is counted once per case and the browser that filed the case isn't counted at all. The server keeps only the number.</li>
</ul>
<p>There are no accounts and no ads. Apart from the three launch counts below, nothing is sent to an analytics or advertising service.</p></section>
<section><h2>Cookies</h2>
<p>Only one, and only for jury duty: <code>pc_device</code>, described above, is sent only to jury links so that each device votes once. There are no other cookies, and none from anyone else.</p></section>
<section><h2>Launch counts</h2>
<p>To see whether anyone uses Group Chat Court, the live site sends three kinds of anonymous count to RepoHQ, the dashboard where its maker tracks which projects get used (<code>idea-factory.1426davejobs.workers.dev</code>, on Cloudflare Workers):</p>
<ul>
<li><strong>visit</strong>: once per browser session, from the first page you open;</li>
<li><strong>activate</strong>: the first time your browser files a case;</li>
<li><strong>checkout</strong>: each time someone presses the button to buy the $3 appeal.</li>
</ul>
<p>Each count holds only the product's name (pettycourt), which of the three it is, and the address of the website that sent you here when it's another site. It never holds a link to a case, anything you wrote, a cookie or an id. Your browser remembers what it already sent, in its own storage (<code>repohq:visit</code> for the session, <code>repohq:activated</code> for good). Nothing is sent from automated browsers or from test deployments. To opt out, set <code>repohq:notrack</code> in this site's local storage, for example by running <code>localStorage.setItem("repohq:notrack", "1")</code> in your browser's console.</p></section>
<section><h2>Who else handles it</h2>
<ul>
<li><strong>Google</strong> (the Gemini API's free tier) receives the case file to write each ruling, and may use it to improve its products.</li>
<li><strong>Stripe</strong> processes payments, emails receipts and keeps its own payment records under its own privacy policy.${
  checkout === 'link' &&
  html` Stripe shows us the email address you pay with, which we use only to send you the link to your appeal and to answer a refund request.`
}</li>
<li>The database runs on Neon, and the app on Cloudflare (Workers), which keeps short request logs that include the links opened.</li>
<li><strong>RepoHQ</strong> receives the launch counts above, and nothing else.</li>
</ul></section>
<section><h2>How long, and how to delete it</h2>
<p>Every case is deleted automatically 30 days after filing, with its votes, comments, reports, clicks, emails, appeal and payment record. Either party can delete it sooner from their own link. A report takes a case down at once. Copies outside the app, such as a downloaded card, a chat app's link preview or Stripe's payment records, are out of our reach.</p>
<p>When a case is deleted, an anonymous record of how it went is kept, to decide whether Group Chat Court works. It holds the day it was filed, whether the other side answered, whether it was ruled, reported, clicked or paid, how many votes and visitors it had, and our safety review's result. It holds no text, links or ids from the case, so nothing in it points back to the case or to you.</p></section>
<section><h2>Contact</h2>
<p>To ask about your data, ${contactLine(contactEmail)}.${
      contactEmail
        ? html` Questions and bugs can also go to ${issuesLink}.`
        : html` Issues are public, so don't post case links or personal details there.`
    }</p></section>`,
  });
}

export function notFoundPage() {
  return layout({
    title: 'Not found',
    body: html`<h1>No such case.</h1>
<p>This link doesn't match any case in Group Chat Court. Check that you copied the whole link.</p>
<p><a href="/">File a new case</a></p>`,
  });
}

// Progressive enhancement for every form with data-api (file, testify, call the judge, vote, report,
// unlock, delete, checkout, appeal). It sends the form as JSON (or a bodyless DELETE when
// data-method="DELETE"), with data-token as a bearer token and a confirm() first when data-confirm is
// set. Then it reveals a panel filled from the reply (data-then="reveal" data-reveal="<id>"), goes to
// /deleted, reloads, goes to the reply's url (data-then="redirect": the server only ever answers with a
// Stripe Checkout URL it has checked, or the operator's Payment Link), or goes to the case page. Text only
// ever goes in via textContent/value.
// M5: on a page whose <main> has data-visit, it also reports this browser's first visit to that case.
// Go-live: with `signal` (the production deployment, src/config.js) it sends RepoHQ's three launch counts.

/** RepoHQ's counter (go-live): the only other origin the pages talk to, and only from production. */
export const SIGNAL_URL = 'https://idea-factory.1426davejobs.workers.dev/api/ideas/signal';
export const SIGNAL_SLUG = 'pettycourt';

/**
 * The client script. `signal`: send RepoHQ's launch counts ("visit" once per browser session, "activate"
 * the first time this browser files a case, "checkout" on a Buy button). Even then nothing goes out from
 * an automated browser (navigator.webdriver) or one with localStorage "repohq:notrack" set. Each count
 * carries the slug, the kind and the referring site (only when it's another origin), and no cookie or
 * Referer, so a case link never leaves the page. It's a CORS-safelisted text/plain POST of JSON, so the
 * counter needs no preflight (which keepalive requests can't always make) and the page needs no answer.
 * @param {{ signal?: boolean }} [options]
 */
export function clientScript({ signal = false } = {}) {
  return `"use strict";
const SIGNAL_ON = ${signal ? 'true' : 'false'};

function sendSignal(kind) {
  let referrer = null;
  if (document.referrer && new URL(document.referrer).origin !== location.origin) referrer = document.referrer;
  fetch(${JSON.stringify(SIGNAL_URL)}, {
    method: "POST",
    mode: "no-cors",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    keepalive: true,
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ slug: ${JSON.stringify(SIGNAL_SLUG)}, kind, referrer }),
  }).catch(() => {});
}

// once: () => the Storage that remembers it was sent (sessionStorage, localStorage), and key its name.
function signal(kind, once, key) {
  if (!SIGNAL_ON) return;
  try {
    if (navigator.webdriver || localStorage.getItem("repohq:notrack") !== null) return;
    if (once) {
      const storage = once();
      if (storage.getItem(key) !== null) return;
      storage.setItem(key, "1");
    }
    sendSignal(kind);
  } catch {
    // No storage, or storage that refuses: there's no way to count once, so nothing is sent.
  }
}

signal("visit", () => sessionStorage, "repohq:visit");

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-api")) return;
  event.preventDefault();
  if (form.dataset.confirm && !confirm(form.dataset.confirm)) return;
  if (form.hasAttribute("data-buy")) signal("checkout");
  const status = form.querySelector("[data-status]");
  const button = form.querySelector("button:not([type=button])");
  const say = (text) => { if (status) status.textContent = text; };
  if (button) button.disabled = true;
  say(form.dataset.pending || "Sending…");
  try {
    const init = { method: form.dataset.method || "POST", headers: {} };
    if (form.dataset.token) init.headers.authorization = "Bearer " + form.dataset.token;
    if (init.method === "POST") {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(Object.fromEntries(new FormData(form)));
    }
    const res = await fetch(form.getAttribute("data-api"), init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    // Only filing a case answers with a plaintiff token: this browser is the plaintiff's, never a visitor.
    // Filing is also the core action RepoHQ counts as "activate", once per browser.
    if (data.plaintiffToken && data.caseId) {
      remember(data.caseId);
      signal("activate", () => localStorage, "repohq:activated");
    }
    const then = form.dataset.then;
    if (then === "reveal") return reveal(form, document.getElementById(form.dataset.reveal), data);
    if (then === "deleted") return location.replace("/deleted");
    if (then === "reload") return location.reload();
    if (then === "redirect") return location.assign(data.url);
    if (data.caseUrl) return location.assign(data.caseUrl);
    location.reload();
  } catch (error) {
    say(error.message || "Something went wrong. Please try again.");
    if (button) button.disabled = false;
  }
});

function reveal(form, panel, data) {
  for (const el of panel.querySelectorAll("[data-field]")) {
    const value = data[el.dataset.field];
    if (value === undefined) continue;
    if (el instanceof HTMLAnchorElement) el.href = value;
    else el.value = value;
  }
  form.hidden = true;
  panel.hidden = false;
}

document.addEventListener("click", async (event) => {
  const button = event.target instanceof Element && event.target.closest("[data-copy]");
  if (!button) return;
  const input = document.querySelector('[data-field="' + button.dataset.copy + '"]');
  try {
    await navigator.clipboard.writeText(input.value);
    button.textContent = "Copied";
  } catch {
    input.select();
  }
});

// M5: count this browser once for each case it opens (the PRD's "new visitors per case"). It keeps the
// cases it has seen in localStorage; the plaintiff's own browser is put on that list when it files (or
// opens the plaintiff link) and is never counted. Without storage there's no way to count once, so
// nothing is sent. A corrupted list starts over rather than silencing the browser for good.
function seenCases() {
  try {
    const seen = JSON.parse(localStorage.getItem("pc_seen"));
    return Array.isArray(seen) ? seen : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

function remember(caseId) {
  try {
    const seen = seenCases();
    if (seen.includes(caseId)) return false;
    seen.push(caseId);
    localStorage.setItem("pc_seen", JSON.stringify(seen.slice(-200)));
    return true;
  } catch {
    return false;
  }
}

const visited = document.querySelector("main[data-visit]");
if (visited && remember(visited.dataset.visit) && visited.dataset.visitor !== "plaintiff") {
  fetch("/visits", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caseId: visited.dataset.visit }),
    keepalive: true,
  }).catch(() => {});
}
`;
}

/** The client script as every non-production deployment serves it: no launch counts. */
export const CLIENT_JS = clientScript();

export const CLIENT_CSS = `:root { color-scheme: light; --ink: #1d1a16; --paper: #fbf7ef; --accent: #7a1f1f; --muted: #6b6359; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 17px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
h1, h2 { font-family: Georgia, "Times New Roman", serif; line-height: 1.2; }
h1 { font-size: 2.1rem; margin: 0.2rem 0 0.8rem; }
h2 { font-size: 1.25rem; margin: 1.6rem 0 0.4rem; }
.kicker { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.8rem; color: var(--accent); margin: 0; }
.lede { font-size: 1.1rem; }
.small, .optional, footer { color: var(--muted); font-size: 0.85rem; }
label { display: block; font-weight: 600; margin: 1rem 0; }
input, textarea { display: block; width: 100%; margin-top: 0.35rem; padding: 0.6rem; font: inherit; border: 1px solid #c9bfae; border-radius: 6px; background: #fff; }
button { font: inherit; font-weight: 600; padding: 0.65rem 1.2rem; border: 0; border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: progress; }
.copy { display: flex; gap: 0.5rem; }
.copy input { margin: 0; }
.charge { font-family: Georgia, serif; font-size: 1.15rem; }
.testimony, .ruling { white-space: pre-wrap; }
.absent { font-style: italic; color: var(--muted); }
.verdict { border-top: 3px double var(--ink); margin-top: 2rem; }
.status { min-height: 1.5em; }
fieldset { border: 1px solid #c9bfae; border-radius: 6px; margin: 1rem 0; padding: 0.5rem 1rem; }
legend { font-weight: 600; padding: 0 0.3rem; }
label.choice { display: inline-flex; align-items: center; gap: 0.4rem; margin: 0.5rem 1.5rem 0.5rem 0; }
label.choice input { display: inline; width: auto; margin: 0; }
.split { font-family: Georgia, serif; font-size: 1.3rem; font-weight: 600; }
.comments { padding-left: 1.2rem; }
.comment { margin: 0.3rem 0; overflow-wrap: anywhere; }
.card img { display: block; width: 100%; max-width: 27rem; height: auto; border: 1px solid #c9bfae; }
.unlock { border: 2px solid var(--accent); border-radius: 8px; padding: 0 1rem 1rem; margin-top: 2rem; }
.appeal { border-top: 3px double var(--accent); margin-top: 2rem; }
.paid { font-weight: 600; }
.danger { border-top: 1px solid #c9bfae; margin-top: 2.5rem; }
.danger button { background: #5a1414; }
details.report { margin-top: 2rem; }
details.report summary { cursor: pointer; color: var(--muted); font-size: 0.9rem; }
details.report label.choice { display: flex; margin: 0.4rem 0; font-weight: 400; }
footer { max-width: 40rem; margin: 0 auto; padding: 0 1.25rem 2rem; }
a { color: var(--accent); }
`;
