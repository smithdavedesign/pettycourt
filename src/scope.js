// Pre-ruling scope screen. Group Chat Court only hears petty disputes; the PRD excludes
// abuse, health, money and minors. This is a cheap first line (the judge model is the second):
// it catches people who honestly describe a serious situation, not someone trying to evade it.
// Patterns favour precision on everyday petty phrasing ("childish", "beat me at chess",
// "owes me an apology") so the fun cases still get through.

export const DECLINE_MESSAGE =
  'Group Chat Court only hears petty disputes, and this one sounds serious (abuse, health, money or minors), ' +
  'so the court declines to rule. If anyone is in danger, contact local emergency services or a support line you trust.';

const AGE_UNDER_18 = '(?:1[0-7]|[1-9])';
const RELATIVES = '(?:son|daughter|kids?|child|children|stepson|stepdaughter|toddler)';

const PATTERNS = {
  abuse: [
    /\b(?:hits?|hitting|punch(?:es|ed|ing)?|slap(?:s|ped|ping)?|chok(?:e|es|ed|ing)|strangl(?:e|es|ed|ing))\s+(?:me|her|him|them|us)\b/,
    /\babus(?:e|es|ed|ing|ive|er)\b/,
    /\bdomestic violence\b/,
    /\bthreat(?:en|ens|ened|ening)?\s+to\s+(?:kill|hurt|harm|beat)\b/,
    /\brap(?:e|ed|es|ing|ist)\b/,
    /\bsexual(?:ly)?\b/,
    /\bsex\b/,
    /\bnudes?\b/,
    /\bassault(?:s|ed|ing)?\b/,
    /\bstalk(?:s|ed|ing|er)?\s+(?:me|her|him|them|us)\b/,
  ],
  health: [
    /\bkill(?:ing)?\s+(?:myself|himself|herself|themselves|themself)\b/,
    /\bsuicid/,
    /\bself[- ]?harm/,
    /\bcut(?:s|ting)?\s+(?:myself|himself|herself|themselves|themself)\b/,
    /\bcancer\b/,
    /\bpregnan/,
    /\boverdos/,
    /\beating disorder\b/,
    /\banorexi/,
    /\bbulimi/,
    /\bmedication\b/,
    /\bdepression\b/,
    /\bstds?\b/,
    /\bstis?\b/,
  ],
  money: [
    /\bowes?\s+(?:me|us|him|her|them)\s+(?:money|cash|[$£€]|\d)/,
    /[$£€]\s?\d{3,}/,
    /\b\d{3,}\s*(?:dollars|bucks|pounds|euros|quid)\b/,
    /\bloans?\b/,
    /\brent\b/,
    /\bmortgage\b/,
    /\bcredit card\b/,
    /\bdebts?\b/,
    /\bgambl/,
    /\b(?:to|gonna|will|i'll|i will)\s+sue\b/,
    /\bsuing\b/,
    /\blawsuit\b/,
    /\bchild support\b/,
    /\balimony\b/,
  ],
  minors: [
    new RegExp(`\\b${AGE_UNDER_18}[- ]?(?:years?|yrs?)[- ]old\\b`),
    // "he is only 16." — a person's bare age ending the clause, so "she is only 5 minutes late"
    // and "the score was 3" pass.
    new RegExp(
      `\\b(?:he|she|they|i)(?:'s|'m|'re| is| am| was| are)\\s+(?:only |just )?${AGE_UNDER_18}(?:\\s*(?:years?|yrs?)(?: old)?)?\\s*(?:[.!?,;]|$)`,
    ),
    new RegExp(`\\b(?:my|our|his|her|their)\\s+${RELATIVES}\\b`),
    /\ba minor\s*(?:[.!?,;]|$)/,
    /\bminors\b/,
    /\bunder\s?age\b/,
    /\bcustody\b/,
  ],
};

function normalise(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
}

/**
 * Screen any number of user texts. Non-strings (null, undefined) are skipped.
 * @param {...unknown} texts
 * @returns {{ outOfScope: false } | { outOfScope: true, category: string }}
 */
export function screen(...texts) {
  // Each text is screened on its own so end-of-clause patterns see the end of that text.
  const normalised = texts.filter((t) => typeof t === 'string').map(normalise);
  for (const [category, patterns] of Object.entries(PATTERNS)) {
    if (normalised.some((text) => patterns.some((pattern) => pattern.test(text)))) {
      return { outOfScope: true, category };
    }
  }
  return { outOfScope: false };
}
