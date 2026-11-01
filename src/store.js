// Postgres persistence for cases. Works against any client with
// `query(sql, params) -> { rows }` and `exec(sql)`: `pg` in production, PGlite in tests and local dev.
// All writes that must happen once are a single conditional UPDATE … RETURNING, never read-then-write.
// Every table that holds case data references cases(id) ON DELETE CASCADE, so deleting the case row
// (by a party, or by the 30-day expiry) deletes everything about it. The one table without that link is
// case_outcomes (M5): the statement that deletes a case also keeps its anonymous outcome there (answered,
// votes, visitors, paid…, with no text, id, token or time finer than a day), so the M5 decision still
// counts cases that are gone.

// The advisory lock (an arbitrary app-wide constant) serialises schema creation, so two cold
// starts can't race CREATE TABLE IF NOT EXISTS into a duplicate pg_type error. The script runs on
// every cold start, so each statement is idempotent; the ALTERs upgrade an M2 database in place.
const SCHEMA = `
BEGIN;
SELECT pg_advisory_xact_lock(7310001);
CREATE TABLE IF NOT EXISTS cases (
  id                    text PRIMARY KEY,
  summons_token         text NOT NULL UNIQUE,
  jury_token            text NOT NULL UNIQUE,
  title                 text NOT NULL,
  charge                text NOT NULL,
  plaintiff_testimony   text NOT NULL,
  defendant_testimony   text,
  defendant_answered_at timestamptz,
  created_at            timestamptz NOT NULL,
  deadline_at           timestamptz NOT NULL,
  verdict               text CHECK (verdict IN ('guilty', 'not_guilty', 'split')),
  ruling                text,
  default_judgment      boolean,
  ruled_at              timestamptz,
  declined_at           timestamptz
);
CREATE TABLE IF NOT EXISTS votes (
  case_id    text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  voter      text NOT NULL,
  vote       text NOT NULL CHECK (vote IN ('guilty', 'not_guilty')),
  comment    text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (case_id, voter)
);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS plaintiff_token text UNIQUE;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS reported_at timestamptz;
CREATE INDEX IF NOT EXISTS cases_created_at_idx ON cases (created_at);
CREATE TABLE IF NOT EXISTS reports (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id    text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  reason     text NOT NULL CHECK (reason IN ('names_someone', 'serious', 'mean', 'other')),
  note       text,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_case_id_idx ON reports (case_id);
CREATE TABLE IF NOT EXISTS unlock_clicks (
  id         text PRIMARY KEY,
  case_id    text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  email      text,
  created_at timestamptz NOT NULL,
  email_at   timestamptz
);
CREATE INDEX IF NOT EXISTS unlock_clicks_case_id_idx ON unlock_clicks (case_id);
ALTER TABLE unlock_clicks ADD COLUMN IF NOT EXISTS checkout_session_id text UNIQUE;
ALTER TABLE unlock_clicks ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS appeal_click_id text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS appeal_side text CHECK (appeal_side IN ('plaintiff', 'defendant'));
ALTER TABLE cases ADD COLUMN IF NOT EXISTS appeal_evidence text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS appealed_at timestamptz;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS appeal_verdict text CHECK (appeal_verdict IN ('guilty', 'not_guilty', 'split'));
ALTER TABLE cases ADD COLUMN IF NOT EXISTS appeal_ruling text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS appeal_ruled_at timestamptz;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS appeal_declined_at timestamptz;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS visitors integer NOT NULL DEFAULT 0;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS review text CHECK (review IN ('ok', 'names_someone', 'serious'));
ALTER TABLE cases ADD COLUMN IF NOT EXISTS reviewed_rulings smallint;
CREATE TABLE IF NOT EXISTS case_outcomes (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  filed_on       date NOT NULL,
  gone_by        text NOT NULL CHECK (gone_by IN ('deleted', 'expired')),
  answered       boolean NOT NULL,
  ruled          boolean NOT NULL,
  taken_down     boolean NOT NULL,
  clicked        boolean NOT NULL,
  paid           boolean NOT NULL,
  votes          integer NOT NULL,
  visitors       integer NOT NULL,
  review         text CHECK (review IN ('ok', 'names_someone', 'serious')),
  review_pending boolean NOT NULL
);
COMMIT;
`;

/** What a juror can vote; matches the CHECK constraint on votes.vote. */
export const JURY_VOTES = ['guilty', 'not_guilty'];
/** Why a case was reported; matches the CHECK constraint on reports.reason. */
export const REPORT_REASONS = ['names_someone', 'serious', 'mean', 'other'];
/** Who can bring an appeal; matches the CHECK constraint on cases.appeal_side. */
export const APPEAL_SIDES = ['plaintiff', 'defendant'];
/** Cases (and everything attached to them) are kept this long after filing, then the expiry job deletes them. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const EXPIRY_BATCH = 500;
/** What the operator's safety review can say about a case's rulings; matches the CHECK on cases.review (M5). */
export const REVIEW_RESULTS = ['ok', 'names_someone', 'serious'];
/** A case's visitor count stops here: it bounds a script hammering the (unauthenticated) visit beacon. */
export const VISITORS_MAX = 100;

// How many rulings a case has: the ruling, plus the appeal ruling once there is one (one appeal per case).
const rulingCount = (c) => `((${c}.ruled_at IS NOT NULL)::int + (${c}.appeal_ruled_at IS NOT NULL)::int)`;
// A case needs the safety review while it has a ruling the review hasn't covered: never reviewed, or reviewed
// before its appeal ruling. reviewed_rulings counts what the review covered, so no clock is compared.
const reviewPending = (c) => `(${c}.ruled_at IS NOT NULL AND coalesce(${c}.reviewed_rulings, 0) < ${rulingCount(c)})`;

// One case's outcome as the M5 decision counts it: no text, id, token or time finer than a day. The same
// expressions describe live cases (the report) and gone ones (the row kept by the delete statements), so
// the two can't drift apart. Constant SQL only; `c` is a table alias.
const OUTCOME = [
  ['filed_on', (c) => `(${c}.created_at AT TIME ZONE 'UTC')::date`],
  ['answered', (c) => `${c}.defendant_testimony IS NOT NULL`],
  ['ruled', (c) => `${c}.ruled_at IS NOT NULL`],
  ['taken_down', (c) => `${c}.reported_at IS NOT NULL`],
  ['clicked', (c) => `EXISTS (SELECT 1 FROM unlock_clicks u WHERE u.case_id = ${c}.id)`],
  ['paid', (c) => `${c}.paid_at IS NOT NULL`],
  ['votes', (c) => `(SELECT count(*) FROM votes v WHERE v.case_id = ${c}.id)::int`],
  ['visitors', (c) => `${c}.visitors`],
  ['review', (c) => `${c}.review`],
  ['review_pending', reviewPending],
];
const OUTCOME_NAMES = OUTCOME.map(([name]) => name).join(', ');
const outcomeOf = (c) => OUTCOME.map(([name, expr]) => `${expr(c)} AS ${name}`).join(',\n  ');

/**
 * Deletes the cases `where` selects and, in the same statement, keeps each one's outcome. Postgres runs
 * every part of a WITH on one snapshot and cascades the child rows afterwards, so the outcome still sees
 * the votes and clicks that go with the case. Of two simultaneous deletes only one gets the row back, so a
 * case is kept once.
 */
const deleteKeepingOutcome = (where, goneBy) => `
  WITH gone AS (DELETE FROM cases WHERE ${where} RETURNING *),
  kept AS (
    INSERT INTO case_outcomes (${OUTCOME_NAMES}, gone_by)
    SELECT ${outcomeOf('gone')}, '${goneBy}' FROM gone
  )
  SELECT id FROM gone`;

const COLUMNS = `id, summons_token, jury_token, plaintiff_token, title, charge, plaintiff_testimony, defendant_testimony,
  defendant_answered_at, created_at, deadline_at, verdict, ruling, default_judgment, ruled_at, declined_at, reported_at,
  paid_at, appeal_click_id, appeal_side, appeal_evidence, appealed_at, appeal_verdict, appeal_ruling, appeal_ruled_at,
  appeal_declined_at`;
const CLICK_COLUMNS = 'id, case_id, checkout_session_id, paid_at';

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>, exec: (sql: string) => Promise<unknown> }} Db
 * @typedef {{
 *   id: string, summonsToken: string, juryToken: string, plaintiffToken: string | null, title: string, charge: string,
 *   plaintiffTestimony: string, defendantTestimony: string | null, defendantAnsweredAt: Date | null,
 *   createdAt: Date, deadlineAt: Date, verdict: 'guilty' | 'not_guilty' | 'split' | null,
 *   ruling: string | null, defaultJudgment: boolean | null, ruledAt: Date | null, declinedAt: Date | null,
 *   reportedAt: Date | null, paidAt: Date | null, appealClickId: string | null,
 *   appealSide: 'plaintiff' | 'defendant' | null, appealEvidence: string | null, appealedAt: Date | null,
 *   appealVerdict: 'guilty' | 'not_guilty' | 'split' | null, appealRuling: string | null,
 *   appealRuledAt: Date | null, appealDeclinedAt: Date | null,
 * }} Case  plaintiffToken is null only on cases filed before M3; reportedAt marks a takedown; paidAt is
 *   the first payment for the appeal, and the appeal* fields are the one appeal (M4).
 * @typedef {{ id: string, caseId: string, checkoutSessionId: string | null, paidAt: Date | null }} Click
 *   An unlock click; in M4 each checkout attempt is one, and it carries the payment.
 * @typedef {{ guilty: number, notGuilty: number, total: number }} JuryTally
 * @typedef {{ vote: 'guilty' | 'not_guilty', comment: string | null, createdAt: Date }} Vote
 */

/** @returns {Case | null} */
function toCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    summonsToken: row.summons_token,
    juryToken: row.jury_token,
    plaintiffToken: row.plaintiff_token,
    title: row.title,
    charge: row.charge,
    plaintiffTestimony: row.plaintiff_testimony,
    defendantTestimony: row.defendant_testimony,
    defendantAnsweredAt: row.defendant_answered_at,
    createdAt: row.created_at,
    deadlineAt: row.deadline_at,
    verdict: row.verdict,
    ruling: row.ruling,
    defaultJudgment: row.default_judgment,
    ruledAt: row.ruled_at,
    declinedAt: row.declined_at,
    reportedAt: row.reported_at,
    paidAt: row.paid_at,
    appealClickId: row.appeal_click_id,
    appealSide: row.appeal_side,
    appealEvidence: row.appeal_evidence,
    appealedAt: row.appealed_at,
    appealVerdict: row.appeal_verdict,
    appealRuling: row.appeal_ruling,
    appealRuledAt: row.appeal_ruled_at,
    appealDeclinedAt: row.appeal_declined_at,
  };
}

/** @returns {Click | null} */
function toClick(row) {
  if (!row) return null;
  return { id: row.id, caseId: row.case_id, checkoutSessionId: row.checkout_session_id, paidAt: row.paid_at };
}

/** @param {() => Promise<Db>} connect */
export function createStore(connect) {
  let readyPromise;

  /** Connect and create the schema once per process; a failure is retried on the next call. */
  function ready() {
    readyPromise ??= (async () => {
      const db = await connect();
      await db.exec(SCHEMA);
      return db;
    })().catch((error) => {
      readyPromise = undefined;
      throw error;
    });
    return readyPromise;
  }

  async function rows(sql, params) {
    const db = await ready();
    return (await db.query(sql, params)).rows;
  }

  async function one(sql, params) {
    return toCase((await rows(sql, params))[0]);
  }

  const toVote = (row) => (row ? { vote: row.vote, comment: row.comment, createdAt: row.created_at } : null);

  return {
    ready,

    /** @param {Pick<Case, 'id' | 'summonsToken' | 'juryToken' | 'plaintiffToken' | 'title' | 'charge' | 'plaintiffTestimony' | 'createdAt' | 'deadlineAt'>} c */
    createCase(c) {
      return one(
        `INSERT INTO cases (id, summons_token, jury_token, plaintiff_token, title, charge, plaintiff_testimony,
                            created_at, deadline_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${COLUMNS}`,
        [
          c.id,
          c.summonsToken,
          c.juryToken,
          c.plaintiffToken,
          c.title,
          c.charge,
          c.plaintiffTestimony,
          c.createdAt,
          c.deadlineAt,
        ],
      );
    },

    getCase(id) {
      return one(`SELECT ${COLUMNS} FROM cases WHERE id = $1`, [id]);
    },

    getCaseBySummons(token) {
      return one(`SELECT ${COLUMNS} FROM cases WHERE summons_token = $1`, [token]);
    },

    getCaseByJury(token) {
      return one(`SELECT ${COLUMNS} FROM cases WHERE jury_token = $1`, [token]);
    },

    getCaseByPlaintiff(token) {
      return one(`SELECT ${COLUMNS} FROM cases WHERE plaintiff_token = $1`, [token]);
    },

    /**
     * Deletes the case if `token` is its plaintiff or summons token; votes, reports and unlock clicks
     * go with it (ON DELETE CASCADE), and its anonymous outcome is kept (M5). Of two simultaneous deletes
     * exactly one gets the id back.
     * @returns {Promise<string | null>} the deleted case id, or null if nothing matched
     */
    async deleteCase(id, token) {
      const [row] = await rows(
        deleteKeepingOutcome('id = $1 AND (plaintiff_token = $2 OR summons_token = $2)', 'deleted'),
        [id, token],
      );
      return row?.id ?? null;
    },

    /**
     * The expiry job: deletes every case filed before `cutoff` (keeping each one's outcome), `batchSize`
     * cases per statement so a backlog never becomes one long transaction.
     * @returns {Promise<string[]>} the deleted case ids
     */
    async deleteFiledBefore(cutoff, { batchSize = EXPIRY_BATCH } = {}) {
      const deleted = [];
      for (;;) {
        const batch = await rows(
          deleteKeepingOutcome('id IN (SELECT id FROM cases WHERE created_at < $1 ORDER BY created_at LIMIT $2)', 'expired'),
          [cutoff, batchSize],
        );
        deleted.push(...batch.map((r) => r.id));
        if (batch.length < batchSize) return deleted;
      }
    },

    /**
     * Takes the case down and stores the report, in one statement: of two simultaneous reports exactly
     * one is stored, and a case is never down without its report.
     * @returns {Promise<boolean>} true if this report took the case down; false if it was already
     *   down or doesn't exist
     */
    async reportCase(id, { reason, note, at }) {
      const stored = await rows(
        `WITH hidden AS (
           UPDATE cases SET reported_at = $4 WHERE id = $1 AND reported_at IS NULL RETURNING id
         )
         INSERT INTO reports (case_id, reason, note, created_at)
         SELECT id, $2::text, $3::text, $4::timestamptz FROM hidden
         RETURNING case_id`,
        [id, reason, note, at],
      );
      return stored.length > 0;
    },

    /**
     * Records one click on the fake-door unlock button, if the case is open to it.
     * @returns {Promise<boolean>} false if the case is missing, declined or taken down
     */
    async recordUnlockClick({ id, caseId, at }) {
      const stored = await rows(
        `INSERT INTO unlock_clicks (id, case_id, created_at)
         SELECT $1::text, id, $3::timestamptz FROM cases
         WHERE id = $2 AND declined_at IS NULL AND reported_at IS NULL
         RETURNING id`,
        [id, caseId, at],
      );
      return stored.length > 0;
    },

    /**
     * Records a checkout attempt (M4) as an unlock click, if the case can take the appeal's payment:
     * ruled, not declined or taken down, and neither paid nor appealed yet.
     * @returns {Promise<boolean>}
     */
    async recordCheckoutClick({ id, caseId, at }) {
      const stored = await rows(
        `INSERT INTO unlock_clicks (id, case_id, created_at)
         SELECT $1::text, id, $3::timestamptz FROM cases
         WHERE id = $2 AND ruled_at IS NOT NULL AND declined_at IS NULL AND reported_at IS NULL
           AND paid_at IS NULL AND appealed_at IS NULL
         RETURNING id`,
        [id, caseId, at],
      );
      return stored.length > 0;
    },

    /** Stores the Stripe Checkout Session id on the click that started it. */
    async attachCheckoutSession(clickId, sessionId) {
      await rows('UPDATE unlock_clicks SET checkout_session_id = $2 WHERE id = $1 AND checkout_session_id IS NULL', [
        clickId,
        sessionId,
      ]);
    },

    /** @returns {Promise<Click | null>} */
    async getClick(id) {
      return toClick((await rows(`SELECT ${CLICK_COLUMNS} FROM unlock_clicks WHERE id = $1`, [id]))[0]);
    },

    /**
     * Marks a click paid, and its case too if the case has no payment yet, in one statement: of two
     * simultaneous fulfilments of the same session exactly one records it. The session id must be the
     * click's own (or fill the gap if storing it had failed).
     * @returns {Promise<(Click & { firstPayment: boolean }) | null>} the click if this call recorded the
     *   payment (firstPayment: it also marked the case paid, rather than being a second payer); null if it
     *   was already recorded or the click is gone (its case was deleted)
     */
    async markClickPaid({ clickId, sessionId, at }) {
      const [row] = await rows(
        `WITH paid AS (
           UPDATE unlock_clicks SET paid_at = $3, checkout_session_id = $2
           WHERE id = $1 AND paid_at IS NULL AND (checkout_session_id IS NULL OR checkout_session_id = $2)
           RETURNING ${CLICK_COLUMNS}
         ), marked AS (
           UPDATE cases SET paid_at = $3 FROM paid WHERE cases.id = paid.case_id AND cases.paid_at IS NULL
           RETURNING cases.id
         )
         SELECT ${CLICK_COLUMNS}, EXISTS (SELECT 1 FROM marked) AS first_payment FROM paid`,
        [clickId, sessionId, at],
      );
      return row ? { ...toClick(row), firstPayment: row.first_payment } : null;
    },

    /**
     * Files the case's one appeal, if it is ruled, still up, and `clickId` is a paid click of this case.
     * Of two simultaneous appeals exactly one lands; otherwise null.
     */
    fileAppeal(id, { clickId, side, evidence, at }) {
      return one(
        `UPDATE cases SET appeal_click_id = $2, appeal_side = $3, appeal_evidence = $4, appealed_at = $5
         WHERE id = $1 AND appealed_at IS NULL AND ruled_at IS NOT NULL AND declined_at IS NULL AND reported_at IS NULL
           AND EXISTS (SELECT 1 FROM unlock_clicks u WHERE u.id = $2 AND u.case_id = $1 AND u.paid_at IS NOT NULL)
         RETURNING ${COLUMNS}`,
        [id, clickId, side, evidence, at],
      );
    },

    /** Stores the appeal ruling once, if the appeal is filed, not yet heard or declined, and the case is up. */
    saveAppealRuling(id, { verdict, ruling, at }) {
      return one(
        `UPDATE cases SET appeal_verdict = $2, appeal_ruling = $3, appeal_ruled_at = $4
         WHERE id = $1 AND appealed_at IS NOT NULL AND appeal_ruled_at IS NULL AND appeal_declined_at IS NULL
           AND reported_at IS NULL
         RETURNING ${COLUMNS}`,
        [id, verdict, ruling, at],
      );
    },

    /** The court declines to hear the appeal; the original ruling stands. Never stores an appeal ruling. */
    markAppealDeclined(id, at) {
      return one(
        `UPDATE cases SET appeal_declined_at = $2
         WHERE id = $1 AND appealed_at IS NOT NULL AND appeal_ruled_at IS NULL AND appeal_declined_at IS NULL
         RETURNING ${COLUMNS}`,
        [id, at],
      );
    },

    /** Puts an email on an existing click of this case (replacing a previous one). False if no such click. */
    async saveUnlockEmail({ clickId, caseId, email, at }) {
      const stored = await rows(
        'UPDATE unlock_clicks SET email = $3, email_at = $4 WHERE id = $1 AND case_id = $2 RETURNING id',
        [clickId, caseId, email, at],
      );
      return stored.length > 0;
    },

    /**
     * Records one vote per (case, voter): of two simultaneous votes from the same voter exactly one
     * lands. Returns the stored vote, or null if this voter already voted or the case was declined or
     * taken down.
     * @returns {Promise<Vote | null>}
     */
    async castVote({ caseId, voter, vote, comment, at }) {
      const [row] = await rows(
        `INSERT INTO votes (case_id, voter, vote, comment, created_at)
         SELECT id, $2::text, $3::text, $4::text, $5::timestamptz FROM cases
         WHERE id = $1 AND declined_at IS NULL AND reported_at IS NULL
         ON CONFLICT (case_id, voter) DO NOTHING
         RETURNING vote, comment, created_at`,
        [caseId, voter, vote, comment, at],
      );
      return toVote(row);
    },

    /** @returns {Promise<Vote | null>} this voter's vote on the case, if any */
    async getVote(caseId, voter) {
      const [row] = await rows('SELECT vote, comment, created_at FROM votes WHERE case_id = $1 AND voter = $2', [
        caseId,
        voter,
      ]);
      return toVote(row);
    },

    /** @returns {Promise<JuryTally>} */
    async getJury(caseId) {
      const [row] = await rows(
        `SELECT count(*) FILTER (WHERE vote = 'guilty')::int AS guilty,
                count(*) FILTER (WHERE vote = 'not_guilty')::int AS not_guilty
         FROM votes WHERE case_id = $1`,
        [caseId],
      );
      return { guilty: row.guilty, notGuilty: row.not_guilty, total: row.guilty + row.not_guilty };
    },

    /** @returns {Promise<Vote[]>} the newest jury comments first, at most `limit` */
    async listComments(caseId, limit) {
      const found = await rows(
        `SELECT vote, comment, created_at FROM votes
         WHERE case_id = $1 AND comment IS NOT NULL
         ORDER BY created_at DESC, voter LIMIT $2`,
        [caseId, limit],
      );
      return found.map(toVote);
    },

    /** Stores the defendant's answer only if none exists and the case is still open; otherwise null. */
    submitDefendantTestimony(token, testimony, at) {
      return one(
        `UPDATE cases SET defendant_testimony = $2, defendant_answered_at = $3
         WHERE summons_token = $1 AND defendant_testimony IS NULL AND ruled_at IS NULL AND declined_at IS NULL
           AND reported_at IS NULL
         RETURNING ${COLUMNS}`,
        [token, testimony, at],
      );
    },

    /**
     * Stores the ruling only if the case has none yet, is still up, and the defendant's appearance is
     * what the judge saw (a late answer during deliberation voids a no-show ruling). Otherwise null.
     */
    saveRuling(id, { verdict, ruling, defaultJudgment, defendantAppeared, at }) {
      return one(
        `UPDATE cases SET verdict = $2, ruling = $3, default_judgment = $4, ruled_at = $5
         WHERE id = $1 AND ruled_at IS NULL AND declined_at IS NULL AND reported_at IS NULL
           AND (defendant_testimony IS NOT NULL) = $6
         RETURNING ${COLUMNS}`,
        [id, verdict, ruling, defaultJudgment, at, defendantAppeared],
      );
    },

    /** Marks the case as out of scope so it can't be re-rolled. Never stores a ruling. */
    markDeclined(id, at) {
      return one(
        `UPDATE cases SET declined_at = $2
         WHERE id = $1 AND ruled_at IS NULL AND declined_at IS NULL
         RETURNING ${COLUMNS}`,
        [id, at],
      );
    },

    // ── M5: the decision's numbers ─────────────────────────────────────────────────────────────────

    /**
     * One more visitor for the case (the client script sends this once per browser), up to VISITORS_MAX.
     * @returns {Promise<boolean>} false if there is no such case
     */
    async recordVisit(caseId) {
      const found = await rows('UPDATE cases SET visitors = LEAST(visitors + 1, $2) WHERE id = $1 RETURNING id', [
        caseId,
        VISITORS_MAX,
      ]);
      return found.length > 0;
    },

    /**
     * The M5 totals over every case filed on or after `since` (a 'YYYY-MM-DD' UTC day; all cases if
     * omitted), live or gone: how many reached each outcome, and where the safety review stands.
     * pending: live rulings waiting for review; missed: rulings that were deleted before anyone reviewed them.
     */
    async outcomeTotals({ since = null } = {}) {
      const [row] = await rows(
        `WITH everything AS (
           SELECT ${outcomeOf('c')}, false AS gone FROM cases c
           UNION ALL
           SELECT ${OUTCOME_NAMES}, true FROM case_outcomes
         )
         SELECT count(*)::int AS cases,
                count(*) FILTER (WHERE gone)::int AS gone,
                count(*) FILTER (WHERE answered)::int AS answered,
                count(*) FILTER (WHERE votes >= 2)::int AS jury2,
                coalesce(sum(visitors), 0)::int AS visitors,
                count(*) FILTER (WHERE clicked)::int AS clicked,
                count(*) FILTER (WHERE paid)::int AS paid,
                count(*) FILTER (WHERE ruled)::int AS rulings,
                count(*) FILTER (WHERE ruled AND NOT review_pending)::int AS reviewed,
                count(*) FILTER (WHERE review <> 'ok')::int AS violations,
                count(*) FILTER (WHERE review_pending AND NOT gone)::int AS pending,
                count(*) FILTER (WHERE review_pending AND gone)::int AS missed
         FROM everything
         WHERE $1::date IS NULL OR filed_on >= $1::date`,
        [since],
      );
      return row;
    },

    /**
     * Rulings waiting for the safety review, oldest case first: everything the reviewer has to read.
     * @returns {Promise<Array<{ id: string, title: string, charge: string, verdict: string, ruling: string,
     *   appealVerdict: string | null, appealRuling: string | null, createdAt: Date, takenDown: boolean }>>}
     */
    async reviewQueue({ since = null, limit = 50 } = {}) {
      const found = await rows(
        `SELECT id, title, charge, verdict, ruling, appeal_verdict, appeal_ruling, created_at, reported_at IS NOT NULL AS taken_down
         FROM cases c
         WHERE ${reviewPending('c')} AND ($1::date IS NULL OR (c.created_at AT TIME ZONE 'UTC')::date >= $1::date)
         ORDER BY created_at, id
         LIMIT $2`,
        [since, limit],
      );
      return found.map((r) => ({
        id: r.id,
        title: r.title,
        charge: r.charge,
        verdict: r.verdict,
        ruling: r.ruling,
        appealVerdict: r.appeal_verdict,
        appealRuling: r.appeal_ruling,
        createdAt: r.created_at,
        takenDown: r.taken_down,
      }));
    },

    /**
     * Records the operator's safety review of a case's rulings. 'ok' must say whether it covers an appeal
     * ruling (`withAppeal`), so an appeal ruled after the reviewer read the case is never approved unread.
     * A violation takes the case down first, like a report, with a reports row that says why, and needs no
     * such flag: whatever the reviewer read is enough to unpublish it.
     * @param {string} id
     * @param {{ result: 'ok' | 'names_someone' | 'serious', withAppeal?: boolean, at?: Date }} review
     * @returns {Promise<{ ok: true } | { ok: false, why: 'missing' | 'not_ruled' | 'has_appeal' | 'no_appeal' }>}
     */
    async reviewRuling(id, { result, withAppeal, at = new Date() }) {
      const violation = result !== 'ok';
      if (violation) {
        await rows(
          `WITH hidden AS (
             UPDATE cases SET reported_at = $3 WHERE id = $1 AND ruled_at IS NOT NULL AND reported_at IS NULL RETURNING id
           )
           INSERT INTO reports (case_id, reason, note, created_at)
           SELECT id, $2::text, 'Taken down by the operator''s safety review of the ruling.', $3::timestamptz FROM hidden`,
          [id, result, at],
        );
      }
      const reviewed = await rows(
        `UPDATE cases SET review = $2, reviewed_rulings = ${rulingCount('cases')}
         WHERE id = $1 AND ruled_at IS NOT NULL AND ($3::boolean IS NULL OR (appeal_ruled_at IS NOT NULL) = $3::boolean)
         RETURNING id`,
        [id, result, violation ? null : Boolean(withAppeal)],
      );
      if (reviewed.length) return { ok: true };
      const [current] = await rows('SELECT ruled_at, appeal_ruled_at FROM cases WHERE id = $1', [id]);
      if (!current) return { ok: false, why: 'missing' };
      if (!current.ruled_at) return { ok: false, why: 'not_ruled' };
      return { ok: false, why: current.appeal_ruled_at ? 'has_appeal' : 'no_appeal' };
    },
  };
}
