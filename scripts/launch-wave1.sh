#!/usr/bin/env bash
#
# launch-wave1.sh — DueProcess Wave 1: open tmux + start a Devin session per task
# -----------------------------------------------------------------------------
# Opens one tmux window per Wave 1 worktree and starts a Devin CLI session in
# each with the right model. It does NOT create worktrees (run
# scripts/setup-worktrees.sh first) and it does NOT inject prompts — each Devin
# session starts empty so YOU paste its P1 prompt from DEVIN_PROMPTS.md by hand.
#
#   Wave 1 tasks  (paste prompts from DEVIN_PROMPTS.md):
#     window p1a-corpus      P1-A  corpus + AI Search index   -> kimi-k2.6
#     window p1b-deadline    P1-B  deterministic deadline      -> claude-opus-4-8-high
#     window p1c-extraction  P1-C  multimodal extraction       -> claude-opus-4-8-high
#     window p1d-eval        P1-D  python eval harness          -> claude-opus-4-8-high
#
# Permission mode is fixed to "auto": Devin auto-approves ONLY read-only tools;
# every command, file write, and commit waits for YOUR approval. (Never dangerous.)
#
#   ./scripts/launch-wave1.sh
#
# Override knobs (env vars):
#   THINK=high|xhigh|medium   thinking level for the Opus agents (default: high)
#   OPUS_MODEL=...            full model slug override for B/C/D
#   KIMI_MODEL=...            full model slug override for A
#   AUTOSTART=true|false      auto-press Enter to launch Devin in each pane (default: true)
#   LAYOUT=windows|panes      tmux layout (default: windows)
# -----------------------------------------------------------------------------
set -euo pipefail

# ---- configuration ----------------------------------------------------------
SESSION="dueprocess"
THINK="${THINK:-high}"                                   # high | xhigh | medium
OPUS_MODEL="${OPUS_MODEL:-claude-opus-4-8-${THINK}}"     # B, C, D
KIMI_MODEL="${KIMI_MODEL:-kimi-k2.6}"                    # A
PERMISSION_MODE="auto"                                   # fixed: you approve commands/writes
AUTOSTART="${AUTOSTART:-true}"
LAYOUT="${LAYOUT:-windows}"                              # windows | panes

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TREES_DIR="$(cd "$REPO_ROOT/.." && pwd)/dp-trees"        # sibling of the repo, per SETUP_AND_OPS §5

# agent rows: label | model | section-id (the heading to paste from DEVIN_PROMPTS.md)
AGENTS=(
  "p1a-corpus|${KIMI_MODEL}|P1-A"
  "p1b-deadline|${OPUS_MODEL}|P1-B"
  "p1c-extraction|${OPUS_MODEL}|P1-C"
  "p1d-eval|${OPUS_MODEL}|P1-D"
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

# worktrees must already exist (created + locked by scripts/setup-worktrees.sh)
for row in "${AGENTS[@]}"; do
  IFS='|' read -r label _model _sec <<<"$row"
  [ -d "$TREES_DIR/$label" ] || die "missing worktree: $TREES_DIR/$label
       Run the worktree step first:  ./scripts/setup-worktrees.sh"
done
ok "all 4 worktrees present under $TREES_DIR"

# best-effort model availability probe (an invalid model errors out cheaply, listing the catalog)
AVAIL="$(devin --model __wave1_probe__ -p "probe" 2>&1 || true)"
for m in "claude-opus-4.8" "kimi-k2.6"; do
  if printf '%s' "$AVAIL" | grep -q "$m"; then ok "model catalog has $m"; else
    warn "could not confirm '$m' in the Devin model catalog — verify model names if a pane errors."
  fi
done
say "Models -> A:${c_grn}${KIMI_MODEL}${c_rst}  B/C/D:${c_grn}${OPUS_MODEL}${c_rst}  (permission-mode=${PERMISSION_MODE}; you approve every command/write)"

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
tmux new-session -d -s "$SESSION" -n "${LABELS[0]}" -c "${PATHS[0]}"
send_or_type "$SESSION:${LABELS[0]}" "$(devin_cmd "${MODELS[0]}")"

for i in $(seq 1 $(( ${#LABELS[@]} - 1 ))); do
  if [ "$LAYOUT" = "panes" ]; then
    tmux split-window -t "$SESSION:0" -c "${PATHS[$i]}"
    tmux select-layout -t "$SESSION:0" tiled
    send_or_type "$SESSION:0" "$(devin_cmd "${MODELS[$i]}")"
  else
    tmux new-window -t "$SESSION" -n "${LABELS[$i]}" -c "${PATHS[$i]}"
    send_or_type "$SESSION:${LABELS[$i]}" "$(devin_cmd "${MODELS[$i]}")"
  fi
done

ok "Started ${#LABELS[@]} Devin sessions. Now paste each P1 prompt by hand."
cat <<EOF

${c_grn}Wave 1 sessions are up.${c_rst}
  Attach:        tmux attach -t ${SESSION}
  Switch window: Ctrl-b <number>   |  detach: Ctrl-b d

Paste the matching block from DEVIN_PROMPTS.md into each window:
  window 'p1a-corpus'      <- the "## P1-A" block   (model: ${KIMI_MODEL})
  window 'p1b-deadline'    <- the "## P1-B" block   (model: ${OPUS_MODEL})
  window 'p1c-extraction'  <- the "## P1-C" block   (model: ${OPUS_MODEL})
  window 'p1d-eval'        <- the "## P1-D" block   (model: ${OPUS_MODEL})
(also paste the "Global guardrails" block with each — it is load-bearing.)

When the whole wave is reviewed + committed on its branch, merge in dependency
order from the main repo, then unlock + remove each worktree:
  git switch main
  git merge --no-ff p1b-deadline
  git merge --no-ff p1a-corpus
  git merge --no-ff p1c-extraction
  git merge --no-ff p1d-eval
  for t in p1a-corpus p1b-deadline p1c-extraction p1d-eval; do
    git worktree unlock "${TREES_DIR}/\$t" && git worktree remove "${TREES_DIR}/\$t"
  done
EOF
