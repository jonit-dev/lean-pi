// Post-hoc diagnostic only: does not replace the preregistered upstream golden.
import {slugifyWithCounter as baseline} from '../real-session-audit-20260921/fixtures/slugify-counter-duplicate-slug/index.js';
import {slugifyWithCounter as codex} from './attempts/codex/workspace/index.js';
import {slugifyWithCounter as leanpi} from './attempts/leanpi/workspace/index.js';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const alphabet = ['foo', 'foo 2', 'foo-2', 'foo-2-1', 'foo-3', 'Foo'];
const sequences = [];
function collect(prefix) {
  if (prefix.length) sequences.push(prefix);
  if (prefix.length < 4) for (const word of alphabet) collect([...prefix, word]);
}
collect([]);
const outcomes = {};
for (const [name, create] of Object.entries({baseline, codex, leanpi})) {
  let failed = 0, firstFailure = null;
  for (const input of sequences) {
    const slug = create();
    const output = input.map(word => slug(word));
    const unique = new Set(output).size === output.length;
    slug.reset();
    const resetMatches = JSON.stringify(input.map(word => slug(word))) === JSON.stringify(output);
    if (!unique || !resetMatches) {
      failed++;
      firstFailure ??= {input, output, unique, resetMatches};
    }
  }
  outcomes[name] = {sequences: sequences.length, failed, firstFailure};
}
assert(outcomes.baseline.failed > 0, 'diagnostic must expose the original defect');
const report = {scope: 'Post-hoc diagnostic: uniqueness and reset over finite input sequences; not a replacement for upstream acceptance', alphabet, maxLength: 4, outcomes};
writeFileSync(new URL('./posthoc-uniqueness.json', import.meta.url), JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify(report, null, 2));
