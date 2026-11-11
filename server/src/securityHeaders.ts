// Response headers for every route: the dashboard cannot be framed or sniffed, and the page
// may only run its own script, talk to its own server and load the two font hosts its index.html may name.
import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';

/** The page's Content-Security-Policy, one directive per entry; `script-src` also names each inline script allowed by its hash. */
function contentPolicy(scriptHashes: readonly string[]): string {
  const directives: [name: string, sources: string][] = [
    ['default-src', "'self'"],
    ['script-src', ["'self'", ...scriptHashes.map((hash) => `'${hash}'`)].join(' ')],
    ['style-src', "'self' 'unsafe-inline' https://fonts.googleapis.com"],
    ['font-src', "'self' https://fonts.gstatic.com"],
    ['img-src', "'self' data:"],
    ['connect-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
  ];
  return directives.map(([name, sources]) => `${name} ${sources}`).join('; ');
}

/** The headers every response carries; `scriptHashes` are the inline scripts of the page the policy lets run. */
export function securityHeaders(scriptHashes: readonly string[] = []): RequestHandler {
  const headers: [name: string, value: string][] = [
    ['Content-Security-Policy', contentPolicy(scriptHashes)],
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'no-referrer'],
  ];
  return (_req, res, next) => {
    for (const [name, value] of headers) res.setHeader(name, value);
    next();
  };
}

/** A `<script>` element: its attributes, when it has any, and its body. */
const SCRIPT_ELEMENT = /<script(\s[^>]*)?>([\s\S]*?)<\/script[^>]*>/gi;

/** The `sha256-…` source of each inline `<script>` in a page, so the policy allows those and no other inline script. */
export function inlineScriptHashes(page: string): string[] {
  return Array.from(page.matchAll(SCRIPT_ELEMENT))
    .filter(([, attributes = '']) => !/\bsrc\s*=/i.test(attributes))
    .map(([, , body = '']) => `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`);
}
