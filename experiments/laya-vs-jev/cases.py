"""The evaluation set for the Laya-vs-JEV comparison.

Every case mirrors a real LeanPi decision site: the question text, option
rubrics and option cardinality are copied from the site definition in `src/`,
so both models answer exactly what LeanPi sends in production.

`expected` holds a hand-written label for each *substantive* question. Labels
were written from the case content alone, before any model was run. Meta
questions (the "how confident are you" Score) carry no label and are excluded
from accuracy; they are still sent, because that is what LeanPi sends.

Run `python cases.py` to (re)write `cases.jsonl`.
"""

from __future__ import annotations

import json
import pathlib

FAILURE = {
    "kind": "choice",
    "instructions": "Which category best describes this failure?",
    "criteria": {
        "syntax": "the code does not parse or typecheck",
        "assertion": "a test assertion failed",
        "environment": "the environment, host or backend could not run the check",
        "dependency": "a dependency could not be resolved or installed",
        "likely_logic_bug": "the code runs but behaves incorrectly",
    },
}

SNIPPET = {
    "kind": "choice",
    "instructions": None,  # per-case: "Does this grep/LSP hit ... ? <snippet>"
    "criteria": {
        "KEEP": "the hit shows code that bears on the objective",
        "DROP": "an incidental name collision, not worth a token",
    },
}

EFFORT = {
    "kind": "choice",
    "instructions": None,  # per-case
    "criteria": {
        "minimal": "one short pass is enough: the change is mechanical and locally verifiable",
        "low": "a single careful pass with a targeted check",
        "medium": "multiple steps with reasoning about call sites and edge cases",
        "high": "deep reasoning: interacting invariants, wide blast radius, or a repeated failure",
    },
}

DELEGATION = {
    "kind": "choice",
    "instructions": None,  # per-case
    "criteria": {
        "delegate": "the slices are independent enough that separate workers pay for themselves",
        "inline": "one worker, one context: the split would cost more than it saves",
    },
}

SUFFICIENCY = {
    "kind": "choice",
    "instructions": None,  # per-case
    "criteria": {
        "ENOUGH_EVIDENCE": "the accepted files and resolved symbols cover every clause of the objective",
        "NEED_MORE": "at least one objective clause has no evidence yet",
    },
}

CONFIDENCE_SCORE = {
    "kind": "score",
    "instructions": "How confident is this classification?",
    "criteria": ["unsure", "fairly sure", "certain"],
}

COMPLEXITY_YESNO = {
    "mechanical": "Is this a mechanical or rename-scale edit?",
    "explicit_result": "Is the expected result explicit?",
    "several_modules": "Does it span several modules?",
    "unfamiliar_coupled": "Is the subsystem unfamiliar or highly coupled?",
    "concurrency_perf": "Is it concurrency, compiler/runtime or performance-critical?",
}

GATE_YESNO = {
    "architecture": "Does the task require choosing or changing architecture?",
    "multi_behavior": "Does it alter multiple externally visible behaviors?",
    "ambiguous": "Does it contain materially ambiguous requirements?",
    "multi_stage": "Does it involve multiple dependent implementation stages?",
    "acceptance_helpful": "Would acceptance criteria materially reduce execution risk?",
    "localized": "Is the work a localized implementation/fix with a clear expected result?",
}


def yesno(questions: dict[str, str]) -> dict:
    return {qid: {"kind": "choice", "instructions": text, "criteria": {"yes": "yes", "no": "no"}} for qid, text in questions.items()}


def snippet_question(objective: str, path: str, text: str) -> dict:
    return {
        "kind": "choice",
        "instructions": (
            "Does this grep/LSP hit show code that bears on the objective, or is it an "
            f"incidental name collision? {path}: {text}"
        ),
        "criteria": SNIPPET["criteria"],
    }


def effort_question(complexity: str, evidence: str) -> dict:
    return {
        "kind": "choice",
        "instructions": (
            f"For this contract at complexity {complexity} with {evidence}, is minimal / low / "
            "medium / high effort the cheapest level likely to succeed?"
        ),
        "criteria": EFFORT["criteria"],
    }


def delegation_question(slices: int, threshold: int) -> dict:
    return {
        "kind": "choice",
        "instructions": (
            f"Does splitting this contract into {slices} declared independent slices save more "
            "than the extra dispatch and context cost?"
        ),
        "criteria": DELEGATION["criteria"],
    }


def subsystem_questions(objective: str, roots: list[str]) -> dict:
    return {
        "explore.subsystem.implicated": {
            "kind": "noul",
            "instructions": (
                "Does one of these enumerated subsystem roots clearly contain the code this task "
                f"must change? {objective}"
            ),
            "criteria": {"true": "one root is clearly implicated", "false": "no single root stands out"},
        },
        "explore.subsystem.root": {
            "kind": "choice",
            "instructions": (
                "Which of these enumerated subsystem roots most likely contains the code this task "
                f"must change? {objective}"
            ),
            "criteria": {root: f"the code this task must change lives under {root}" for root in roots},
        },
    }


def candidate_question(objective: str, path: str, language: str, size: int, matches: int, symbols: int, distance: int, lines: str) -> dict:
    return {
        "kind": "score",
        "instructions": (
            "How relevant is this file to the task? "
            f"objective: {objective} path: {path} ({language}, {size} bytes) "
            f"matches: {matches}, symbol hits: {symbols}, directory distance to changed files: {distance} "
            f"matched lines: {lines}"
        ),
        "criteria": ["irrelevant", "tangential", "relevant", "essential"],
    }


def sufficiency_question(objective: str, evidence: str) -> dict:
    return {
        "kind": "choice",
        "instructions": (
            "Given the objective and the evidence gathered so far (files accepted, symbols "
            f"resolved, open questions), is the evidence sufficient to start implementing? "
            f"objective: {objective} evidence: {evidence}"
        ),
        "criteria": SUFFICIENCY["criteria"],
    }


CASES: list[dict] = []


def add(case_id: str, site: str, questions: dict, expected: dict, state: dict | None = None) -> None:
    CASES.append(
        {
            "id": case_id,
            "site": site,
            "state": state if state is not None else {},
            "questions": questions,
            "expected": expected,
        }
    )


# --- executor.failure_classification: 5-way Choice -------------------------
FAILURES = [
    ("syntax", "typecheck", "src/foo.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'."),
    ("assertion", "test", "AssertionError: expected 3 to equal 4 (tests/sum.test.ts:8)"),
    ("environment", "command", "spawn npx ENOENT"),
    ("dependency", "install", "Cannot find module 'left-pad' from 'src/index.ts'"),
    ("likely_logic_bug", "test", "expected total 10, received 12 - the accumulator adds the initial value twice"),
    ("syntax", "build", "SyntaxError: Unexpected token '}' at src/app.ts:44"),
    ("environment", "command", "connect ECONNREFUSED 127.0.0.1:5432 - the test database is not running"),
    ("dependency", "install", "ERR_PNPM_NO_MATCHING_VERSION No matching version found for foo@^9.9.9"),
    ("likely_logic_bug", "test", "expected [] to have length 1 - the filter drops the only matching row"),
    ("assertion", "test", "AssertionError: expected 'a' to be 'b' (tests/label.test.ts:21)"),
    ("environment", "command", "timed out after 30000ms waiting for build to finish"),
    ("likely_logic_bug", "test", "TypeError: cannot read properties of undefined (reading 'id')"),
]
for i, (label, kind, detail) in enumerate(FAILURES, 1):
    add(
        f"failure-{i:02d}",
        "executor.failure_classification",
        {"failure_category": FAILURE},
        {"failure_category": label},
        state={"failure": {"kind": kind, "detail": detail}},
    )

# --- explore.snippet_relevance: 2-way Choice -------------------------------
SNIPPETS = [
    ("Fix the off-by-one in the pagination offset calculation", "src/pagination.ts", "const offset = (page - 1) * perPage;", "KEEP"),
    ("Fix the off-by-one in the pagination offset calculation", "src/logger.ts", "export const log = (msg: string) => console.log(msg);", "DROP"),
    ("Add retry with exponential backoff to the HTTP client", "src/retry.ts", "const delay = base * 2 ** attempt;", "KEEP"),
    ("Add retry with exponential backoff to the HTTP client", "src/colors.ts", 'export const RED = "#f00";', "DROP"),
    ("Validate the email field on signup", "src/validate.ts", "if (!/^[^@]+@[^@]+$/.test(email)) return errors.email;", "KEEP"),
    ("Validate the email field on signup", "src/db.ts", 'await pool.query("SELECT 1")', "DROP"),
    ("Cache the user profile response", "src/profile.ts", "const cached = cache.get(userId);", "KEEP"),
    ("Cache the user profile response", "src/profile.test.ts", "expect(cache.get('u1')).toBeUndefined()", "KEEP"),
    ("Rename getUser to fetchUser", "src/api.ts", "export async function getUser(id: string) {", "KEEP"),
    ("Rename getUser to fetchUser", "Dockerfile", "FROM node:22", "DROP"),
    ("Fix the race condition in the job queue", "src/queue.ts", "this.lock.acquire();", "KEEP"),
    ("Fix the race condition in the job queue", "src/queue.ts", "this.metrics.increment('jobs');", "DROP"),
]
for i, (objective, path, text, label) in enumerate(SNIPPETS, 1):
    add(
        f"snippet-{i:02d}",
        "explore.snippet_relevance",
        {"snippet": snippet_question(objective, path, text)},
        {"snippet": label},
        state={"objective": objective},
    )

# --- routing.reasoning_effort: 4-way Choice --------------------------------
EFFORTS = [
    ("LOW", "a mechanical rename in one file and existing tests passing", "minimal"),
    ("LOW", "a string copy change with no logic", "minimal"),
    ("MEDIUM", "3 call sites and one edge case in null handling", "medium"),
    ("MEDIUM", "a new branch plus an error path, tests covering both", "low"),
    ("HIGH", "interacting invariants in the scheduler and a previous fix that regressed", "high"),
    ("HIGH", "concurrency plus a migration and a wide blast radius", "high"),
    ("MEDIUM", "a single function with a clear contract", "low"),
    ("HIGH", "compiler internals in an unfamiliar subsystem", "high"),
]
for i, (complexity, evidence, label) in enumerate(EFFORTS, 1):
    add(
        f"effort-{i:02d}",
        "routing.reasoning_effort",
        {"effort": effort_question(complexity, evidence)},
        {"effort": label},
        state={"complexity": complexity, "evidence": evidence},
    )

# --- routing.delegation_worth: 2-way Choice --------------------------------
DELEGATIONS = [(1, 2, "inline"), (4, 2, "delegate"), (2, 2, "inline"), (5, 3, "delegate"), (3, 3, "inline"), (6, 4, "delegate")]
for i, (slices, threshold, label) in enumerate(DELEGATIONS, 1):
    add(
        f"delegation-{i:02d}",
        "routing.delegation_worth",
        {"delegation": delegation_question(slices, threshold)},
        {"delegation": label},
        state={"slices": slices, "threshold": threshold},
    )

# --- explore.sufficiency: 2-way Choice -------------------------------------
SUFFICIENCIES = [
    ("Fix the pagination offset", "accepted pagination.ts (offset calc) and pagination.test.ts; symbol offset resolved", "ENOUGH_EVIDENCE"),
    ("Fix the pagination offset", "accepted pagination.ts only, no test, offset symbol unresolved", "NEED_MORE"),
    ("Add retry to the HTTP client", "accepted retry.ts and client.ts; retryDelay symbol unresolved", "NEED_MORE"),
    ("Add retry to the HTTP client", "accepted retry.ts, client.ts and retry.test.ts; all symbols resolved; one objective clause", "ENOUGH_EVIDENCE"),
    ("Reduce parser time", "accepted parser.ts; no profiling data; the 'redundant AST pass' clause is unresolved", "NEED_MORE"),
    ("Update license headers", "accepted LICENSE and all 200 files enumerated; no symbol questions", "ENOUGH_EVIDENCE"),
    ("Fix the blank dashboard", "accepted dashboard.tsx; no reproduction; cause unknown", "NEED_MORE"),
    ("Rename getUser to fetchUser", "accepted api.ts, callers.ts and README.md; all call sites found", "ENOUGH_EVIDENCE"),
]
for i, (objective, evidence, label) in enumerate(SUFFICIENCIES, 1):
    add(
        f"sufficiency-{i:02d}",
        "explore.sufficiency",
        {"explore.sufficiency.stop": sufficiency_question(objective, evidence)},
        {"explore.sufficiency.stop": label},
        state={"objective": objective, "evidence": evidence},
    )

# --- explore.candidate_relevance: Score (0..3) -----------------------------
CANDIDATES = [
    ("Fix the off-by-one in the pagination offset calculation", "src/pagination.ts", "typescript", 2048, 4, 2, 0, "12: const offset = (page - 1) * perPage;", 3),
    ("Fix the off-by-one in the pagination offset calculation", "src/logger.ts", "typescript", 900, 1, 0, 3, "4: export const log = (m: string) => console.log(m);", 0),
    ("Fix the off-by-one in the pagination offset calculation", "src/pagination.test.ts", "typescript", 1500, 3, 1, 0, "8: expect(offset(2)).toBe(10)", 3),
    ("Add retry with exponential backoff to the HTTP client", "src/retry.ts", "typescript", 1200, 5, 3, 0, "3: const delay = base * 2 ** attempt;", 3),
    ("Add retry with exponential backoff to the HTTP client", "src/http.ts", "typescript", 3000, 2, 1, 0, "40: await this.send(request)", 2),
    ("Add retry with exponential backoff to the HTTP client", "src/theme.ts", "typescript", 800, 0, 0, 4, "matched lines: none", 0),
    ("Validate the email field on signup", "src/validate.ts", "typescript", 1100, 4, 2, 0, "9: if (!EMAIL.test(email))", 3),
    ("Validate the email field on signup", "src/forms/helpers.ts", "typescript", 2000, 1, 0, 1, "22: export const trim = (s: string) => s.trim()", 1),
    ("Make the parser 2x faster by removing a redundant AST pass", "src/parser/pass.ts", "typescript", 4000, 6, 4, 0, "17: visit(node) // second pass", 3),
    ("Make the parser 2x faster by removing a redundant AST pass", "src/parser/index.ts", "typescript", 900, 1, 0, 0, "5: export * from './pass.js'", 2),
    ("Rename getUser to fetchUser", "src/api.ts", "typescript", 2500, 7, 5, 0, "31: export async function getUser(", 3),
    ("Rename getUser to fetchUser", "docs/api.md", "markdown", 4000, 2, 0, 2, "10: ### getUser", 1),
]
for i, (objective, path, language, size, matches, symbols, distance, lines, target) in enumerate(CANDIDATES, 1):
    add(
        f"candidate-{i:02d}",
        "explore.candidate_relevance",
        {f"candidate:{path}": candidate_question(objective, path, language, size, matches, symbols, distance, lines)},
        {f"candidate:{path}": target},
        state={"objective": objective, "path": path},
    )

# --- explore.subsystem_order: Noul + Choice (mixed-kind batch) -------------
SUBSYSTEMS = [
    (
        "Fix the pagination offset calculation in the API list endpoint",
        ["src/api", "src/parser", "src/telemetry", "src/theme"],
        {"explore.subsystem.implicated": 1.0, "explore.subsystem.root": "src/api"},
    ),
    (
        "Add retry with exponential backoff to the HTTP client",
        ["src/http", "src/db", "src/cli"],
        {"explore.subsystem.implicated": 1.0, "explore.subsystem.root": "src/http"},
    ),
    (
        "Make the parser 2x faster by removing a redundant AST pass",
        ["src/parser", "src/api", "src/theme"],
        {"explore.subsystem.implicated": 1.0, "explore.subsystem.root": "src/parser"},
    ),
    (
        "Investigate a general slowdown across the whole service",
        ["src/api", "src/db", "src/worker", "src/cache"],
        {"explore.subsystem.implicated": 0.0},
    ),
    (
        "Update the license header year in all source files",
        ["src", "docs", "scripts"],
        {"explore.subsystem.implicated": 0.0},
    ),
    (
        "Fix the race condition in the worker pool shutdown sequence",
        ["src/worker", "src/api", "src/theme"],
        {"explore.subsystem.implicated": 1.0, "explore.subsystem.root": "src/worker"},
    ),
]
for i, (objective, roots, labels) in enumerate(SUBSYSTEMS, 1):
    add(
        f"subsystem-{i:02d}",
        "explore.subsystem_order",
        subsystem_questions(objective, roots),
        labels,
        state={"objective": objective, "roots": roots},
    )

# --- classify.execution_complexity: 5 Choice + 1 Score ---------------------
COMPLEXITY = [
    (
        "Rename the CSS color variable --brand-blue to --brand-primary across one file",
        {"mechanical": "yes", "explicit_result": "yes", "several_modules": "no", "unfamiliar_coupled": "no", "concurrency_perf": "no"},
    ),
    (
        "Fix a race condition in the worker pool's shutdown sequence",
        {"mechanical": "no", "explicit_result": "yes", "several_modules": "no", "unfamiliar_coupled": "yes", "concurrency_perf": "yes"},
    ),
    (
        "Add a new REST endpoint /users/:id/avatar that stores uploads in S3, updates the DB, and invalidates the CDN",
        {"mechanical": "no", "explicit_result": "yes", "several_modules": "yes", "unfamiliar_coupled": "no", "concurrency_perf": "no"},
    ),
    (
        "Make the parser 2x faster by removing a redundant AST pass",
        {"mechanical": "no", "explicit_result": "yes", "several_modules": "no", "unfamiliar_coupled": "yes", "concurrency_perf": "yes"},
    ),
    (
        "Update the license header year in all 200 source files",
        {"mechanical": "yes", "explicit_result": "yes", "several_modules": "no", "unfamiliar_coupled": "no", "concurrency_perf": "no"},
    ),
    (
        "Replace the hand-rolled date formatting with date-fns across the reporting module",
        {"mechanical": "no", "explicit_result": "yes", "several_modules": "no", "unfamiliar_coupled": "no", "concurrency_perf": "no"},
    ),
]
for i, (request, labels) in enumerate(COMPLEXITY, 1):
    questions = yesno(COMPLEXITY_YESNO)
    questions["confidence"] = CONFIDENCE_SCORE
    add(
        f"complexity-{i:02d}",
        "classify.execution_complexity",
        questions,
        labels,
        state={"request": request},
    )

# --- gate.prd_required: 6 Choice + 1 Score ---------------------------------
GATES = [
    (
        "Rename a variable in src/util.ts",
        {"architecture": "no", "multi_behavior": "no", "ambiguous": "no", "multi_stage": "no", "acceptance_helpful": "no", "localized": "yes"},
    ),
    (
        "Rewrite the auth layer to support OIDC and migrate existing sessions",
        {"architecture": "yes", "multi_behavior": "yes", "ambiguous": "no", "multi_stage": "yes", "acceptance_helpful": "yes", "localized": "no"},
    ),
    (
        "Add a --verbose flag to the CLI",
        {"architecture": "no", "multi_behavior": "no", "ambiguous": "no", "multi_stage": "no", "acceptance_helpful": "no", "localized": "yes"},
    ),
    (
        "Figure out why some users see a blank dashboard and fix it",
        {"architecture": "no", "multi_behavior": "no", "ambiguous": "yes", "multi_stage": "no", "acceptance_helpful": "yes", "localized": "no"},
    ),
    (
        "Port the payment module from the legacy service, then update the webhooks",
        {"architecture": "yes", "multi_behavior": "yes", "ambiguous": "no", "multi_stage": "yes", "acceptance_helpful": "yes", "localized": "no"},
    ),
    (
        "Fix the typo in the error message for invalid email",
        {"architecture": "no", "multi_behavior": "no", "ambiguous": "no", "multi_stage": "no", "acceptance_helpful": "no", "localized": "yes"},
    ),
]
for i, (request, labels) in enumerate(GATES, 1):
    questions = yesno(GATE_YESNO)
    questions["confidence"] = CONFIDENCE_SCORE
    add(
        f"gate-{i:02d}",
        "gate.prd_required",
        questions,
        labels,
        state={"request": request},
    )


def to_wire(case: dict) -> dict:
    """`kind` is LeanPi's in-process name for a question type; the wire field is `type`."""
    questions = {}
    for qid, question in case["questions"].items():
        questions[qid] = {"type": question["kind"], **{k: v for k, v in question.items() if k != "kind"}}
    return {**case, "questions": questions}


if __name__ == "__main__":
    out = pathlib.Path(__file__).with_name("cases.jsonl")
    out.write_text("".join(json.dumps(to_wire(case)) + "\n" for case in CASES))
    sites = sorted({case["site"] for case in CASES})
    labelled = sum(len(case["expected"]) for case in CASES)
    asked = sum(len(case["questions"]) for case in CASES)
    print(f"wrote {out} - {len(CASES)} cases, {asked} questions asked, {labelled} labelled")
    for site in sites:
        n = sum(1 for c in CASES if c["site"] == site)
        print(f"  {site}: {n} cases")
