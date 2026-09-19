// The CLI fixture `cli_invocation` runs (PRD-022 AC-2).
//
// It echoes the stdin it actually received and prints a marker, so a mismatch
// against the contract's declared expectation is a real difference between what
// the program emitted and what was declared — and so a verifier that skipped the
// invocation cannot reproduce the marker from the artifact.
import { readFileSync } from "node:fs";

const stdin = readFileSync(0, "utf8").trim();
console.log(`CLI_STDOUT hello ${stdin}`);
console.error("CLI_STDERR noted the invocation");
process.exit(0);
