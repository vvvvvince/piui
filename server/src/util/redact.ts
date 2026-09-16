// spec/11-security.md §3 — the one scrubber. M2 introduced it for provider error messages
// (`sanitizeMessage`); M7 reuses the same pattern for the audit log, so there is one rule for
// "this string may not reach a log or a client", not two that drift.

/** Anything key-shaped is scrubbed before a message reaches a log or a client. */
const KEY_SHAPED = /\b(sk|pat|ghp|xoxb|gsk|api)[-_][A-Za-z0-9_-]{8,}/g;

export function redact(message: string, secrets: readonly string[] = []): string {
	let out = message;
	for (const secret of secrets) {
		if (secret.length < 4) continue;
		while (out.includes(secret)) out = out.replace(secret, "***");
	}
	return out.replace(KEY_SHAPED, "***");
}
