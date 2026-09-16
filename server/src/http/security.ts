// spec/11-security.md §4 — the hardening headers and the Content-Security-Policy.
//
// The CSP is a contract with what M3/M5/M6 shipped, not a string to tighten blindly:
// `img-src https:` keeps the Sources-footer favicons (spec/11-security.md §4 says so in the
// parenthesis), `style-src 'unsafe-inline'` keeps Tailwind's injected styles and CodeMirror's
// inline style attributes, and `connect-src 'self'` covers both SSE channels. Uploads keep
// their own `Content-Security-Policy: sandbox` (spec/09-api.md §10) — a served image must never
// become an origin-privileged document, and `sandbox` is the directive that says so.
import type { Config } from "../config.js";

export const PRODUCTION_CSP = [
	"default-src 'self'",
	"img-src 'self' data: blob: https:",
	"style-src 'self' 'unsafe-inline'",
	"script-src 'self'",
	"connect-src 'self'",
	"frame-ancestors 'none'",
	"base-uri 'none'",
	"object-src 'none'",
].join("; ");

/**
 * In development the SPA is served by Vite on :5173 (module scripts rewritten on the fly, an
 * HMR websocket, `eval`-based sourcemaps), and piui answers /api behind its proxy. A production
 * CSP there blanks the page with no error the suite can see — so dev widens exactly three
 * directives and nothing else.
 */
export const DEVELOPMENT_CSP = [
	"default-src 'self'",
	"img-src 'self' data: blob: https:",
	"style-src 'self' 'unsafe-inline'",
	"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
	"connect-src 'self' ws: http://localhost:5173 http://127.0.0.1:5173",
	"frame-ancestors 'none'",
	"base-uri 'none'",
	"object-src 'none'",
].join("; ");

export function securityHeaders(config: Config): Record<string, string> {
	return {
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		"x-frame-options": "DENY",
		"permissions-policy": "geolocation=(), microphone=(), camera=()",
		"content-security-policy": config.nodeEnv === "production" ? PRODUCTION_CSP : DEVELOPMENT_CSP,
	};
}
