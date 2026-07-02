#!/usr/bin/env bash
# KIT_VERSION: 1.1.0
# agent-policy: Stop hook 証跡完了ゲート。
# proven-done 実行中マーカー (.agent-evidence/.active) がある時だけ発火し、
# 完了報告に必要な証跡が揃っていなければ exit 2 で停止をブロックする。
# マーカーが無い通常セッションでは完全な no-op (他作業を妨げない)。
set -uo pipefail

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
marker="$repository_root/.agent-evidence/.active"

# マーカー無し → 関与しない
[ -f "$marker" ] || exit 0

cat >/dev/null 2>&1 || true   # stdin payload は読み捨て

evidence_dir="$repository_root/.agent-evidence"
missing=""
for req in completion-report.md commands.txt wiring-map.json; do
  if [ ! -s "$evidence_dir/$req" ]; then
    missing="${missing} $req"
  fi
done

if [ -n "$missing" ]; then
  {
    echo "完了報告をブロックしました (agent-policy 証跡ゲート)。"
    echo "proven-done 実行中ですが、以下の証跡が未提出/空です:${missing}"
    echo ""
    echo "agent-policy 正本 §3 に従い、.agent-evidence/ に次を用意してから完了してください:"
    echo "  - completion-report.md (changed files / entrypoints / commands / artifacts / wiring map / risks)"
    echo "  - commands.txt         (実行した build/test/lint コマンドと結果)"
    echo "  - wiring-map.json      (変更シンボルと結線点の対応)"
    echo ""
    echo "proven-done を実行していないのにこれが出る場合は、古いマーカーが残っています。"
    echo "次で解除してください: rm '$marker'"
  } >&2
  exit 2
fi

exit 0
