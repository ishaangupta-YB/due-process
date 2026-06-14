#!/usr/bin/env bash
#
# launch-wave2.sh — DueProcess Wave 2: open tmux + start a Devin session per task
# -----------------------------------------------------------------------------
# Opens ONE tmux window split into one labeled pane per Wave 2 worktree (LAYOUT=panes,
# the default) and starts a Devin CLI session in each pane with the right model. It
# does NOT create worktrees (run scripts/setup-worktrees-wave2.sh first) and it does
# NOT inject prompts — each Devin session starts empty so YOU paste its P2 prompt.
#
#   Wave 2 tasks  (paste prompts from DEVIN_PROMPTS.md):
#     pane p2e-grounding     P2-E  grounded answer + abstention  -> opus (xhigh)
#     pane p2f-documents     P2-F  UD-105 draft -> PDF -> R2      -> opus (high)
#     pane p2g-persistence   P2-G  D1 + Durable Object + mem0     -> opus (high)
#
# P2-E (cite-or-abstain) is the safety heart, so it gets the highest thinking.
#
# Permission mode is fixed to "auto": Devin auto-approves ONLY read-only tools;
# every command, file write, and commit waits for YOUR approval. (Never dangerous.)
#
#   ./scripts/launch-wave2.sh
#
# Override knobs (env vars):
#   THINK=high|xhigh|medium    thinking level for P2-F/P2-G (default: high)
#   THINK_E=high|xhigh|medium  thinking level for P2-E      (default: xhigh)
#   OPUS_MODEL=...             full model slug override for F/G
#   OPUS_E_MODEL=...           full model slug override for E
#   AUTOSTART=true|false       auto-press Enter to launch Devin in each pane (default: true)
#   LAYOUT=panes|windows       tmux layout (default: panes = one window, split panes)
# -----------------------------------------------------------------------------
set -euo pipefail

# ---- configuration ----------------------------------------------------------
SESSION="dueprocess-w2"
THINK="${THINK:-high}"                                     # F, G
THINK_E="${THINK_E:-xhigh}"                                # E (safety heart)
OPUS_MODEL="${OPUS_MODEL:-claude-opus-4-8-${THINK}}"       # F, G
OPUS_E_MODEL="${OPUS_E_MODEL:-claude-opus-4-8-${THINK_E}}" # E
PERMISSION_MODE="auto"                                     # fixed: you approve commands/writes
AUTOSTART="${AUTOSTART:-true}"
LAYOUT="${LAYOUT:-panes}"                                  # panes (one window) | windows

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TREES_DIR="$(cd "$REPO_ROOT/.." && pwd)/dp-trees"          # sibling of the repo, per SETUP_AND_OPS §5

# agent rows: label | model | section-id (the heading to paste from DEVIN_PROMPTS.md)
AGENTS=(
  "p2e-grounding|${OPUS_E_MODEL}|P2-E"
  "p2f-documents|${OPUS_MODEL}|P2-F"
  "p2g-persistence|${OPUS_MODEL}|P2-G"
)

# ---- pretty output ----------------------------------------------------------
c_blue=$'\033[34m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_red=$'\033[31m'; c_rst=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$c_blue" "$c_rst" "$*"; }
ok()   { printf '%s ok %s %s\n' "$c_grn"  "$c_rst" "$*"; }
warn() { printf '%swarn%s %s\n' "$c_yel" "$c_rst" "$*"; }
die()  { printf '%sERR %s %s\n' "$c_red" "$c_rst" "$*" >&2; exit 1; }

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

# worktrees must already exist (created + locked by scripts/setup-worktrees-wave2.sh)
for row in "${AGENTS[@]}"; do
  IFS='|' read -r label _model _sec <<<"$row"
  [ -d "$TREES_DIR/$label" ] || die "missing worktree: $TREES_DIR/$label
       Run the worktree step first:  ./scripts/setup-worktrees-wave2.sh"
done
ok "all 3 worktrees present under $TREES_DIR"

# best-effort model availability probe (an invalid model errors out cheaply, listing the catalog)
AVAIL="$(devin --model __wave2_probe__ -p "probe" 2>&1 || true)"
if printf '%s' "$AVAIL" | grep -q "claude-opus-4.8"; then ok "model catalog has claude-opus-4.8"; else
  warn "could not confirm 'claude-opus-4.8' in the Devin model catalog — verify model names if a pane errors."
fi
say "Models -> E:${c_grn}${OPUS_E_MODEL}${c_rst}  F/G:${c_grn}${OPUS_MODEL}${c_rst}  (permission-mode=${PERMISSION_MODE}; you approve every command/write)"

# refuse to clobber an existing session
if tmux has-session -t "$SESSION" 2>/dev/null; then
  die "tmux session '$SESSION' already exists. Attach (tmux attach -t $SESSION) or kill it (tmux kill-session -t $SESSION)."
fi

# ---- tmux launch ------------------------------------------------------------
devin_cmd() {                          # devin_cmd <model>
  printf "devin --model '%s' --permission-mode '%s'" "$1" "$PERMISSION_MODE"
}

send_or_type() {                       # send_or_type <target> <cmd>
  local target="$1" cmd="$2"
  sleep 0.5                            # let the pane's shell finish initialising before typing
  if [ "$AUTOSTART" = "true" ]; then
    tmux send-keys -t "$target" "$cmd" C-m
  else
    tmux send-keys -t "$target" "$cmd"     # leave it typed; you press Enter
  fi
}

declare -a LABELS MODELS SECTIONS PATHS
for row in "${AGENTS[@]}"; do
  IFS='|' read -r label model sec <<<"$row"
  LABELS+=("$label"); MODELS+=("$model"); SECTIONS+=("$sec"); PATHS+=("$TREES_DIR/$label")
done

say "Starting tmux session '$SESSION' (layout=$LAYOUT)"

if [ "$LAYOUT" = "panes" ]; then
  # ONE window ('wave2'); one pane per agent, tiled. Each pane border is labeled so
  # you can tell which agent is which when you paste prompts. Pane ids are captured
  # explicitly so send-keys always targets the right pane regardless of layout.
  tmux new-session -d -s "$SESSION" -n "wave2" -c "${PATHS[0]}"
  tmux set-option -w -t "$SESSION:wave2" pane-border-status top 2>/dev/null || true
  tmux set-option -w -t "$SESSION:wave2" pane-border-format " #{pane_index}: #{pane_title} " 2>/dev/null || true

  first_pane="$(tmux display-message -p -t "$SESSION:wave2" '#{pane_id}')"
  tmux select-pane -t "$first_pane" -T "${LABELS[0]} -> ${MODELS[0]}"
  send_or_type "$first_pane" "$(devin_cmd "${MODELS[0]}")"

  for i in $(seq 1 $(( ${#LABELS[@]} - 1 ))); do
    pane_id="$(tmux split-window -t "$SESSION:wave2" -c "${PATHS[$i]}" -P -F '#{pane_id}')"
    tmux select-layout -t "$SESSION:wave2" tiled >/dev/null
    tmux select-pane -t "$pane_id" -T "${LABELS[$i]} -> ${MODELS[$i]}"
    send_or_type "$pane_id" "$(devin_cmd "${MODELS[$i]}")"
  done
  tmux select-pane -t "$first_pane"   # focus the first agent
else
  # one window per agent
  tmux new-session -d -s "$SESSION" -n "${LABELS[0]}" -c "${PATHS[0]}"
  send_or_type "$SESSION:${LABELS[0]}" "$(devin_cmd "${MODELS[0]}")"
  for i in $(seq 1 $(( ${#LABELS[@]} - 1 ))); do
    tmux new-window -t "$SESSION" -n "${LABELS[$i]}" -c "${PATHS[$i]}"
    send_or_type "$SESSION:${LABELS[$i]}" "$(devin_cmd "${MODELS[$i]}")"
  done
fi

ok "Started ${#LABELS[@]} Devin sessions. Now paste each P2 prompt by hand."
cat <<EOF

${c_grn}Wave 2 sessions are up.${c_rst}
  Attach:        tmux attach -t ${SESSION}
  Move panes:    Ctrl-b o (cycle)  |  Ctrl-b <arrow>  |  zoom/unzoom a pane: Ctrl-b z
  Detach:        Ctrl-b d   |   kill it all: tmux kill-session -t ${SESSION}

Each pane runs one agent (the pane border is labeled). Paste the matching block
from DEVIN_PROMPTS.md into each pane (zoom with Ctrl-b z first if it's cramped):
  pane 'p2e-grounding'    <- the "## P2-E" block   (model: ${OPUS_E_MODEL})
  pane 'p2f-documents'    <- the "## P2-F" block   (model: ${OPUS_MODEL})
  pane 'p2g-persistence'  <- the "## P2-G" block   (model: ${OPUS_MODEL})
(also paste the "Global guardrails" block with each — it is load-bearing.)

Deps note: pdf-lib (P2-F) is already in apps/web/package.json — use it; add no new
deps. P2-G must use the mem0 platform REST API via fetch (NOT the mem0ai SDK — it
pulls native better-sqlite3 that won't run on Workers). If an agent must add a dep,
regenerate pnpm-lock.yaml via 'pnpm install' at merge, don't hand-resolve it.

When the whole wave is reviewed + committed on its branch, merge from the main repo,
then unlock + remove each worktree:
  git switch main
  git merge --no-ff p2g-persistence
  git merge --no-ff p2e-grounding
  git merge --no-ff p2f-documents
  for t in p2e-grounding p2f-documents p2g-persistence; do
    git worktree unlock "${TREES_DIR}/\$t" && git worktree remove "${TREES_DIR}/\$t"
  done
EOF
