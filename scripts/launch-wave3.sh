#!/usr/bin/env bash
#
# launch-wave3.sh — DueProcess Wave 3: open tmux + start a Devin session per task
# -----------------------------------------------------------------------------
# Opens ONE tmux window split into one labeled pane per requested Wave 3 worktree
# (LAYOUT=panes, the default) and starts a Devin CLI session in each pane. It does
# NOT create worktrees (run scripts/setup-worktrees-wave3.sh first) and it does NOT
# inject prompts — each Devin session starts empty so YOU paste its P3 prompt.
#
# Wave 3 is PHASED (DEVIN_PROMPTS.md): P3-H first, then P3-I + P3-J after H merges.
#   Phase 1 (now):              ./scripts/launch-wave3.sh
#                               (defaults to just p3h-frontend)
#   Phase 2 (after P3-H lands): ./scripts/launch-wave3.sh p3i-enhancements p3j-eval-readme
#
#   p3h-frontend     P3-H  the demo flow (app/ UI)                 -> opus (high)  [first]
#   p3i-enhancements P3-I  Composio + voice/multilingual (cuttable)-> opus (high)  [after H]
#   p3j-eval-readme  P3-J  e2e + eval + README/DEVPOST (last)       -> opus (high)  [after H]
#
# Permission mode is fixed to "auto": Devin auto-approves ONLY read-only tools;
# every command, file write, and commit waits for YOUR approval. (Never dangerous.)
#
# Override knobs (env vars):
#   THINK=high|xhigh|medium   thinking level for all panes (default: high)
#   OPUS_MODEL=...            full model slug override
#   AUTOSTART=true|false      auto-press Enter to launch Devin in each pane (default: true)
#   LAYOUT=panes|windows      tmux layout (default: panes = one window, split panes)
# -----------------------------------------------------------------------------
set -euo pipefail

# ---- configuration ----------------------------------------------------------
SESSION="dueprocess-w3"
THINK="${THINK:-high}"
OPUS_MODEL="${OPUS_MODEL:-claude-opus-4-8-${THINK}}"
PERMISSION_MODE="auto"
AUTOSTART="${AUTOSTART:-true}"
LAYOUT="${LAYOUT:-panes}"

ALL_BRANCHES=(p3h-frontend p3i-enhancements p3j-eval-readme)
# Default to ONLY the frontend — P3-I/P3-J start in phase 2, after P3-H merges.
BRANCHES=("${@:-p3h-frontend}")

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TREES_DIR="$(cd "$REPO_ROOT/.." && pwd)/dp-trees"

# branch -> prompt section (the heading to paste from DEVIN_PROMPTS.md)
section_for() {
  case "$1" in
    p3h-frontend)     echo "P3-H" ;;
    p3i-enhancements) echo "P3-I" ;;
    p3j-eval-readme)  echo "P3-J" ;;
    *) echo "??" ;;
  esac
}

# ---- pretty output ----------------------------------------------------------
c_blue=$'\033[34m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_red=$'\033[31m'; c_rst=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$c_blue" "$c_rst" "$*"; }
ok()   { printf '%s ok %s %s\n' "$c_grn"  "$c_rst" "$*"; }
warn() { printf '%swarn%s %s\n' "$c_yel" "$c_rst" "$*"; }
die()  { printf '%sERR %s %s\n' "$c_red" "$c_rst" "$*" >&2; exit 1; }

is_valid_branch() { local b="$1"; for v in "${ALL_BRANCHES[@]}"; do [ "$b" = "$v" ] && return 0; done; return 1; }

# ---- preflight --------------------------------------------------------------
say "Preflight checks"
for bin in git tmux devin; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' not found on PATH."
done
ok "git / tmux / devin present"

if ! devin auth status 2>&1 | grep -qi "Logged in"; then
  die "Devin CLI is not logged in. Run: devin auth login"
fi
ok "Devin CLI authenticated"

for b in "${BRANCHES[@]}"; do
  is_valid_branch "$b" || die "unknown branch '$b'. Valid: ${ALL_BRANCHES[*]}"
  [ -d "$TREES_DIR/$b" ] || die "missing worktree: $TREES_DIR/$b
       Run the worktree step first:  ./scripts/setup-worktrees-wave3.sh ${BRANCHES[*]}"
done
ok "requested worktrees present under $TREES_DIR: ${BRANCHES[*]}"

# best-effort model availability probe (an invalid model errors cheaply, listing the catalog)
AVAIL="$(devin --model __wave3_probe__ -p "probe" 2>&1 || true)"
if printf '%s' "$AVAIL" | grep -q "claude-opus-4.8"; then ok "model catalog has claude-opus-4.8"; else
  warn "could not confirm 'claude-opus-4.8' in the Devin model catalog — verify model names if a pane errors."
fi
say "Model -> ${c_grn}${OPUS_MODEL}${c_rst}  (permission-mode=${PERMISSION_MODE}; you approve every command/write)"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  die "tmux session '$SESSION' already exists. Attach (tmux attach -t $SESSION) or kill it (tmux kill-session -t $SESSION)."
fi

# ---- build per-pane arrays --------------------------------------------------
declare -a LABELS MODELS SECTIONS PATHS
for b in "${BRANCHES[@]}"; do
  LABELS+=("$b"); MODELS+=("$OPUS_MODEL"); SECTIONS+=("$(section_for "$b")"); PATHS+=("$TREES_DIR/$b")
done

# ---- tmux launch ------------------------------------------------------------
devin_cmd() { printf "devin --model '%s' --permission-mode '%s'" "$1" "$PERMISSION_MODE"; }

send_or_type() {                       # send_or_type <target> <cmd>
  local target="$1" cmd="$2"
  sleep 0.5
  if [ "$AUTOSTART" = "true" ]; then
    tmux send-keys -t "$target" "$cmd" C-m
  else
    tmux send-keys -t "$target" "$cmd"
  fi
}

say "Starting tmux session '$SESSION' (layout=$LAYOUT)"

if [ "$LAYOUT" = "panes" ]; then
  tmux new-session -d -s "$SESSION" -n "wave3" -c "${PATHS[0]}"
  tmux set-option -w -t "$SESSION:wave3" pane-border-status top 2>/dev/null || true
  tmux set-option -w -t "$SESSION:wave3" pane-border-format " #{pane_index}: #{pane_title} " 2>/dev/null || true

  first_pane="$(tmux display-message -p -t "$SESSION:wave3" '#{pane_id}')"
  tmux select-pane -t "$first_pane" -T "${LABELS[0]} -> ${MODELS[0]}"
  send_or_type "$first_pane" "$(devin_cmd "${MODELS[0]}")"

  for i in $(seq 1 $(( ${#LABELS[@]} - 1 ))); do
    pane_id="$(tmux split-window -t "$SESSION:wave3" -c "${PATHS[$i]}" -P -F '#{pane_id}')"
    tmux select-layout -t "$SESSION:wave3" tiled >/dev/null
    tmux select-pane -t "$pane_id" -T "${LABELS[$i]} -> ${MODELS[$i]}"
    send_or_type "$pane_id" "$(devin_cmd "${MODELS[$i]}")"
  done
  tmux select-pane -t "$first_pane"
else
  tmux new-session -d -s "$SESSION" -n "${LABELS[0]}" -c "${PATHS[0]}"
  send_or_type "$SESSION:${LABELS[0]}" "$(devin_cmd "${MODELS[0]}")"
  for i in $(seq 1 $(( ${#LABELS[@]} - 1 ))); do
    tmux new-window -t "$SESSION" -n "${LABELS[$i]}" -c "${PATHS[$i]}"
    send_or_type "$SESSION:${LABELS[$i]}" "$(devin_cmd "${MODELS[$i]}")"
  done
fi

ok "Started ${#LABELS[@]} Devin session(s). Now paste each P3 prompt by hand."
cat <<EOF

${c_grn}Wave 3 session is up.${c_rst}
  Attach:        tmux attach -t ${SESSION}
  Move panes:    Ctrl-b o (cycle)  |  Ctrl-b <arrow>  |  zoom/unzoom a pane: Ctrl-b z
  Detach:        Ctrl-b d   |   kill it all: tmux kill-session -t ${SESSION}

Each pane runs one agent (the pane border is labeled). Paste the matching block
from DEVIN_PROMPTS.md into each pane (zoom with Ctrl-b z first if it's cramped),
plus the "Global guardrails" block (load-bearing):
EOF
for i in $(seq 0 $(( ${#LABELS[@]} - 1 ))); do
  printf "  pane '%s'  <- the \"## %s\" block   (model: %s)\n" "${LABELS[$i]}" "${SECTIONS[$i]}" "${MODELS[$i]}"
done
cat <<EOF

Phasing: P3-H is the demo path and runs first. Start P3-I + P3-J only AFTER P3-H is
merged + pushed, off the updated main:
  git switch main && git pull
  ./scripts/setup-worktrees-wave3.sh p3i-enhancements p3j-eval-readme
  ./scripts/launch-wave3.sh         p3i-enhancements p3j-eval-readme

When a task is reviewed + committed on its branch, merge from the main repo, then
unlock + remove its worktree:
  git switch main
  git merge --no-ff <branch> -m "merge <branch>"
  git worktree remove --force ${TREES_DIR}/<branch> && git branch -d <branch>
EOF
