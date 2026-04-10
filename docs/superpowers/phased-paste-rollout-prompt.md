You are orchestrating a phased rollout of paste reliability fixes on the `WyrmKeep/jetkvm-reliable-paste-private` fork. Before any action, ask the user which phase to execute (1–5). Do NOT assume.

<roadmap>
## Phase dependency graph

Phase 1  #42 + #48 + part of #34   Correctness foundation (paste-depth semantics, shallow queue)
   │
Phase 2  #38 (bundles rest of #34) Large-paste safe mode with true drain boundaries
   │
   ├── Phase 3a  #40                Derived-constant profile fix
   └── Phase 3b  #43                Timer reuse in macro execution loop
         │  (3a and 3b independent, land either order)
Phase 4  #44                        Timed-sequence HID writer (REDESIGN required)
   │
Phase 5  #45                        Frontend alloc cleanup + vitest harness

## Phase details

| Phase | Issues | Lead agent composition | Branch name | Touch list |
|---|---|---|---|---|
| 1 | #42, #48, bundled #34 | `researcher` + `go-backend-dev` | `fix/paste-depth-semantics` | `jsonrpc.go`, `hidrpc.go`, `internal/hidrpc/message.go`, `internal/usbgadget/hid_keyboard.go`, `ui/src/hooks/useKeyboard.ts` |
| 2 | #38 | `researcher` + `go-backend-dev` + `react-frontend-dev` | `feat/large-paste-safe-mode` | `ui/src/hooks/useKeyboard.ts`, `ui/src/utils/pasteMacro.ts`, `ui/src/components/popovers/PasteModal.tsx`, `jsonrpc.go` |
| 3a | #40 | `researcher` + `react-frontend-dev` | `fix/paste-profile-derived-constants` | `ui/src/utils/pasteBatches.ts`, `ui/src/utils/pasteMacro.ts` |
| 3b | #43 | `researcher` + `go-backend-dev` | `perf/macro-timer-reuse` | `jsonrpc.go` only |
| 4 | #44 + residual #34 | `researcher` + `go-backend-dev` | `perf/timed-sequence-hid-writer` | `internal/usbgadget/hid_keyboard.go`, `jsonrpc.go` |
| 5 | #45 | `researcher` + `react-frontend-dev` | `perf/frontend-paste-alloc-cleanup` | `ui/src/utils/pasteMacro.ts`, `ui/src/hooks/hidRpc.ts`, `ui/package.json`, new `ui/src/utils/pasteMacro.test.ts` |
</roadmap>

<preflight>
## Starting-state checks (MANDATORY before team creation)

1. Read the issue(s) for the selected phase with `gh issue view` — do NOT guess content
2. Verify current branch is clean: `git status` must show no uncommitted changes
3. Pull latest main: `git checkout main && git pull`
4. For phases 2–5: verify predecessor phases are MERGED on main via `gh pr list --state merged --search "<predecessor-issue>"` — if any are still open, STOP and ask the user how to proceed
5. Create the phase branch from latest main: `git checkout -b <branch-name-from-table>`
6. Verify no stale build artifacts: `cd ui && ls -la src/utils/pasteBatches.ts` (file should exist; if not, STOP)

If any check fails, STOP and report to the user. Do not improvise around a dirty tree.
</preflight>

<workflow>
## Per-phase execution (10 steps + two cross-review gates, executed in order)

Two independent external cross-reviews are wired into this workflow:

- **Step 4.5 — Oracle cross-review** (spec + plan level, via GPT-5.4 Pro browser mode, before implementation)
- **Step 6.5 — Codex cross-review** (commit level, via codex CLI, after verification and before the in-house reviewer)

Both feed into Step 7, where the in-house reviewer synthesizes the signals rather than repeating them.

**Step 1 — Team creation**
Use `TeamCreate` with `team_name: issue-<primary-number>-<slug>`, `agent_type: jetkvm-issue-team`. Create the `TaskList` via `TaskCreate` with one task per workflow step, chained via `addBlockedBy`.

**Step 2 — Research**
Spawn a `researcher` teammate (`subagent_type: Explore`) in the background with a self-contained prompt including:
- Phase number, issue number(s), branch name
- Exact file paths from the touch list
- Instructions to use `mcp__plugin_context7_context7__resolve-library-id` + `query-docs` for ANY external library reference (React hooks, Zustand, Go time package, etc.)
- Explicit output format: "structured report with sections for each investigation point; include line numbers and function signatures; clearly state what IS vs what the issue CLAIMS"

Do NOT touch implementation while the researcher is running. Mark the research task `in_progress`, claim ownership, wait for the report.

**Step 3 — Brainstorming**
Invoke `Skill: superpowers:brainstorming`. Present 2–3 concrete approaches with trade-offs. Get user approval on an approach before proceeding. Do NOT skip this — even for phases that seem mechanical, approach choice affects later phases.

**Step 4 — Writing the plan**
Invoke `Skill: superpowers:writing-plans`. Plan must include:
- Exact code diffs per task (no placeholders, no "similar to above")
- Verification commands per task (`tsc --noEmit`, `eslint`, or `go test` as applicable)
- Commit message per task following the repo's `type(scope): description (#N)` convention
- Rollback condition per task

Save to `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`. Commit the plan.

**Step 4.5 — Oracle cross-review (spec + plan against GPT-5.4 Pro)**
Before implementation, cross-review the spec and plan with GPT-5.4 Pro via oracle. This catches design-level issues before any code is written — much cheaper than catching them at Step 7. The project folder is pinned in `~/.oracle/config.json`, so no `--chatgpt-url` flag is needed.

**Input assembly (all three are mandatory):**

1. **Issue bodies** — fetch to disk so oracle reads the source of truth, not a paraphrase:
```bash
mkdir -p /tmp/oracle-phase-<N> && for n in <comma-separated issue numbers>; do
  gh issue view "$n" --repo WyrmKeep/jetkvm-reliable-paste-private > "/tmp/oracle-phase-<N>/issue-$n.md"
done
```

2. **Spec and plan** — attached via `--file`. Use the exact paths from Steps 3 and 4.

3. **Explicit cross-review ask** — the prompt must name Phase, closing issues, goal, and list each focus area.

**Invocation** (run in the background, ~10 minutes; do NOT start implementation while it runs):
```bash
oracle --engine browser --browser-manual-login \
  --browser-auto-reattach-delay 5s --browser-auto-reattach-interval 3s --browser-auto-reattach-timeout 60s \
  --file /tmp/oracle-phase-<N>/issue-*.md \
  --file docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md \
  --file docs/superpowers/plans/YYYY-MM-DD-<topic>.md \
  -p "Cross-review Phase <N> (closes <#N1 #N2 ...>). Goal: <1-line goal from the spec>. Attached: (1) issue bodies defining the problem and acceptance criteria, (2) the design spec with correctness invariants and race walkthroughs, (3) the implementation plan with exact task-by-task diffs. Cross-review the spec and plan against the issue bodies. Verify: correctness invariants are sound, scope constraints are enforceable, race walkthroughs are complete, protocol assumptions match current main, no gaps between spec and plan, and every spec requirement maps to a plan task. Flag any load-bearing assumption that is unstated. Suggest concrete improvements with file:line or section references. If you find nothing substantive, say APPROVE."
```

**When oracle returns:** synthesize its verdict with your own independent read of the spec and plan. Do NOT rubber-stamp. Present to the user:
- Oracle's verdict and the top 3–5 findings
- For each finding: whether you agree, push back, or consider it stylistic
- Proposed resolution for each finding worth acting on

**If the user wants to incorporate suggestions:** loop back, revise spec and/or plan, commit new revisions. Re-run oracle ONLY if the revisions are substantive (not typos/wording) — otherwise proceed directly to the user approval gate.

**If oracle fails to run** (login probe error, Chrome profile lock, companion runtime issue, etc.): fall back to presenting the plan+spec for user review without oracle's input, note the oracle gap explicitly in the Step 7 reviewer dispatch so the code-reviewer knows there was no spec-level independent cross-check, and proceed. Do NOT block the phase on oracle.

Record oracle's final verdict (APPROVE / REQUEST CHANGES / BLOCK / DEFERRED) and top findings for inclusion in Step 7 and Step 8.

Ask the user to approve both the plan and oracle's findings before proceeding to Step 5.

**Step 5 — Implementation**
For each implementation task, spawn the appropriate dev teammate(s) from the phase table. Use `mode: plan` on the Agent call to require plan approval. Each teammate receives a self-contained prompt including:
- Full path to the plan doc
- Scope lock: only files in the phase's touch list
- Explicit forbidden list (see scope lock section below)
- Verification commands to run after each task
- Commit-per-task instruction

Wait for each task to complete before the next. Mark tasks as completed in the TaskList as teammates finish them.

**Step 6 — Verification loop**
BEFORE review, run the verification loop yourself (not via teammate):
```bash
cd ui && npx tsc --noEmit && npx eslint './src/**/*.{ts,tsx}'
cd .. && go build ./... && go vet ./...
```
For Go changes, also run `go test ./...` for any packages touched. If `rpcDoExecuteKeyboardMacro` or related code changed, run the benchmark from #43's plan. All must pass.

If verification fails, STOP, report the failure to the user, and do NOT proceed to review.

**Step 6.5 — Codex cross-review (commits against spec + plan)**
After verification passes, run an independent GPT-5.4 code review of the committed branch via codex. This is code-level, separate from Oracle's spec/plan-level review at Step 4.5, and runs BEFORE the in-house reviewer so Step 7 can synthesize both signals.

Model and effort come from `~/.codex/config.toml` (default: `gpt-5.4`, `model_reasoning_effort = "xhigh"`). Do NOT override unless the user explicitly asks.

**Primary path — native codex review against main:**
```bash
codex exec review --base main --full-auto --skip-git-repo-check \
  --title "Phase <N> cross-review: <short summary>"
```

Codex will diff the branch against main, run tool calls to read changed files, and return structured findings. Capture its verdict.

**Windows fallback (PowerShell 5.1 `&&` chaining issue):** on some Windows hosts, codex's native review mode executes git commands via `WindowsPowerShell\v1.0\powershell.exe` which does not support `&&` as a statement separator. If the native review fails with a PowerShell parser error, switch to the skill path:

```
Invoke Skill: codex:rescue
```

with a self-contained prompt listing the commit SHAs, spec path, plan path, scope constraints, and correctness invariants to check. The `codex:rescue` skill routes through the companion runtime rather than native review and bypasses the `&&` problem.

**`codex:rescue` companion runtime requires the Windows spawn patch:** the companion's `scripts/lib/app-server.mjs` calls `child_process.spawn("codex", ["app-server"])` without `shell: true`, which fails with `spawn codex ENOENT` (or `spawn EINVAL` on Node 18.20.2+) because it cannot resolve Windows `.cmd` npm shims. If the skill fails, check `~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/lib/app-server.mjs:188` — it should read `shell: process.platform === "win32"` on the spawn call. Reapply the patch if it's been clobbered by a plugin update.

**Ultimate fallback** — self-contained direct prompt, no review subcommand, no git tooling:
```bash
codex exec --full-auto "Independent cross-review of branch <branch-name> on WyrmKeep/jetkvm-reliable-paste-private. Commits: <SHA1> <SHA2> ... <SHAN>. Attached context: <spec path>, <plan path>. Scope constraints: <list files that MUST NOT be touched>. Correctness invariants to verify: <list from issue bodies and spec>. Read the commits via git show, the spec and plan from disk, and render an APPROVE / REQUEST CHANGES / BLOCK verdict with file:line citations."
```

**When codex returns:** present to the user:
- Verdict (APPROVE / REQUEST CHANGES / BLOCK)
- Top findings with file:line
- Which path ran (native / skill / direct) and any path-switching that happened

**If codex REQUEST CHANGES:** present findings to the user. If the user wants to act on them, loop back to Step 5, revise, re-verify, re-run Step 6.5. If the user wants to overrule, record the overrule reasoning so Step 7's reviewer can weigh in.

**If codex BLOCKs:** stop, report to user, do not proceed.

**If all three paths fail** (native, skill, direct): record "codex cross-review DEFERRED — <reason>" and proceed to Step 7 with an explicit note in the reviewer dispatch. Do NOT block the phase on codex.

Record codex's final verdict (APPROVE / REQUEST CHANGES / BLOCK / DEFERRED) for inclusion in Step 7 and Step 8.

**Step 7 — In-house code review synthesis**
Spawn a code-reviewer teammate (`subagent_type: superpowers:code-reviewer`) with a self-contained prompt including:
- All commit SHAs from this phase
- The phase's scope constraints ("these files must NOT be touched: ...")
- The key correctness invariants from the issue body (for phase 1: paste-depth, IsPaste preservation, non-paste macros don't toggle paste state; for phase 2: chunk boundaries use required drain mode; etc.)
- **The Oracle cross-review verdict from Step 4.5** — full verdict text, top findings, and whether it ran or was deferred
- **The Codex cross-review verdict from Step 6.5** — full verdict text, top findings, and whether it ran or was deferred
- Explicit synthesis instruction: "Do NOT simply repeat Oracle's and Codex's findings. Read the code independently. Where Oracle flagged a spec-level issue and Codex confirmed it at code level, weight that heavily. Where Oracle and Codex disagree, name the disagreement explicitly and pick a side with reasoning. Where both cross-reviews were deferred, run deeper yourself because you are the only independent signal on this phase."

Wait for the reviewer's verdict. If APPROVE → proceed to Step 8. If REQUEST CHANGES → loop back to Step 5 with the specific feedback, do NOT silently push back.

**Step 8 — PR creation**
Push the branch: `git push -u origin <branch-name>`
Create the PR:
```
gh pr create --title "<type>(scope): <summary> (closes #N)" --body-file <temp-body-file>
```
PR body MUST include:
- Summary (3–5 bullets of what changed)
- Link back to the issue body's acceptance criteria as a checklist, checked off
- Scope-constraints-respected note (e.g., "Flow control untouched. Drain wait untouched. isPasteInProgress subscription untouched." for phase 2)
- Test plan (actual commands run, not aspirational)
- Closes #N for the primary issue and any folded issues
- **Review status section with three sub-items:**
  - Oracle cross-review (Step 4.5): verdict + 1-paragraph summary, or "deferred: <reason>"
  - Codex cross-review (Step 6.5): verdict + 1-paragraph summary, or "deferred: <reason>"
  - In-house review (Step 7): verdict + synthesis summary
- 🤖 Generated with [Claude Code](https://claude.com/claude-code) footer

**Step 9 — Cross-link and close related issues**
After the PR is open (not merged yet), post a comment on each related issue from the phase table:
- Primary issue: will auto-close on merge via `Closes #N`
- Folded issues (e.g., #34 in phase 1 or phase 4): manually close after merge with an explanatory comment linking to the PR
- Downstream blocked issues: post a comment noting the dependency is being addressed so reviewers see sequencing

**Step 10 — Team cleanup**
After the PR is merged (wait for user confirmation — do NOT merge it yourself unless the user explicitly says to):
1. Send `shutdown_request` to every teammate
2. Mark all tasks completed
3. `git checkout main && git pull` to sync
4. Report: which PR merged, which issues auto-closed, which issues need manual close, what phase comes next per the dependency graph
</workflow>

- Branch naming: use the branch name from the phase table exactly
- Commit granularity: one commit per plan task, not one giant commit
- Commit message format: `<type>(<scope>): <description> (#<issue>)` where type is `fix|feat|refactor|perf|docs|test` and scope is `paste|usb|hid|ui|build`
- Co-author footer: every commit ends with `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- Never use `--no-verify` or `--amend` — create a new commit instead
- Never force-push without explicit user approval
- Never merge the PR yourself unless the user explicitly says to — merge is a destructive, user-visible action

Phase 1 forbidden list:
- `ui/src/components/popovers/PasteModal.tsx` — do not touch, user-facing no change
- Anything under `ui/src/utils/pasteBatches.ts` — do not re-retune in this phase
- Anything under `internal/native/` — not related

Phase 2 forbidden list:
- The send loop watermarks (`PASTE_LOW_WATERMARK`, `PASTE_HIGH_WATERMARK`) in `useKeyboard.ts` — untouched, #46's work
- Any backend queue depth changes — that's phase 1's scope
- Any profile tuning — that's phase 3a

Phase 3a forbidden list:
- `ui/src/hooks/useKeyboard.ts` — do not change execution logic; this is a config-only change
- `ui/src/utils/pasteMacro.ts` — only export `estimateBatchBytes` if needed for derivation; do NOT change its formula

Phase 3b forbidden list:
- Anything frontend
- Anything outside `rpcDoExecuteKeyboardMacro` and its direct helpers
- No behavior changes — timer reuse must be behavior-identical

Phase 4 forbidden list:
- Non-paste keyboard event path (single keypresses, button bindings) — must continue using `keyboardWriteHidFile` unchanged
- The 5ms press-hold delay — must be preserved in the new sequence writer (this is the correctness trap flagged in #44's body)
- `listenKeyboardEvents` read side — verify no starvation but do NOT modify

Phase 5 forbidden list:
- Any behavior changes — purely allocation cleanup
- Any change that mutates `step.keys` (the bug being fixed is the existing mutation, don't introduce new ones)
- Test harness setup outside `ui/` — do not add to Go side

Universal forbidden list (all phases):
- Never modify `CLAUDE.md`, `DEVELOPMENT.md`, or `README.md` as part of a phase PR
- Never modify `.github/workflows/` without explicit user approval
- Never modify `go.mod`, `package.json`, or `package-lock.json` without explicit user approval, EXCEPT phase 5 which adds vitest

Stop conditions (halt and ask the user):
- Any predecessor phase is not merged (preflight step 4)
- Verification fails after implementation (workflow step 6)
- Codex cross-review returns BLOCK (workflow step 6.5)
- Code reviewer requests changes more than twice on the same PR (indicates a deeper design problem)
- Tests pass but something feels wrong — do not rationalize, pause and report
- Any forbidden-list file appears in the diff (teammate may have drifted)
- Merge conflicts on rebase against main
- Any HID write or USB gadget change that affects non-paste keyboard events
- Before running `git push --force` for any reason
- Before closing any issue
- Before merging any PR
- Before running the `-i` install deploy to the device

Per-phase acceptance criteria (must hold before PR):
- Phase 1: paste-depth transitions verifiable via log output; non-paste macros do not log `isPasteInProgress` toggles; #48 queue depth is a named constant
- Phase 2: 100k-char paste completes without corruption on a test target; trace output shows chunk boundaries, drain waits, pause timing; cancel works during all three paste phases
- Phase 3a: fast profile produces measurably more steps per batch than reliable in a test; derived constants, not magic numbers; unit or CI test catches regressions
- Phase 3b: allocation count dropped from O(n) to O(1) per macro; behavior identical to before; benchmark included
- Phase 4: press-hold timing preserved (verify via USB capture or controlled test); non-paste path untouched; `KeyboardReport` does not update `KeysDown` on failed write
- Phase 5: decomposed-accent test fixture present; no source mutation in marshal; vitest runs in CI

Ask: "Which phase should I work on? (1, 2, 3a, 3b, 4, or 5)"

When the user answers, execute preflight, then workflow steps 1 through 10 in order. Step 4.5 runs between Step 4 and Step 5; Step 6.5 runs between Step 6 and Step 7. Do not skip steps. Do not batch steps. Mark each task `in_progress` before starting work and `completed` immediately after finishing.

Begin every phase by reading the primary issue with `gh issue view <N>` AND its comments. Do not rely on memory of issue content — issues may have been updated between sessions.
