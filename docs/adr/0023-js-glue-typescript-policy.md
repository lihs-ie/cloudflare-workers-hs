# ADR-0023: JS glue 層は TypeScript 化し、wasmExports 境界型は API-LEDGER manifest から生成する

- ステータス: 承認（A7b 実装済み・全ゲート EXIT 0 [host trio: build/lint/typecheck + wasm pair: test-integration 204+1skip / wasm-exports-verify 35/60]。テーマ末レビューは A7b close 記録参照）
- 日付: 2026-07-24
- 決定者: lihs（production-extension grill E-Q12 + A7b grill 2026-07-24）
- 関連: [ADR-0015](./0015-build-deploy-ci-pipeline.md)（ビルド・デプロイ・CI パイプライン — tsc gate は同パイプラインの gate suite に追加される）、[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)（JSFFI 境界 — 本 ADR が型付けする wasmExports surface の出自）、[ADR-0017](./0017-testing-strategy.md)（テスト戦略 — T2 spec 群も型検査対象に含める）

## 背景と課題 (Context)

quickstart の JS glue 層（`worker/entry.mjs` 791 行、`scripts/*.mjs` 3 本 319 行）は手書き JS
だった。glue は wasmExports（GHC JSFFI `foreign export javascript` の 35 export、A7 close 時点）
を直接呼ぶが、この境界の署名ズレ（Haskell 側の export 追加・rename・引数変更に glue が追随
しない）を検出する機械的手段が存在せず、実行時の undefined 呼出しまで顕在化しなかった。

一方 2026-07 時点のツールチェーンは TS 化の前提を満たす（A7b probe で実機確認済み）:

- **P1**: Node v24.13.0 は `.mts` を type stripping で直実行する（ビルドステップ不要）。
  ただし enum / namespace 等の非 erasable 構文は `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` で実行拒否
- **P2**: wrangler 4.113.0 は `main = "entry.ts"` を esbuild で bundle するが**型検査は一切
  しない**（未定義の型名を書いても bundle 成功する）
- **P3**: typescript 7.0.2（native compiler）で `strict + noEmit + erasableSyntaxOnly +
  module/moduleResolution=nodenext + allowImportingTsExtensions + verbatimModuleSyntax` の
  フラグ組が成立し、同一ツリーの「tsc 型検査」と「node 直実行」が両立する

## 決定要因 (Decision Drivers)

- ビルドステップを増やさない（type stripping / esbuild 任せ、tsc は検査のみ）
- wasmExports 境界の署名ズレを gate 時点で検出する
- GHC post-linker の生成物（`ghc_wasm_jsffi.mjs`）は再生成されるため手を入れられない
- wasmExports surface の記録は API-LEDGER.md が既に正である（二重管理を作らない）

## 決定 (Decision)

1. **glue 言語**: `worker/entry.ts`（wrangler esbuild が bundle）+ `scripts/*.mts`（Node 24
   type stripping で直実行）。**erasable syntax 限定**（enum / namespace / parameter
   properties 禁止）を tsconfig `erasableSyntaxOnly` で機械強制する
2. **生成物は JS のまま**: `ghc_wasm_jsffi.mjs` は変更せず、手書きの ambient 宣言
   （`ghc_wasm_jsffi.d.mts`）で型付けする。`.wasm` import は ambient `declare module
   '*.wasm'`（`wasm-module.d.ts`）
3. **型 gate は tsc --noEmit のみ**（P2 の帰結: esbuild は検査しないので、tsc が唯一の型
   検査点。`just typecheck` として gate suite に配線、CI 組込は Phase A theme A8）。
   test spec（T2、41 ファイル）+ `vitest.config.mts` も検査対象に含める。spec の型是正は
   cast / 注釈のみ許可し assert・ロジック変更を禁じる（A7b で 56 件を同規律で解消）
4. **wasmExports 境界型は生成する**: API-LEDGER.md 内の機械可読 YAML manifest
   （`wasm_exports:` — name / ts_signature / verified_by / doc）を SSOT とし、生成器
   （`scripts/generate-wasm-exports-dts.mts`）が `worker/wasm-exports.d.ts` を決定論 emit。
   生成物は git-tracked とし、gate で再生成 + `git diff --exit-code`（golden 方式）
5. **実バイナリ照合**: `worker/quickstart.wasm` の `WebAssembly.Module.exports` と manifest を
   3 規則で照合する gate（`scripts/verify-wasm-exports.mts`）:
   - 規則 A: manifest の全 name が binary の function export に存在（rename / 削除検出）
   - 規則 B: infrastructure 以外の binary function export が全て manifest に存在
     （未記録 surface 検出）
   - 規則 C: infrastructure 判定は固定名 `memory`・`_initialize` + `^rts_` prefix のみ。
     それ以外の未知 export は FAIL（toolchain bump で RTS surface が変わったら loud に落とす）

   実測根拠（2026-07-24 probe）: 総 export 60 = app JSFFI 35 + `memory` + `_initialize` +
   `rts_*` 19（GHC RTS の JSFFI promise 機構）。**`rts_` prefix はアプリ export での使用禁止
   （予約）**とする
6. **runtime 型供給は `wrangler types`**: 生成される `worker-configuration.d.ts`（gitignore、
   `just types-generate` で再生成、`typecheck`/`lint` が先行実行）を採用。
   `@cloudflare/workers-types` は不採用 — compatibility_date と別軸で version 管理が必要になり
   手動同期が発生するため。既存の「生成物は gitignore + recipe 再生成」規約
   （`ghc_wasm_jsffi.mjs` / conformance golden）とも一致する
7. **typescript pin**: `^7.0.2`（native）。CI 環境で native binary 供給に問題が出た場合の
   fallback は typescript 5.9（`erasableSyntaxOnly` は 5.8+ に存在、使用フラグは全て共通）

## 結果 (Consequences)

- 署名 drift は二方向で閉じる: LEDGER↔.d.ts は生成で消滅、LEDGER↔実バイナリは規則 A/B/C
  で検出。glue↔.d.ts は tsc が検出
- 実装で確定した注意点（A7b 実測）:
  - tsc 7 native は `node_modules/@types` を自動発見しない → `"types"` 配列の明示が必須
  - 素の `.ts` を nodenext ESM として扱わせるため quickstart `package.json` に
    `"type": "module"` が必要（`.mts` は不要だが `.ts` は既定 CJS になる）
  - workerd の生成型に `RequestInit.duplex` が無い等、runtime 実挙動と型の乖離が spec 側に
    残る — spec ファイル内の局所 augmentation で吸収（生成型は編集不可のため）
- TS 7 は新しく、native 供給網のトラブルは fallback（決定 7）で退避する

## 遵守事項 (Compliance)

- `worker/wasm-exports.d.ts` を直接編集しない（API-LEDGER manifest を編集して再生成）
- glue / scripts に enum・namespace 等の非 erasable 構文を導入しない
- 新規 `foreign export javascript` の追加時は manifest への追記が必須（規則 B が強制する）
- アプリ export に `rts_` prefix の名前を付けない（規則 C の予約）

## 参考資料 (References)

- spike `_phase_a/a7b-plan.md`（probe P1-P3 の詳細、U5 設計確定節、batch 進捗）
- Node.js Type Stripping（Node 24 で既定有効、erasable syntax 限定）
- TypeScript 5.8 `erasableSyntaxOnly` / TypeScript 7 native compiler
