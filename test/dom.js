// A fake DOM just big enough to run the real client script (CLIENT_JS) against the server's own HTML
// in node:vm. It parses the well-formed markup src/views.js renders: elements, attributes, text.
// Selectors: `tag`, `#id`, `[attr]`, `[attr="value"]` and one `:not([attr=value])`, which is
// everything CLIENT_JS uses. No layout, no CSS, no real events: `submit(form)` calls the script's
// own submit listener and resolves when its async handler finishes.

import vm from 'node:vm';
import { CLIENT_JS } from '../src/views.js';

const VOID = new Set(['input', 'meta', 'link', 'br', 'img', 'hr']);
const ENTITIES = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const decode = (s) => s.replace(/&(?:quot|#39|lt|gt|amp);/g, (e) => ENTITIES[e]);
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export class FakeElement {
  constructor(tag, attrs = {}, parent = null) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.parent = parent;
    this.children = [];
    this.text = '';
    this.textContent = '';
    this.hidden = 'hidden' in attrs;
    this.disabled = 'disabled' in attrs;
    this.checked = 'checked' in attrs;
    this.value = attrs.value ?? '';
  }

  get id() {
    return this.attrs.id ?? '';
  }

  get dataset() {
    return Object.fromEntries(
      Object.entries(this.attrs)
        .filter(([name]) => name.startsWith('data-'))
        .map(([name, value]) => [camel(name.slice(5)), value]),
    );
  }

  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }

  hasAttribute(name) {
    return name in this.attrs;
  }

  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  matches(selector) {
    const m = /^([a-z]+)?(?:#([\w-]+))?((?:\[[^\]]+\])*)(?::not\(\[([^\]]+)\]\))?$/.exec(selector);
    if (!m) throw new Error(`fake DOM: unsupported selector ${selector}`);
    const [, tag, id, attrs, not] = m;
    const attrMatches = (spec) => {
      const [, name, value] = /^([\w-]+)(?:=["']?([^"']*)["']?)?$/.exec(spec);
      return value === undefined ? this.hasAttribute(name) : this.getAttribute(name) === value;
    };
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (id && this.id !== id) return false;
    for (const [, spec] of attrs.matchAll(/\[([^\]]+)\]/g)) if (!attrMatches(spec)) return false;
    return !(not && attrMatches(not));
  }

  querySelectorAll(selector) {
    return [...this.descendants()].filter((el) => el.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector) {
    for (let el = this; el; el = el.parent) if (el.matches(selector)) return el;
    return null;
  }

  select() {}
}

export class FakeForm extends FakeElement {}

export class FakeAnchor extends FakeElement {
  get href() {
    return this.attrs.href ?? '';
  }

  set href(value) {
    this.attrs.href = value;
  }
}

const CLASSES = { form: FakeForm, a: FakeAnchor };

/** Parse server-rendered HTML into FakeElements under one root. */
export function parse(html) {
  const root = new FakeElement('#root');
  let current = root;
  const token = /<!--[\s\S]*?-->|<![^>]*>|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  for (const [, closing, rawTag, rawAttrs = '', text] of html.matchAll(token)) {
    if (text !== undefined) {
      current.text += decode(text);
      continue;
    }
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (closing) {
      for (let el = current; el !== root; el = el.parent) {
        if (el.tagName === tag.toUpperCase()) {
          current = el.parent;
          break;
        }
      }
      continue;
    }
    const attrs = {};
    for (const [, name, value] of rawAttrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[name] = decode(value ?? '');
    const el = new (CLASSES[tag] ?? FakeElement)(tag, attrs, current);
    current.children.push(el);
    if (!VOID.has(tag)) current = el;
  }
  for (const el of root.descendants()) if (el.tagName === 'TEXTAREA') el.value = el.text;
  return root;
}

/** What `new FormData(form)` would hold: named inputs and textareas, checked radios only, no buttons. */
function formEntries(form) {
  return [...form.descendants()]
    .filter((el) => (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.hasAttribute('name'))
    .filter((el) => !['radio', 'checkbox'].includes(el.getAttribute('type')) || el.checked)
    .map((el) => [el.getAttribute('name'), el.value]);
}

/**
 * Load a page and run CLIENT_JS on it.
 * @param {string} html
 * @param {{ fetch: (url: string, init: RequestInit) => Promise<Response>, confirm?: (message: string) => boolean,
 *   localStorage?: { getItem: (key: string) => string | null, setItem: (key: string, value: string) => void } }} env
 *   localStorage: the browser's storage (M5's visit count); without it the page has none, like a browser
 *   that blocks storage.
 */
export function loadPage(html, { fetch, confirm = () => true, localStorage }) {
  const root = parse(html);
  const listeners = {};
  const location = { reloads: 0, assigned: [], replaced: [] };
  location.reload = () => {
    location.reloads += 1;
  };
  location.assign = (url) => location.assigned.push(url);
  location.replace = (url) => location.replaced.push(url);
  const document = {
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    getElementById: (id) => root.querySelector(`#${id}`),
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
  };
  function FormData(form) {
    return formEntries(form);
  }
  const context = {
    document,
    location,
    fetch,
    confirm,
    FormData,
    HTMLFormElement: FakeForm,
    HTMLAnchorElement: FakeAnchor,
    Element: FakeElement,
    navigator: { clipboard: { writeText: async () => {} } },
    ...(localStorage ? { localStorage } : {}),
  };
  vm.runInNewContext(CLIENT_JS, context);
  return {
    document,
    location,
    /** The form whose data-api is exactly `api`. */
    form: (api) => {
      const found = root.querySelectorAll('form').find((f) => f.getAttribute('data-api') === api);
      if (!found) throw new Error(`no form with data-api="${api}"`);
      return found;
    },
    submit: (form) => listeners.submit({ target: form, preventDefault() {} }),
  };
}
