# 仕様違反検出 rubric (core / 言語不受)

spec-grader が使う。仕様違反は diff の品質問題ではなく **contract breach** として扱う。
各項目は `docs/specs/<feature>.md` の Must / Non-goals と突き合わせ、証拠に紐付ける。

| 判定項目 | チェック内容 | 必要証拠 |
|---|---|---|
| Must 達成 | spec の Must が全て満たされたか | acceptance checklist / 該当テスト結果 |
| Non-goal 順守 | 指定外の変更・不要 refactor・将来用抽象化を入れていないか | diff summary / changed files review |
| API 互換 | API shape / schema / イベント契約を無断変更していないか | contract test / schema diff |
| mock 禁止 | test 以外で mock/stub/fake/dummy/spy を導入していないか | AST/grep gate |
| 依存制約 | 未承認 dependency を追加していないか | lockfile diff / dependency policy |
| 文書整合 | 仕様・docs・設定手順が更新されているか | docs diff / runbook diff |
| 証拠品質 | 成功主張が tool result / runtime-verify と一致するか | logs / trace / exit code / screenshots |
| 可逆性/安全性 | destructive change が approval なしで入っていないか | migration plan / review decision |

## 判定原則
- Must 未達 / Non-goal 侵犯 / 契約破壊は **FAIL**。
- 証拠が不十分なら PASS ではなく **FAIL ("missing evidence")**。
- 指摘は spec の Must 番号・コードパス・artifact に紐付ける (抽象的懸念だけで判定しない)。
- 「モック禁止」は仕様違反 rubric・静的 gate・review guideline に **重複登録** されている (冗長配置が正解)。
