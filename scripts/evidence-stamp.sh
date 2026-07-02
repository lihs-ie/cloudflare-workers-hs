#!/usr/bin/env bash
# KIT_VERSION: 1.1.0
# agent-policy: 現在の git ツリー状態を決定論的な JSON stamp として出力する。
# verify-evidence-freshness.sh がこのスクリプトを呼び出して「現在のツリー状態」を得る
# (sha256 計算ロジックを二重実装しない — 呼び出し元は本スクリプトの stdout をそのまま比較に使う)。
# verifier agent (static-verifier/runtime-verifier/spec-grader/done-evaluator) は判定 JSON の
# `tree_stamp` フィールドにこの出力をそのまま埋め込む。
#
# 出力: 1 行 JSON。キーはこの 2 つのみ、値は string:
#   {"git_sha": "<git rev-parse HEAD>", "dirty_diff_hash": "<sha256(git diff HEAD の出力 + git status --porcelain の出力)>"}
#
# 使い方: evidence-stamp.sh
set -euo pipefail

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root"

sha256_of_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

git_sha="$(git rev-parse HEAD 2>/dev/null || echo "")"
dirty_diff_hash="$(
  {
    git diff HEAD 2>/dev/null || true
    git status --porcelain 2>/dev/null || true
  } | sha256_of_stdin
)"

printf '{"git_sha": "%s", "dirty_diff_hash": "%s"}\n' "$git_sha" "$dirty_diff_hash"
