/**
 * Secret containment (PRD-017 Phase 3, ROADMAP §48).
 *
 * Two mechanical rules, both applied in the guard: values named like secrets
 * never reach the executor or an artifact store, and the guarded `execute`
 * tool's child receives an allowlisted environment rather than the parent's.
 * The verifier and external-harness spawns are deliberately not allowlisted:
 * they run trusted, operator-configured commands (a language toolchain, a vendor
 * CLI) that may need a credential from the environment, so they inherit it.
 *
 * ponytail: name-matched value redaction only (plus explicitly configured
 * secret names). It cannot catch a secret LeanPi never saw as a value — upgrade
 * path is entropy-based scanning once a real leak escapes this set.
 */
export const SECRET_NAME_PATTERN = /(_TOKEN|_KEY|_SECRET|PASSWORD|CREDENTIAL)/i;

export const REDACTION_PREFIX = "«redacted:";

export interface SecretsPolicy {
	/** Extra variable names forwarded to spawned children on top of the base allowlist. */
	passthrough: string[];
	/** Variable names treated as secret even when the name pattern does not match. */
	secretNames: string[];
	/** Values shorter than this are not redacted; short values are trivia, not secrets. */
	minLength: number;
}

export const BUILTIN_SECRETS_POLICY: SecretsPolicy = { passthrough: [], secretNames: [], minLength: 8 };

/** Base names a spawned process needs to function; never the parent environment. */
const ENV_ALLOWLIST: Record<string, true> = {
	PATH: true,
	HOME: true,
	LANG: true,
	TERM: true,
	TMPDIR: true,
	TZ: true,
	SHELL: true,
	USER: true,
	LOGNAME: true,
};

/**
 * Env var name → value, for names that match the secret pattern or the policy's
 * own list. `resolved` carries credentials LeanPi resolved outside the process
 * environment — the project `.env` source — which the redactor would otherwise
 * not know; they are named explicitly, so only the length floor applies.
 */
export function secretValues(
	env: NodeJS.ProcessEnv,
	policy: SecretsPolicy = BUILTIN_SECRETS_POLICY,
	resolved: Iterable<[string, string | null]> = [],
): Map<string, string> {
	const named = new Set(policy.secretNames);
	const secrets = new Map<string, string>();
	for (const [name, value] of Object.entries(env)) {
		if (typeof value !== "string" || value.length < policy.minLength) continue;
		if (!named.has(name) && !SECRET_NAME_PATTERN.test(name)) continue;
		secrets.set(name, value);
	}
	for (const [name, value] of resolved) {
		if (typeof value === "string" && value.length >= policy.minLength) secrets.set(name, value);
	}
	return secrets;
}

/**
 * Literal multi-value replacement producing `«redacted:NAME»`. Longest value
 * first, so a secret that contains another secret still redacts wholly.
 */
export function redactSecrets(text: string, secrets: Map<string, string>): string {
	let redacted = text;
	const ordered = [...secrets.entries()].sort(([leftName, left], [rightName, right]) => right.length - left.length || leftName.localeCompare(rightName));
	for (const [name, value] of ordered) {
		if (value.length === 0 || !redacted.includes(value)) continue;
		redacted = redacted.split(value).join(`${REDACTION_PREFIX}${name}»`);
	}
	return redacted;
}

/** The launch environment for a child LeanPi spawns: allowlist plus passthrough, nothing else. */
export function childEnv(env: NodeJS.ProcessEnv, policy: SecretsPolicy = BUILTIN_SECRETS_POLICY): NodeJS.ProcessEnv {
	const allowed = new Set(policy.passthrough);
	const result: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(env)) {
		if (typeof value !== "string") continue;
		if (!ENV_ALLOWLIST[name] && !name.startsWith("LC_") && !allowed.has(name)) continue;
		result[name] = value;
	}
	return result;
}
