#!/usr/bin/env bash
#
# launch-wave1.sh — DueProcess Wave 1 parallel agent launcher
# -----------------------------------------------------------------------------
# Spins up one git worktree (locked) per Wave 1 task and one tmux window per
# worktree, then starts a Devin CLI session in each with the right model and an
# auto-generated, self-contained prompt extracted from DEVIN_PROMPTS.md.
#
#   Wave 1 tasks (see DEVIN_PROMPTS.md / SETUP_AND_OPS.md §5):
#     P1-A  corpus + AI Search index   -> kimi-k2.6
#     P1-B  deterministic deadline      -> claude-opus-4-8 (high thinking)
#     P1-C  multimodal extraction       -> claude-opus-4-8 (high thinking)
#     P1-D  python eval harness          -> claude-opus-4-8 (high thinking)
#
# Run from anywhere; paths are resolved relative to this script.
#   ./scripts/launch-wave1.sh
#
# Override knobs (env vars):
#   THINK=high|xhigh|medium       thinking level for the Opus agents (default: high)
#   OPUS_MODEL=...                full model slug override for B/C/D
#   KIMI_MODEL=...                full model slug override for A
#   PERMISSION_MODE=auto|dangerous  Devin tool auto-approval (default: auto)
#   AUTOSTART=true|false          press Enter to start Devin automatically (default: true)
#   LAYOUT=windows|panes          tmux layout (default: windows)
# -----------------------------------------------------------------------------
set -euo pipefail

# ---- configuration ----------------------------------------------------------
SESSION="dueprocess"
BASE_BRANCH="main"
THINK="${THINK:-high}"                                   # high | xhigh | medium
OPUS_MODEL="${OPUS_MODEL:-claude-opus-4-8-${THINK}}"     # B, C, D
KIMI_MODEL="${KIMI_MODEL:-kimi-k2.6}"                    # A
PERMISSION_MODE="${PERMISSION_MODE:-auto}"               # auto | dangerous
AUTOSTART="${AUTOSTART:-true}"
LAYOUT="${LAYOUT:-windows}"                              # windows | panes

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TREES_DIR="$(cd "$REPO_ROOT/.." && pwd)/dp-trees"        # sibling of the repo, per SETUP_AND_OPS §5
PROMPTS_DIR="$REPO_ROOT/.wave1-prompts"                  # generated; gitignored
PROMPTS_SRC="$REPO_ROOT/DEVIN_PROMPTS.md"

# agent rows: label | branch | model | section-id (heading in DEVIN_PROMPTS.md)
AGENTS=(
  "p1a-corpus|p1a-corpus|${KIMI_MODEL}|P1-A"
  "p1b-deadline|p1b-deadline|${OPUS_MODEL}|P1-B"
  "p1c-extraction|p1c-extraction|${OPUS_MODEL}|P1-C"
  "p1d-eval|p1d-eval|${OPUS_MODEL}|P1-D"
)

# ---- pretty output ----------------------------------------------------------
c_blue=$'\033[34m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_red=$'\033[31m'; c_rst=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$c_blue" "$c_rst" "$*"; }
ok()   { printf '%s ok %s %s\n' "$c_grn"  "$c_rst" "$*"; }
warn() { printf '%swarn%s %s\n' "$c_yel" "$c_rst" "$*"; }
die()  { printf '%sERR %s %s\n' "$c_red" "$c_rst" "$*" >&2; exit 1; }

# ---- preflight --------------------------------------------------------------
say "Preflight checks"
for bin in git tmux devin awk; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' not found on PATH."
done
ok "git / tmux / devin / awk present"

[ -f "$PROMPTS_SRC" ] || die "DEVIN_PROMPTS.md not found at $PROMPTS_SRC"

if ! devin auth status 2>&1 | grep -qi "Logged in"; then
  die "Devin CLI is not logged in. Run: devin auth login"
fi
ok "Devin CLI authenticated"

# must be inside the repo, on BASE_BRANCH, with a clean tree (worktrees fork from BASE_BRANCH)
cur_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
[ "$cur_branch" = "$BASE_BRANCH" ] || die "Repo is on '$cur_branch', expected '$BASE_BRANCH'. Switch: git switch $BASE_BRANCH"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  die "Working tree is dirty. Commit P0 to '$BASE_BRANCH' first (worktrees branch off it):
       git add -A && git commit -m 'P0: scaffold + contracts' && git push"
fi
ok "On '$BASE_BRANCH' with a clean working tree"

# best-effort model availability probe (invalid model errors out cheaply, listing the catalog)
AVAIL="$(devin --model __wave1_probe__ -p "probe" 2>&1 || true)"
for m in "claude-opus-4.8" "kimi-k2.6"; do
  if printf '%s' "$AVAIL" | grep -q "$m"; then ok "model catalog has $m"; else
    warn "could not confirm '$m' in the Devin model catalog — verify model names if a pane errors."
  fi
done
say "Models -> A:${c_grn}${KIMI_MODEL}${c_rst}  B/C/D:${c_grn}${OPUS_MODEL}${c_rst}  (permission-mode=${PERMISSION_MODE})"

# refuse to clobber an existing session
if tmux has-session -t "$SESSION" 2>/dev/null; then
  die "tmux session '$SESSION' already exists. Attach (tmux attach -t $SESSION) or kill it (tmux kill-session -t $SESSION)."
fi

# ---- prompt extraction ------------------------------------------------------
mkdir -p "$PROMPTS_DIR" "$TREES_DIR"

extract_guardrails() {
  awk '
    /^Global guardrails/ {cap=1}
    cap && /^====/ {exit}
    cap {print}
  ' "$PROMPTS_SRC"
}

extract_section() {
  local sec="$1"
  awk -v hdr="## ${sec} " '
    index($0, hdr)==1 {cap=1}
    cap && index($0,"## ")==1 && index($0,hdr)!=1 {exit}
    cap && index($0,"====")==1 {exit}
    cap {print}
  ' "$PROMPTS_SRC"
}

build_prompt() {                       # build_prompt <section-id> <branch> <outfile>
  local sec="$1" branch="$2" out="$3"
  {
    echo "You are an autonomous Devin agent in a dedicated git worktree for the DueProcess project."
    echo "Your working directory is a full checkout of branch '${branch}'. CLAUDE.md, SETUP_AND_OPS.md and"
    echo "DEVIN_PROMPTS.md are at the repo root of this worktree."
    echo
    echo "FIRST: read CLAUDE.md (root) completely. It is the single source of truth and overrides your"
    echo "assumptions. Then execute the task below to completion, autonomously."
    echo
    echo "Operating rules for this run:"
    echo "- Edit ONLY the files your task assigns. If you need a shared-file change (types.ts, models.ts,"
    echo "  schema), STOP and ask the human — do not edit it."
    echo "- Make small, conventional commits on THIS branch ('${branch}'). Do NOT switch branches, merge,"
    echo "  rebase, or push unless explicitly asked."
    echo "- Verify external APIs against the pinned docs in CLAUDE.md §9. Never invent identifiers."
    echo "- Relevant agent skills are available (e.g. /workers-best-practices for Workers/wrangler code,"
    echo "  /fastapi-templates for the Python eval). Use them when appropriate."
    echo "- When you hit a STOP-and-ask condition, stop and wait for the human."
    echo
    echo "===== GLOBAL GUARDRAILS ====="
    extract_guardrails
    echo
    echo "===== YOUR TASK (${sec}) ====="
    extract_section "$sec"
  } > "$out"
  [ -s "$out" ] || die "Generated an empty prompt for ${sec} — check the headings in DEVIN_PROMPTS.md."
}

# ---- worktrees (locked) -----------------------------------------------------
make_worktree() {                      # make_worktree <branch> <path>
  local branch="$1" path="$2"
  if git -C "$REPO_ROOT" worktree list --porcelain | grep -qx "worktree $path"; then
    ok "worktree exists: $path"
    return
  fi
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/${branch}"; then
    git -C "$REPO_ROOT" worktree add --lock --reason "wave1 ${branch} agent active" "$path" "$branch" >/dev/null
  else
    git -C "$REPO_ROOT" worktree add --lock --reason "wave1 ${branch} agent active" -b "$branch" "$path" "$BASE_BRANCH" >/dev/null
  fi
  ok "worktree created + locked: $path  (branch ${branch})"
}

# ---- tmux launch ------------------------------------------------------------
devin_cmd() {                          # devin_cmd <model> <promptfile>
  printf "devin --model '%s' --permission-mode '%s' --prompt-file '%s'" "$1" "$PERMISSION_MODE" "$2"
}

send_or_type() {                       # send_or_type <target> <cmd>
  local target="$1" cmd="$2"
  sleep 0.5                            # let the pane's shell finish initialising before typing
  if [ "$AUTOSTART" = "true" ]; then
    tmux send-keys -t "$target" "$cmd" C-m
  else
    tmux send-keys -t "$target" "$cmd"     # leave it typed; user presses Enter
  fi
}

say "Creating worktrees + prompts"
declare -a LABELS BRANCHES MODELS PATHS PROMPTS
for row in "${AGENTS[@]}"; do
  IFS='|' read -r label branch model sec <<<"$row"
  wt="$TREES_DIR/$label"
  pf="$PROMPTS_DIR/$label.md"
  build_prompt "$sec" "$branch" "$pf"
  make_worktree "$branch" "$wt"
  LABELS+=("$label"); BRANCHES+=("$branch"); MODELS+=("$model"); PATHS+=("$wt"); PROMPTS+=("$pf")
done

say "Starting tmux session '$SESSION'"
tmux new-session -d -s "$SESSION" -n "${LABELS[0]}" -c "${PATHS[0]}"
send_or_type "$SESSION:${LABELS[0]}" "$(devin_cmd "${MODELS[0]}" "${PROMPTS[0]}")"

for i in $(seq 1 $(( ${#LABELS[@]} - 1 ))); do
  if [ "$LAYOUT" = "panes" ]; then
    tmux split-window -t "$SESSION:0" -c "${PATHS[$i]}"
    tmux select-layout -t "$SESSION:0" tiled
    send_or_type "$SESSION:0" "$(devin_cmd "${MODELS[$i]}" "${PROMPTS[$i]}")"
  else
    tmux new-window -t "$SESSION" -n "${LABELS[$i]}" -c "${PATHS[$i]}"
    send_or_type "$SESSION:${LABELS[$i]}" "$(devin_cmd "${MODELS[$i]}" "${PROMPTS[$i]}")"
  fi
done

ok "Launched ${#LABELS[@]} agents."
cat <<EOF

${c_grn}Wave 1 is live.${c_rst}
  Attach:        tmux attach -t ${SESSION}
  Switch window: Ctrl-b <number>   |  detach: Ctrl-b d
  Prompts:       ${PROMPTS_DIR}/*.md
  Worktrees:     ${TREES_DIR}/  (locked)

When the whole wave is reviewed + committed on its branch, merge in dependency
order from the main repo, then unlock + remove each worktree:
  git switch ${BASE_BRANCH}
  git merge --no-ff p1b-deadline
  git merge --no-ff p1a-corpus
  git merge --no-ff p1c-extraction
  git merge --no-ff p1d-eval
  for t in p1a-corpus p1b-deadline p1c-extraction p1d-eval; do
    git worktree unlock "${TREES_DIR}/\$t" && git worktree remove "${TREES_DIR}/\$t"
  done
EOF
