// What search engines and link previews see (go-live): the public pages' titles and descriptions, the
// share image, robots.txt, sitemap.xml and the JSON-LD. Only the home, terms and privacy pages are public.
// Every page reached through a case's links (case, summons, jury, plaintiff, appeal) stays `noindex` and
// out of the sitemap, because a case is shared by its links and listed nowhere.

import { APPEAL_PRICE_CENTS, APPEAL_CURRENCY } from './payments.js';

export const SITE_NAME = 'Group Chat Court';
export const REPO_URL = 'https://github.com/smithdavedesign/pettycourt';
export const ISSUES_URL = `${REPO_URL}/issues`;

/** The 1200×630 share image, drawn by src/card.js (renderSharePng) and served at its path. */
export const SHARE_IMAGE = {
  path: '/og.png',
  width: 1200,
  height: 630,
  alt: 'Group Chat Court: settle it in court. A summons for the other side, a jury of friends and an AI judge.',
};

/** The public pages: one entry per indexable URL, each with its own title and description. */
export const PUBLIC_PAGES = {
  home: {
    path: '/',
    title: 'Group Chat Court: a mock trial for petty arguments',
    description:
      'File a petty case, send the other side a summons link, let your friends vote as the jury, and let an AI judge rule on both stories. Free to file; an appeal is $3.',
  },
  terms: {
    path: '/terms',
    title: 'Terms · Group Chat Court',
    description:
      'The terms of Group Chat Court: 18 and over, petty disputes only, rulings are jokes, no warranty, and the $3 appeal with refunds on request within 14 days.',
  },
  privacy: {
    path: '/privacy',
    title: 'Privacy · Group Chat Court',
    description:
      'What Group Chat Court stores and for how long, who else handles it, its one cookie, and the three anonymous launch counts it sends.',
  },
};

const PRICE = (APPEAL_PRICE_CENTS / 100).toFixed(2);

/**
 * The SoftwareApplication JSON-LD, as text that is safe inside a <script> element: `<` is escaped, so no
 * value can close the element, whatever the origin holds.
 * @param {string} origin  the site's origin, e.g. https://pettycourt.vercel.app
 */
export function jsonLd(origin) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    alternateName: 'pettycourt',
    description: PUBLIC_PAGES.home.description,
    url: `${origin}/`,
    image: `${origin}${SHARE_IMAGE.path}`,
    applicationCategory: 'EntertainmentApplication',
    operatingSystem: 'Web',
    offers: {
      '@type': 'Offer',
      name: 'Full trial: one appeal',
      description: 'One appeal for one case, paid once. Filing a case, the jury and the ruling are free.',
      price: PRICE,
      priceCurrency: APPEAL_CURRENCY.toUpperCase(),
      url: `${origin}/terms`,
    },
  };
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/**
 * Everything a public page's <head> needs.
 * @param {keyof typeof PUBLIC_PAGES} page
 * @param {string} origin
 */
export function pageMeta(page, origin) {
  const { path, title, description } = PUBLIC_PAGES[page];
  return {
    title,
    description,
    canonical: `${origin}${path}`,
    image: `${origin}${SHARE_IMAGE.path}`,
    jsonLd: jsonLd(origin),
  };
}

/** robots.txt: crawl everything (case pages say noindex themselves), skip the cron job, find the sitemap. */
export function robotsTxt(origin) {
  return `User-agent: *
Allow: /
Disallow: /cron/

Sitemap: ${origin}/sitemap.xml
`;
}

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** sitemap.xml: the public pages only. */
export function sitemapXml(origin) {
  const urls = Object.values(PUBLIC_PAGES)
    .map(({ path }) => `  <url><loc>${xmlEscape(`${origin}${path}`)}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}
