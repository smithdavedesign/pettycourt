import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDeps, pgliteDb, requestScopedPostgres } from '../src/config.js';
import { createStore } from '../src/store.js';
import { newDevice } from './helpers.js';

// Fake values assembled at runtime; nothing here is a real credential.
const FAKE_KEY = ['test', 'key', 'Zx9'.repeat(8)].join('-');
const FAKE_DB_URL = ['postgres:', '', 'localhost:5432', 'pettycourt'].join('/');
const FAKE_CRON_SECRET = ['cron', 'Kp4'.repeat(11)].join('-');

// The schema exactly as M2 shipped it, to check that M3's script upgrades a live database in place.
const M2_SCHEMA = `
CREATE TABLE cases (
  id text PRIMARY KEY, summons_token text NOT NULL UNIQUE, jury_token text NOT NULL UNIQUE,
  title text NOT NULL, charge text NOT NULL, plaintiff_testimony text NOT NULL, defendant_testimony text,
  defendant_answered_at timestamptz, created_at timestamptz NOT NULL, deadline_at timestamptz NOT NULL,
  verdict text CHECK (verdict IN ('guilty', 'not_guilty', 'split')), ruling text, default_judgment boolean,
  ruled_at timestamptz, declined_at timestamptz
);
CREATE TABLE votes (
  case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE, voter text NOT NULL,
  vote text NOT NULL CHECK (vote IN ('guilty', 'not_guilty')), comment text, created_at timestamptz NOT NULL,
  PRIMARY KEY (case_id, voter)
);`;

describe('createDeps', () => {
  it('production with DATABASE_URL and GOOGLE_API_KEY uses Postgres and the LLM judge', () => {
    const deps = createDeps({ DATABASE_URL: FAKE_DB_URL, GOOGLE_API_KEY: FAKE_KEY });
    expect(deps.dbKind).toBe('postgres');
    expect(deps.judgeKind).toBe('llm');
  });

  it('LLM_API_KEY wins over GOOGLE_API_KEY', () => {
    const deps = createDeps({ DATABASE_URL: FAKE_DB_URL, LLM_API_KEY: FAKE_KEY });
    expect(deps.judgeKind).toBe('llm');
  });

  it('production without DATABASE_URL fails loudly instead of using a throwaway database', async () => {
    const deps = createDeps({ GOOGLE_API_KEY: FAKE_KEY });
    expect(deps.dbKind).toBe('missing');
    await expect(deps.store.ready()).rejects.toThrow(/DATABASE_URL is not set/);
  });

  it('production without an LLM key has an unconfigured judge (503), never the stub', async () => {
    const deps = createDeps({ DATABASE_URL: FAKE_DB_URL });
    expect(deps.judgeKind).toBe('unconfigured');
    const error = await deps.judge({}).catch((e) => e);
    expect(error.code).toBe('JUDGE_NOT_CONFIGURED');
  });

  it('local mode falls back to PGlite and the stub judge', async () => {
    const deps = createDeps({}, { local: true, pgliteDir: 'memory://' });
    expect(deps.dbKind).toBe('pglite');
    expect(deps.judgeKind).toBe('stub');
    await deps.store.ready();
    expect(await deps.store.getCase('nothing-here')).toBeNull();
    await deps.close();
  });

  it('local mode still prefers real services when they are configured', () => {
    const deps = createDeps({ DATABASE_URL: FAKE_DB_URL, GOOGLE_API_KEY: FAKE_KEY }, { local: true });
    expect(deps.dbKind).toBe('postgres');
    expect(deps.judgeKind).toBe('llm');
  });

  it('passes CRON_SECRET through for the expiry job, and leaves it unset when it is missing or empty', () => {
    expect(createDeps({ DATABASE_URL: FAKE_DB_URL, CRON_SECRET: FAKE_CRON_SECRET }).cronSecret).toBe(FAKE_CRON_SECRET);
    expect(createDeps({ DATABASE_URL: FAKE_DB_URL }).cronSecret).toBeNull();
    expect(createDeps({ DATABASE_URL: FAKE_DB_URL, CRON_SECRET: '' }).cronSecret).toBeNull();
  });
});

describe('schema upgrade from M2', () => {
  it('adds the M3 columns, indexes and tables to an M2 database, keeps its rows, and can run again', async () => {
    const pg = new PGlite();
    await pg.waitReady;
    try {
      await pg.exec(M2_SCHEMA);
      const created = new Date('2026-10-30T12:00:00Z');
      const summons = newDevice();
      await pg.query(
        `INSERT INTO cases (id, summons_token, jury_token, title, charge, plaintiff_testimony, created_at, deadline_at)
         VALUES ('m2caseAAAAAAAAAA', $1, $2, 'An M2 case', 'Stole the duvet', 'Every night.', $3, $3)`,
        [summons, newDevice(), created],
      );
      await pg.query(`INSERT INTO votes VALUES ('m2caseAAAAAAAAAA', 'voter', 'guilty', NULL, $1)`, [created]);

      // Two cold starts, one after the other: the script must be safe to run on every boot.
      await createStore(async () => pgliteDb(pg)).ready();
      const store = createStore(async () => pgliteDb(pg));
      await store.ready();

      const columns = (
        await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'cases'`)
      ).rows.map((r) => r.column_name);
      expect(columns).toEqual(expect.arrayContaining(['plaintiff_token', 'reported_at']));
      const tables = (
        await pg.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)
      ).rows.map((r) => r.table_name);
      // M5 added case_outcomes (the anonymous outcome of each deleted case); the list is still exact.
      expect(tables).toEqual(['case_outcomes', 'cases', 'reports', 'unlock_clicks', 'votes']);
      const plaintiffIndexes = (
        await pg.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'cases' AND indexdef LIKE '%(plaintiff_token)%'`)
      ).rows;
      expect(plaintiffIndexes).toHaveLength(1);
      expect(
        (await pg.query(`SELECT 1 FROM pg_indexes WHERE tablename = 'cases' AND indexdef LIKE '%(created_at)%'`)).rows,
      ).toHaveLength(1);

      const old = await store.getCase('m2caseAAAAAAAAAA');
      expect(old).toMatchObject({ title: 'An M2 case', plaintiffToken: null, reportedAt: null });
      expect(await store.getJury('m2caseAAAAAAAAAA')).toEqual({ guilty: 1, notGuilty: 0, total: 1 });

      // An M2 case has no plaintiff token, so no bearer token can stand in for it; the defendant's still works.
      const app = createApp({ store, judge: async () => '' });
      const del = (token) =>
        app.request('/cases/m2caseAAAAAAAAAA', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
      expect((await del(newDevice())).status).toBe(404);
      expect((await del(summons)).status).toBe(200);
      expect((await pg.query(`SELECT count(*)::int AS n FROM votes`)).rows[0].n).toBe(0);
    } finally {
      await pg.close();
    }
  });
});

// M4: Stripe and the public origin come from the environment too. Fake values, built at runtime.
const FAKE_STRIPE_KEY = ['sk', 'test', 'Mn7'.repeat(16)].join('_');
const FAKE_WEBHOOK_SECRET = ['whsec', 'Mn7'.repeat(11)].join('_');

describe('createDeps: payments (M4)', () => {
  it('payments are off without STRIPE_SECRET_KEY', () => {
    const deps = createDeps({ DATABASE_URL: FAKE_DB_URL, CONTACT_EMAIL: 'court@example.com' });
    expect(deps.paymentsKind).toBe('off');
    expect(deps.payments).toBeNull();
    expect(deps.contactEmail).toBe('court@example.com');
  });

  it('stay off without a valid CONTACT_EMAIL, because the terms need a contact before money is taken', () => {
    for (const contact of [undefined, '', 'not-an-email', '  ']) {
      const deps = createDeps({ DATABASE_URL: FAKE_DB_URL, STRIPE_SECRET_KEY: FAKE_STRIPE_KEY, CONTACT_EMAIL: contact });
      expect(deps.paymentsKind, String(contact)).toBe('no-contact');
      expect(deps.payments).toBeNull();
      expect(deps.contactEmail).toBeNull();
    }
  });

  it('are on with the key and a contact; the webhook needs STRIPE_WEBHOOK_SECRET', () => {
    const env = { DATABASE_URL: FAKE_DB_URL, STRIPE_SECRET_KEY: FAKE_STRIPE_KEY, CONTACT_EMAIL: ' court@example.com ' };
    const deps = createDeps(env);
    expect(deps.paymentsKind).toBe('stripe');
    expect(deps.contactEmail).toBe('court@example.com');
    expect(typeof deps.payments.createCheckout).toBe('function');
    expect(deps.payments.webhookConfigured).toBe(false);
    expect(createDeps({ ...env, STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET }).payments.webhookConfigured).toBe(true);
  });

  it('never logs the Stripe values', () => {
    const errors = [];
    const original = [console.error, console.log, console.warn];
    console.error = console.log = console.warn = (...args) => errors.push(args.map(String).join(' '));
    try {
      createDeps({ DATABASE_URL: FAKE_DB_URL, STRIPE_SECRET_KEY: FAKE_STRIPE_KEY, STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET });
    } finally {
      [console.error, console.log, console.warn] = original;
    }
    expect(errors.join(' ')).not.toContain(FAKE_STRIPE_KEY);
    expect(errors.join(' ')).not.toContain(FAKE_WEBHOOK_SECRET);
  });
});

describe('createDeps: public origin (M4)', () => {
  it('takes PUBLIC_URL, else Render’s RENDER_EXTERNAL_URL, as an https origin; anything else is ignored', () => {
    expect(createDeps({}).publicOrigin).toBeNull();
    expect(createDeps({ PUBLIC_URL: 'https://court.example/some/path' }).publicOrigin).toBe('https://court.example');
    expect(createDeps({ RENDER_EXTERNAL_URL: 'https://pettycourt.onrender.com' }).publicOrigin).toBe('https://pettycourt.onrender.com');
    expect(
      createDeps({ PUBLIC_URL: 'https://court.example', RENDER_EXTERNAL_URL: 'https://pettycourt.onrender.com' }).publicOrigin,
    ).toBe('https://court.example');
    for (const bad of ['http://court.example', 'court.example', 'javascript:alert(1)', '']) {
      expect(createDeps({ PUBLIC_URL: bad }).publicOrigin, bad).toBeNull();
    }
  });
});

// The schema exactly as M3 shipped it (M2's tables plus the M3 columns, indexes and tables).
const M3_SCHEMA = `${M2_SCHEMA}
ALTER TABLE cases ADD COLUMN plaintiff_token text UNIQUE;
ALTER TABLE cases ADD COLUMN reported_at timestamptz;
CREATE INDEX cases_created_at_idx ON cases (created_at);
CREATE TABLE reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('names_someone', 'serious', 'mean', 'other')), note text, created_at timestamptz NOT NULL
);
CREATE INDEX reports_case_id_idx ON reports (case_id);
CREATE TABLE unlock_clicks (
  id text PRIMARY KEY, case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE, email text,
  created_at timestamptz NOT NULL, email_at timestamptz
);
CREATE INDEX unlock_clicks_case_id_idx ON unlock_clicks (case_id);`;

describe('schema upgrade from M3', () => {
  it('adds the M4 columns to an M3 database in place, keeps its rows and clicks, adds no M4 table, and can run again', async () => {
    const pg = new PGlite();
    await pg.waitReady;
    try {
      await pg.exec(M3_SCHEMA);
      const created = new Date('2026-10-30T12:00:00Z');
      await pg.query(
        `INSERT INTO cases (id, summons_token, jury_token, plaintiff_token, title, charge, plaintiff_testimony, created_at, deadline_at)
         VALUES ('m3caseAAAAAAAAAA', $1, $2, $3, 'An M3 case', 'Stole the duvet', 'Every night.', $4, $4)`,
        [newDevice(), newDevice(), newDevice(), created],
      );
      await pg.query(`INSERT INTO unlock_clicks (id, case_id, email, created_at) VALUES ($1, 'm3caseAAAAAAAAAA', 'a@example.com', $2)`, [
        newDevice(),
        created,
      ]);

      await createStore(async () => pgliteDb(pg)).ready();
      const store = createStore(async () => pgliteDb(pg));
      await store.ready();

      const columnsOf = async (table) =>
        (await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table])).rows.map(
          (r) => r.column_name,
        );
      expect(await columnsOf('cases')).toEqual(
        expect.arrayContaining([
          'paid_at',
          'appeal_click_id',
          'appeal_side',
          'appeal_evidence',
          'appealed_at',
          'appeal_verdict',
          'appeal_ruling',
          'appeal_ruled_at',
          'appeal_declined_at',
        ]),
      );
      expect(await columnsOf('unlock_clicks')).toEqual(expect.arrayContaining(['checkout_session_id', 'paid_at']));
      const tables = (
        await pg.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)
      ).rows.map((r) => r.table_name);
      // The only table since M3 is M5's case_outcomes; the list is still exact.
      expect(tables).toEqual(['case_outcomes', 'cases', 'reports', 'unlock_clicks', 'votes']);
      expect(
        (await pg.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'unlock_clicks' AND indexdef LIKE '%(checkout_session_id)%'`))
          .rows,
      ).toHaveLength(1);
      const checks = (
        await pg.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'cases'::regclass AND contype = 'c' ORDER BY 1`)
      ).rows.map((r) => r.conname);
      expect(checks.filter((name) => name.startsWith('cases_appeal'))).toEqual(['cases_appeal_side_check', 'cases_appeal_verdict_check']);

      expect(await store.getCase('m3caseAAAAAAAAAA')).toMatchObject({ title: 'An M3 case', paidAt: null, appealedAt: null });
      expect((await pg.query(`SELECT email, paid_at FROM unlock_clicks`)).rows).toEqual([{ email: 'a@example.com', paid_at: null }]);
      await expect(pg.query(`UPDATE cases SET appeal_side = 'jury'`)).rejects.toThrow(/check constraint/);
    } finally {
      await pg.close();
    }
  });
});

// The schema exactly as M4 shipped it (M3's plus the payment and appeal columns).
const M4_SCHEMA = `${M3_SCHEMA}
ALTER TABLE unlock_clicks ADD COLUMN checkout_session_id text UNIQUE;
ALTER TABLE unlock_clicks ADD COLUMN paid_at timestamptz;
ALTER TABLE cases ADD COLUMN paid_at timestamptz;
ALTER TABLE cases ADD COLUMN appeal_click_id text;
ALTER TABLE cases ADD COLUMN appeal_side text CHECK (appeal_side IN ('plaintiff', 'defendant'));
ALTER TABLE cases ADD COLUMN appeal_evidence text;
ALTER TABLE cases ADD COLUMN appealed_at timestamptz;
ALTER TABLE cases ADD COLUMN appeal_verdict text CHECK (appeal_verdict IN ('guilty', 'not_guilty', 'split'));
ALTER TABLE cases ADD COLUMN appeal_ruling text;
ALTER TABLE cases ADD COLUMN appeal_ruled_at timestamptz;
ALTER TABLE cases ADD COLUMN appeal_declined_at timestamptz;`;

describe('schema upgrade from M4 (M5)', () => {
  it('adds the visit counter, the review columns and case_outcomes in place, keeps the rows, and can run again', async () => {
    const pg = new PGlite();
    await pg.waitReady;
    try {
      await pg.exec(M4_SCHEMA);
      const created = new Date('2026-10-30T12:00:00Z');
      await pg.query(
        `INSERT INTO cases (id, summons_token, jury_token, plaintiff_token, title, charge, plaintiff_testimony, created_at,
                            deadline_at, verdict, ruling, ruled_at)
         VALUES ('m4caseAAAAAAAAAA', $1, $2, $3, 'An M4 case', 'Stole the duvet', 'Every night.', $4, $4, 'guilty', 'Guilty.', $4)`,
        [newDevice(), newDevice(), newDevice(), created],
      );

      await createStore(async () => pgliteDb(pg)).ready();
      const store = createStore(async () => pgliteDb(pg));
      await store.ready();

      const columns = (
        await pg.query(`SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_name = 'cases'`)
      ).rows;
      const visitors = columns.find((c) => c.column_name === 'visitors');
      expect(visitors).toMatchObject({ column_default: '0', is_nullable: 'NO' });
      expect(columns.map((c) => c.column_name)).toEqual(expect.arrayContaining(['review', 'reviewed_rulings']));
      await expect(pg.query(`UPDATE cases SET review = 'mean'`)).rejects.toThrow(/check constraint/);

      // The M4 case is now a live case of the M5 report, with no visitors yet and its ruling waiting for review.
      expect(await store.outcomeTotals()).toMatchObject({ cases: 1, gone: 0, visitors: 0, rulings: 1, pending: 1 });
      expect((await store.reviewQueue()).map((item) => item.id)).toEqual(['m4caseAAAAAAAAAA']);
      expect(await store.getCase('m4caseAAAAAAAAAA')).toMatchObject({ title: 'An M4 case', verdict: 'guilty' });
    } finally {
      await pg.close();
    }
  });
});

describe('Vercel entry (src/app.js default export)', () => {
  it('default-exports a Hono app that serves the home page without touching the database', async () => {
    const { default: app } = await import('../src/app.js');
    expect(typeof app.fetch).toBe('function');
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-api="/cases"');
  });

  it('answers a data request with a generic 500 when the database is not configured', async () => {
    const { createApp } = await import('../src/app.js');
    const deps = createDeps({});
    const app = createApp({ store: deps.store, judge: deps.judge });
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.map(String).join(' '));
    try {
      const res = await app.request('/cases/abcdefghijklmnop');
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toMatch(/DATABASE_URL/);
    } finally {
      console.error = original;
    }
    expect(errors.join('\n')).toMatch(/DATABASE_URL is not set/);
  });
});

describe('requestScopedPostgres (the Cloudflare Worker)', () => {
  // A stand-in for pg.Pool that records what each pool was asked and whether it was ended.
  function fakePools() {
    const pools = [];
    class Pool {
      constructor(options) {
        this.options = options;
        this.queries = [];
        this.ended = false;
        pools.push(this);
      }
      async query(sql, params) {
        if (this.ended) throw new Error('pool already ended');
        this.queries.push([sql, params]);
        return { rows: [{ sql }] };
      }
      async end() {
        this.ended = true;
      }
    }
    return { pools, Pool };
  }

  it('gives each request its own pool, ends it after the request, and never opens one for a request with no query', async () => {
    const { pools, Pool } = fakePools();
    const db = requestScopedPostgres(FAKE_DB_URL, { Pool });
    const client = await db.connect();
    expect(await db.connect()).toBe(client); // the store keeps one client per process

    await db.run(async () => {
      await client.query('SELECT 1', []);
      await client.exec('SELECT 2');
    });
    await db.run(async () => 'no query');
    const waited = [];
    await db.run(() => client.query('SELECT 3'), (p) => waited.push(p));
    await Promise.all(waited);

    expect(pools).toHaveLength(2);
    expect(pools.map((p) => p.queries.map(([sql]) => sql))).toEqual([['SELECT 1', 'SELECT 2'], ['SELECT 3']]);
    expect(pools.every((p) => p.ended)).toBe(true);
    expect(pools[0].options).toEqual({ connectionString: FAKE_DB_URL, max: 1 });
    expect(waited).toHaveLength(1); // ended through waitUntil, after the response
  });

  it('keeps concurrent requests apart, ends the pool when the request fails, and refuses a query outside a request', async () => {
    const { pools, Pool } = fakePools();
    const db = requestScopedPostgres(FAKE_DB_URL, { Pool });
    const client = await db.connect();
    const tick = () => new Promise((r) => setTimeout(r, 1));
    await Promise.all([
      db.run(async () => {
        await client.query('A1');
        await tick();
        await client.query('A2');
      }),
      db.run(async () => {
        await tick();
        await client.query('B1');
      }),
    ]);
    expect(pools.map((p) => p.queries.map(([sql]) => sql)).sort()).toEqual([['A1', 'A2'], ['B1']]);

    await expect(
      db.run(async () => {
        await client.query('C1');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(pools.at(-1).ended).toBe(true);
    expect(() => client.query('outside')).toThrow('outside a request');
  });

  it('runs the store (schema once, then queries) on the request it is in', async () => {
    const { pools, Pool } = fakePools();
    const db = requestScopedPostgres(FAKE_DB_URL, { Pool });
    const deps = createDeps({ DATABASE_URL: FAKE_DB_URL }, { database: () => db });
    await db.run(() => deps.store.ready());
    await db.run(() => deps.store.ready());
    expect(pools).toHaveLength(1); // the second request needed no query
    expect(pools[0].queries[0][0]).toContain('CREATE TABLE');
    expect(deps.db).toBe(db);
  });
});
