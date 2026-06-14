#!/usr/bin/env bash
#
# setup-worktrees-wave3.sh — DueProcess Wave 3: create + LOCK git worktrees per task
# -----------------------------------------------------------------------------
# Wave 3 is NOT fully parallel (DEVIN_PROMPTS.md): P3-H (the demo path) runs FIRST,
# then P3-I + P3-J start AFTER P3-H is merged — so they branch off a main that already
# contains the finished UI. Run this in TWO phases, always from a clean `main`:
#
#   Phase 1 (now):              ./scripts/setup-worktrees-wave3.sh
#                               (defaults to just p3h-frontend)
#   Phase 2 (after P3-H lands): git switch main && git pull
#                               ./scripts/setup-worktrees-wave3.sh p3i-enhancements p3j-eval-readme
#
# Wave 3 tasks (paste prompts from DEVIN_PROMPTS.md):
#   p3h-frontend     P3-H  the demo flow (app/ UI, wires existing routes)   [run first]
#   p3i-enhancements P3-I  Composio actions + voice/multilingual (cuttable) [after H]
#   p3j-eval-readme  P3-J  e2e pass + eval run + README/DEVPOST (last)       [after H]
#
# Idempotent: re-running skips worktrees that already exist.
# Cleanup once merged:
#   git worktree remove --force ../dp-trees/<t> && git branch -d <t>
# -----------------------------------------------------------------------------
set -euo pipefail

BASE_BRANCH="main"
ALL_BRANCHES=(p3h-frontend p3i-enhancements p3j-eval-readme)
# Default to ONLY the frontend — P3-H must merge before I/J are branched off main.
BRANCHES=("${@:-p3h-frontend}")

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TREES_DIR="$(cd "$REPO_ROOT/.." && pwd)/dp-trees"   # sibling of the repo, per SETUP_AND_OPS §5

c_blue=$'\033[34m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_red=$'\033[31m'; c_rst=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$c_blue" "$c_rst" "$*"; }
ok()   { printf '%s ok %s %s\n' "$c_grn"  "$c_rst" "$*"; }
warn() { printf '%swarn%s %s\n' "$c_yel" "$c_rst" "$*"; }
die()  { printf '%sERR %s %s\n' "$c_red" "$c_rst" "$*" >&2; exit 1; }

is_valid_branch() { local b="$1"; for v in "${ALL_BRANCHES[@]}"; do [ "$b" = "$v" ] && return 0; done; return 1; }

# ---- preflight --------------------------------------------------------------
say "Preflight"
command -v git >/dev/null 2>&1 || die "git not found on PATH."
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $REPO_ROOT"

for b in "${BRANCHES[@]}"; do
  is_valid_branch "$b" || die "unknown branch '$b'. Valid: ${ALL_BRANCHES[*]}"
done

cur_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
[ "$cur_branch" = "$BASE_BRANCH" ] || die "Repo is on '$cur_branch'; switch first: git switch $BASE_BRANCH"

if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  die "Working tree is dirty. Commit/stash everything on '$BASE_BRANCH' first
       (Wave 3 worktrees branch off it, so it must include the merged earlier waves)."
fi
ok "on '$BASE_BRANCH' with a clean working tree"

# Warn if branching I/J while P3-H is not yet in main (the dependency these tasks need).
for b in "${BRANCHES[@]}"; do
  if [ "$b" != "p3h-frontend" ] && ! git -C "$REPO_ROOT" merge-base --is-ancestor p3h-frontend "$BASE_BRANCH" 2>/dev/null; then
    warn "$b depends on P3-H, but 'p3h-frontend' is not merged into '$BASE_BRANCH' yet. Continue only if you mean to."
  fi
done

mkdir -p "$TREES_DIR"

# ---- create + lock each worktree --------------------------------------------
say "Creating worktrees under $TREES_DIR for: ${BRANCHES[*]}"
for branch in "${BRANCHES[@]}"; do
  path="$TREES_DIR/$branch"
  if git -C "$REPO_ROOT" worktree list --porcelain | grep -qx "worktree $path"; then
    ok "exists, skipping: $path"
    continue
  fi
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$REPO_ROOT" worktree add --lock --reason "wave3 $branch agent active" "$path" "$branch" >/dev/null
  else
    git -C "$REPO_ROOT" worktree add --lock --reason "wave3 $branch agent active" -b "$branch" "$path" "$BASE_BRANCH" >/dev/null
  fi
  ok "created + locked: $path  (branch $branch)"
done

echo
say "Current worktrees:"
git -C "$REPO_ROOT" worktree list
echo
ok "Done. Next: ./scripts/launch-wave3.sh ${BRANCHES[*]}   (then paste each P3 prompt into its pane)"
