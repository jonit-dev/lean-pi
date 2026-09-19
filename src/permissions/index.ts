/**
 * Public surface of the permission engine (PRD-017).
 *
 * `src/index.ts` re-exports this barrel; `activate()` calls
 * `loadPermissionState`, `installPermissionGuard` and
 * `registerPermissionsCommand`.
 */
export {
	BUILTIN_DEFAULTS,
	DECISION_RANK,
	PERMISSION_DECISIONS,
	SCOPES,
	builtinPermissions,
	capabilityId,
	classifyScopes,
	escapesRoot,
	globMatch,
	isPermissionDecision,
	isScope,
	literalPrefixLength,
	mcpTargetOf,
	parseCapability,
	pathTokens,
	resolve,
	resolveAll,
} from "./rules.js";
export type {
	AggregateResolution,
	CallShape,
	ClassifiedScope,
	DecisionSource,
	IgnoredProjectGrant,
	PermissionDecision,
	PermissionRule,
	PermissionsConfig,
	Resolution,
	Scope,
} from "./rules.js";
export {
	BUILTIN_SECRETS_POLICY,
	REDACTION_PREFIX,
	SECRET_NAME_PATTERN,
	childEnv,
	redactSecrets,
	secretValues,
} from "./secrets.js";
export type { SecretsPolicy } from "./secrets.js";
export {
	assertTrusted,
	grantTrust,
	isProjectLocal,
	mergePermissions,
	permissionsPath,
	projectSurface,
	projectSurfaceHash,
	readUserState,
	surfaceFiles,
	trustState,
	writeUserDefault,
	writeUserRule,
	writeUserSecretsPolicy,
} from "./trust.js";
export type {
	McpServerDeclaration,
	PermissionEnv,
	ProjectSurface,
	ProjectTrustStatus,
	RawPermissionsBlock,
	ResolvedPermissions,
	SurfaceDeclaration,
	TrustRecord,
	TrustedProjectSubset,
	UserPermissionState,
} from "./trust.js";
export { loadPermissionState } from "./state.js";
export type { PermissionState } from "./state.js";
export { evaluateCall, installPermissionGuard, refusalText } from "./guard.js";
export type { CallEvaluation, GuardDeps, GuardQuestion, PermissionAuditRow, PermissionGuard } from "./guard.js";
export { registerPermissionsCommand, renderPermissions } from "./commands.js";
export type { PermissionsCommandDeps } from "./commands.js";
