#!/usr/bin/env bash
#
# setup-worktrees.sh — DueProcess Wave 1: create + LOCK one git worktree per task
# -----------------------------------------------------------------------------
# Run this ONCE, from the repo on `main`, AFTER P0 is committed and BEFORE you
# launch the agents (scripts/launch-wave1.sh). It implements SETUP_AND_OPS.md §5:
# one worktree per task, each on its own branch off `main`, so parallel agents
# never share a working directory. Each worktree is git-locked so a stray
# `git worktree prune` / `gc` / `remove` can't drop an agent's in-flight work.
#
#   ./scripts/setup-worktrees.sh
#
# Idempotent: re-running skips worktrees that already exist.
# Cleanup after the wave is merged:
#   git worktree unlock ../dp-trees/<t> && git worktree remove ../dp-trees/<t>
# -----------------------------------------------------------------------------
set -euo pipefail

BASE_BRANCH="main"
BRANCHES=(p1a-corpus p1b-deadline p1c-extraction p1d-eval)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TREES_DIR="$(cd "$REPO_ROOT/.." && pwd)/dp-trees"   # sibling of the repo, per SETUP_AND_OPS §5

c_blue=$'\033[34m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_red=$'\033[31m'; c_rst=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$c_blue" "$c_rst" "$*"; }
ok()   { printf '%s ok %s %s\n' "$c_grn"  "$c_rst" "$*"; }
warn() { printf '%swarn%s %s\n' "$c_yel" "$c_rst" "$*"; }
die()  { printf '%sERR %s %s\n' "$c_red" "$c_rst" "$*" >&2; exit 1; }

# ---- preflight: worktrees fork from a clean, committed `main` ----------------
say "Preflight"
command -v git >/dev/null 2>&1 || die "git not found on PATH."
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $REPO_ROOT"

cur_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
[ "$cur_branch" = "$BASE_BRANCH" ] || die "Repo is on '$cur_branch'; switch first: git switch $BASE_BRANCH"

if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  die "Working tree is dirty. Commit P0 to '$BASE_BRANCH' first (worktrees branch off it):
       git add -A && git commit -m 'P0: scaffold + contracts'"
fi
ok "on '$BASE_BRANCH' with a clean working tree"
mkdir -p "$TREES_DIR"

# ---- create + lock each worktree --------------------------------------------
say "Creating worktrees under $TREES_DIR"
for branch in "${BRANCHES[@]}"; do
  path="$TREES_DIR/$branch"
  if git -C "$REPO_ROOT" worktree list --porcelain | grep -qx "worktree $path"; then
    ok "exists, skipping: $path"
    continue
  fi
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$REPO_ROOT" worktree add --lock --reason "wave1 $branch agent active" "$path" "$branch" >/dev/null
  else
    git -C "$REPO_ROOT" worktree add --lock --reason "wave1 $branch agent active" -b "$branch" "$path" "$BASE_BRANCH" >/dev/null
  fi
  ok "created + locked: $path  (branch $branch)"
done

echo
say "Current worktrees:"
git -C "$REPO_ROOT" worktree list
echo
ok "Done. Next: ./scripts/launch-wave1.sh   (then paste each P1 prompt into its pane)"
