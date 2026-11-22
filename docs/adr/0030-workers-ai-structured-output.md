# ADR-0030 — Workers AI の構造化出力を `workersAIRun` に追加する

- ステータス：提案中
- 日付：2026-11-22
- 決定者：lihs
- 関連：[公開版 Issue #116](https://github.com/lihs-ie/cloudflare-workers-hs/issues/116) · [同期先 Issue #148](https://github.com/lihs-ie/cloudflare-workers-hs-build/issues/148) · ADR-0003 · ADR-0008 · ADR-0017 · ADR-0020

## 背景と課題

アプリケーションが英単語の定義と例文を読み取れるよう、Workers AI に JSON Schema を渡して構造化出力を要求する。現行の Haskell API は `GemmaInput` を受け取り、`GemmaOutput` を返す。Cloudflareの JSON Mode は対応モデルで利用でき、非ストリーミングのリクエストを必要とする。

## 決定要因

- `workersAIRun` を Workers AI の共通の呼び出し口とする。
- モデルに適合する入出力型をコンパイル時に決定する。
- 既存の Gemma 4 の直接呼び出しを維持する。
- 初回は1モデルでリクエストから利用者側のデコードまでを検証し、後続モデルを追加できるようにする。

## 検討した選択肢

| 案                                                  | 利点とトレードオフ                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 構造化出力専用の関数を追加する                      | 既存の公開型を維持できる。出力形式ごとに呼び出す関数が変わる。                                      |
| モデルに入出力型を持たせ、`workersAIRun` に統一する | モデル選択だけで入出力型が決まる。型引数なしの `AIModel` を明示している利用者には移行が必要になる。 |

## 決定

モデルに入出力型を持たせる案を採用する。

```haskell
data AIModel input output where
    Gemma4 :: AIModel GemmaInput GemmaOutput
    Llama33 :: AIModel StructuredInput Value

workersAIRun
    :: WorkersAI -> AIModel input output -> input -> AIOptions -> IO output
```

- 構造化出力の初回対応モデルは `@cf/meta/llama-3.3-70b-instruct-fp8-fast` とする。後続モデルは入出力の契約に応じた型付きコンストラクタを追加し、共通のバインディング呼び出しとエラー変換を再利用する。
- `StructuredInput` はメッセージと JSON Schema を持つ。リクエスト本文に `response_format.type = "json_schema"` と `response_format.json_schema` を設定し、非ストリーミングで送信する。
- ライブラリは応答の `response` を Aeson の `Value` として返す。スキーマへの適合はCloudflareに委ね、アプリケーション型への変換は利用者が `fromJSON` で行う。
- プロバイダーがスキーマへの適合に失敗して例外を返した場合は `WorkersAIException` とする。応答をJSONとして読めない場合や `response` が欠けている場合は `WorkersAIInvalidResponse` とする。利用者の `fromJSON` の失敗はアプリケーション側で扱う。

## 結果

- Gemma 4 と Llama 3.3 を同じ `workersAIRun` で呼び出せる。モデルと入力の組み合わせが誤っていればコンパイル時に検出できる。
- 既存の `workersAIRun ai Gemma4 input options` はそのまま使える。`model :: AIModel` のような型注釈は `model :: AIModel GemmaInput GemmaOutput` へ移行する。
- Cloudflareはスキーマに沿った結果を常に生成できるとは限らない。呼び出し側はプロバイダー例外とアプリケーション型への変換失敗を扱う。

## 遵守事項

- CIで、実際のバインディングに渡す引数の形をworkerdのテスト用バインディングで検証する。成功応答、スキーマ適合失敗、壊れた応答、既存の Gemma 4 呼び出しをテストする。
- `word`、`definition`、`exampleSentence` を要求し、結果を `WordEntry` に変換する最小例を追加する。公開型の移行方法も案内する。
- リリース前に実際の Workers AI バインディングで最小例を1回実行し、`response` の実際の形式と `WordEntry` への変換成功を確認する。

## 参考資料

- [Cloudflare Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- [Llama 3.3 FP8 Fast のモデル仕様](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/)
