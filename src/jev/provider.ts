/**
 * The control-plane provider seam (PRD-042 Phase 1).
 *
 * PRD-002 built the client against one implementation: TypeSafe's hosted
 * `/v1/systemone`. This module turns "the control plane" into an injectable
 * value, so a second implementation (the local Laya runtime, `./laya.ts`) can
 * answer the same registered sites without a branch entering `client.ts`.
 *
 * `typesafeProvider` is a literal extraction of the client's previous body —
 * `resolveCredential` plus the configured endpoint and model — so a client built
 * without a provider behaves exactly as before, and every existing caller and
 * spec is the regression gate for that claim.
 */
import type { JevProvider } from "../core/types.js";
import type { CredentialSource, ResolvedCredential } from "./credentials.js";

export interface ControlPlaneTarget {
	endpoint: string;
	key: string | null;
	source: CredentialSource;
	model: string;
}

export interface ControlPlaneProvider {
	readonly name: JevProvider;
	/**
	 * The source `credentialSource()` reports. Sync on purpose: it is read on
	 * paths that cannot await, and it is a fact about *which* provider is
	 * configured, not about whether it is reachable right now.
	 */
	readonly source: CredentialSource;
	/**
	 * Where the next request goes. Called on every `ask()`, memoized by the
	 * implementation when the resolution is expensive (a local server start).
	 * Rejecting is the documented failure mode: the client resolves the site
	 * through its registered fallback and never rethrows.
	 */
	resolve(): Promise<ControlPlaneTarget>;
	/** Released on session shutdown; the Laya provider terminates its server here. */
	dispose?(): Promise<void>;
}

export interface TypesafeProviderOptions {
	endpoint: string;
	model: string;
	credential: () => ResolvedCredential;
}

/** The hosted provider, unchanged from PRD-002's inline resolution. */
export function typesafeProvider(options: TypesafeProviderOptions): ControlPlaneProvider {
	return {
		name: "typesafe",
		get source() {
			return options.credential().source;
		},
		async resolve() {
			const credential = options.credential();
			return { endpoint: options.endpoint, key: credential.key, source: credential.source, model: options.model };
		},
	};
}
