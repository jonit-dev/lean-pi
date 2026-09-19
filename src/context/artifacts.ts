/**
 * The `artifact://` store and reversible capture (PRD-014 Phase 1, ROADMAP §21).
 *
 * Large tool results become a compact record plus a pointer to the exact bytes;
 * `expand()` returns those bytes unchanged, which is what makes the reduction
 * reversible rather than lossy. Content addressing is a sha256 of the bytes and
 * the storage is the filesystem — no database, no compression layer, no index
 * service.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildExcerpt } from "./excerpt.js";

export interface CompactRecord {
	compact: true;
	kind: string;
	exitCode: number | null;
	/** ISO timestamp of the captured call. */
	timestamp: string;
	sourceRef: string;
	bytes: number;
	sha256: string;
	excerpt: string;
	/** `artifact://<kind>/<id>`, absent only when nothing was stored. */
	artifact: string | null;
}

export interface CaptureInput {
	output: string;
	kind?: string;
	sourceRef: string;
	exitCode?: number | null;
	timestamp?: string;
	/** Force storage regardless of size, for callers that must have a ref. */
	always?: boolean;
}

export interface CaptureResult {
	/** `null` when the output passed through untouched. */
	record: CompactRecord | null;
	/** What the caller should place in context. */
	text: string;
}

export interface ArtifactStore {
	readonly sessionDir: string;
	store(bytes: string | Buffer, kind: string, sourceRef: string): string;
	expand(ref: string): Buffer;
	capture(input: CaptureInput): CaptureResult;
	refPath(ref: string): string;
	/** Content hash used for dedup; identical bytes produce an identical id. */
	refFor(bytes: string | Buffer, kind: string): string;
}

export class ArtifactNotFoundError extends Error {
	constructor(ref: string) {
		super(`Artifact ${ref} is not stored; the exact bytes are unavailable.`);
		this.name = "ArtifactNotFoundError";
	}
}

export function sha256(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export interface ArtifactStoreOptions {
	sessionDir: string;
	/** Above this many bytes `capture()` stores and compacts; below it passes through. */
	thresholdBytes?: number;
	now?: () => Date;
}

export function createArtifactStore(options: ArtifactStoreOptions): ArtifactStore {
	const sessionDir = options.sessionDir;
	const threshold = options.thresholdBytes ?? 32_768;
	const now = options.now ?? (() => new Date());

	const refPath = (ref: string) => {
		const match = /^artifact:\/\/([^/]+)\/([A-Za-z0-9._-]+)$/.exec(ref);
		if (!match) throw new ArtifactNotFoundError(ref);
		return join(sessionDir, "artifacts", match[1]!, match[2]!);
	};

	const store = (bytes: string | Buffer, kind: string, sourceRef: string): string => {
		const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
		const id = sha256(buffer);
		const path = join(sessionDir, "artifacts", kind, id);
		mkdirSync(dirname(path), { recursive: true });
		if (!existsSync(path)) writeFileSync(path, buffer);
		void sourceRef;
		return `artifact://${kind}/${id}`;
	};

	return {
		sessionDir,
		store,
		refPath,
		refFor: (bytes, kind) => `artifact://${kind}/${sha256(bytes)}`,
		expand(ref) {
			const path = refPath(ref);
			if (!existsSync(path)) throw new ArtifactNotFoundError(ref);
			return readFileSync(path);
		},
		capture(input) {
			const bytes = Buffer.from(input.output, "utf8");
			const kind = input.kind ?? "tool";
			const large = bytes.byteLength >= threshold;
			if (!large && !input.always) {
				return {
					record: null,
					text: input.output,
				};
			}
			const artifact = store(bytes, kind, input.sourceRef);
			const record: CompactRecord = {
				compact: true,
				kind,
				exitCode: input.exitCode ?? null,
				timestamp: input.timestamp ?? now().toISOString(),
				sourceRef: input.sourceRef,
				bytes: bytes.byteLength,
				sha256: sha256(bytes),
				excerpt: buildExcerpt(input.output),
				artifact,
			};
			return { record, text: renderCompactRecord(record) };
		},
	};
}

/** The compact record as the executor sees it: facts, an excerpt, and the pointer. */
export function renderCompactRecord(record: CompactRecord): string {
	const lines = [
		`[compact ${record.kind}] ${record.sourceRef}`,
		`exit: ${record.exitCode ?? "unknown"} · ${record.timestamp} · ${record.bytes} bytes`,
		record.excerpt,
		`[full output: ${record.artifact}]`,
	];
	return lines.filter((line) => line.length > 0).join("\n");
}
