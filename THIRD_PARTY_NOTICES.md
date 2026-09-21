# Third-party notices

LeanPi is MIT-licensed (see [`LICENSE`](LICENSE)). Two families of third-party
content are vendored into this repository, both MIT, both with their copyright
notices retained in-tree. Nothing else in the repository is copied from
elsewhere: the runtime, the benchmark harness and the model capability index are
first-party.

## Bundled skill pack — `skills/`

Vendored by `scripts/sync-skills.mjs` from `skills/pack.lock.json`, byte-locked
by sha256, with each upstream `LICENSE` copied beside the skill it covers. The
generated table lives in [`skills/NOTICE.md`](skills/NOTICE.md); the same facts:

| Skill | Upstream | Version | Licence | Copyright |
| --- | --- | --- | --- | --- |
| `i-have-adhd` | `i-have-adhd` plugin | 0.3.0 | MIT | Ayoub Ghriss |
| `ponytail-audit` | `ponytail` plugin | 4.9.0 | MIT | DietrichGebert |
| `ponytail-debt` | `ponytail` plugin | 4.9.0 | MIT | DietrichGebert |
| `ponytail-review` | `ponytail` plugin | 4.9.0 | MIT | DietrichGebert |
| `prd-creator` | first-party | sha256-4f393e0c05ec | MIT | Joao Paulo Furtado |
| `prd-executor` | first-party | sha256-4de8ab44a2ff | MIT | Joao Paulo Furtado |
| `prd-manager` | first-party | sha256-8789f05c32f9 | MIT | Joao Paulo Furtado |

## Static instruction prefix — `src/core/instructions/ponytail.md`

The Ponytail instruction bundle (`ponytail` plugin, 4.9.0, MIT, copyright
DietrichGebert) is vendored as the static prompt layer and pinned by sha256 in
`src/core/instructions/ponytail.lock.json`. Its `license: MIT` frontmatter is
retained verbatim in the vendored copy. Regenerate with `pnpm sync:ponytail`;
the integrity test fails on a drifted byte.

## Dependencies

Runtime dependencies (`package.json`) are ordinary npm packages under their own
licences; `pnpm licenses list` reports the set for an install. No dependency is
patched, forked or vendored into `src/`.
