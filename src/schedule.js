// The daily expiry job's schedule (04:17 UTC). On the Cloudflare Worker it's a Cron Trigger in wrangler.jsonc,
// which test/worker.test.js checks against this; the pages' "deleted on <day> or the day after" promise is
// tested against it too (test/expiry.test.js).
export const EXPIRY_CRON = '17 4 * * *';
export const EXPIRY_PATH = '/cron/expire';
