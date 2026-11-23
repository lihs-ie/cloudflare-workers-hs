# ADR-0031: Workers AI の画像生成を `workersAIRun` に追加する

- ステータス: 提案中
- 日付: 2026-11-22
- 決定者: lihs
- 関連: [Issue #147](https://github.com/lihs-ie/cloudflare-workers-hs-build/issues/147)、[Issue #9](https://github.com/lihs-ie/cloudflare-workers-hs-build/issues/9)、ADR-0007、ADR-0020、ADR-0030

## 背景と課題

英単語の意味を表すイラストなど、任意のプロンプトから画像を生成できるようにする。対象の3モデルは同じ Workers AI バインディングを使う。FLUX.1 schnell と Lucid Origin は `image` フィールドにBase64文字列を返し、Phoenix 1.0 は `ReadableStream` を返す。

## 決定要因

- テキスト生成と画像生成の呼び出し口を `workersAIRun` に揃える。
- モデルごとの入力と応答形式をHaskellの型で表す。
- Base64形式の不正とプロバイダー例外を区別する。
- Phoenixの画像を全量読み込まずにHTTP応答へ渡せるようにする。

## 検討した選択肢

| 選択肢                                              | 評価                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| FLUX.1 schnellのみ対応する                          | 既存のJSON呼び出し経路を使い、最小の実装で #147 を満たせる。比較できるモデルが1つに限られる。 |
| FLUX.1 schnell、Lucid Origin、Phoenix 1.0に対応する | 3モデルを共通のAPIで使える。Base64とストリームの2種類の応答を検証する必要がある。             |
| 比較した6モデルすべてに対応する                     | FLUX.2の3モデルも使える。multipart入力の実装と検証が増える。                                  |

## 決定

**FLUX.1 schnell、Lucid Origin、Phoenix 1.0の3モデルを採用する。** ADR-0030で導入する `AIModel input output` に各モデルを追加し、`workersAIRun` の戻り値型をモデルに応じて決める。

| モデル         | 必須入力 | 初回の任意入力                         | 戻り値                  |
| -------------- | -------- | -------------------------------------- | ----------------------- |
| FLUX.1 schnell | `prompt` | `steps`                                | 検証済みのBase64画像    |
| Lucid Origin   | `prompt` | `steps`、`width`、`height`、`seed`     | 検証済みのBase64画像    |
| Phoenix 1.0    | `prompt` | `num_steps`、`width`、`height`、`seed` | 既存の `ReadableStream` |

省略した任意入力は送信せず、Cloudflareの既定値を使う。`seed` は公式パラメーター表で確認できるモデルに限定する。`guidance`、`negative_prompt`、FLUX.2のmultipart入力は今回の対象外とする。

Base64の応答は、`image` が存在し、文字列であり、有効なBase64としてデコードできることを確認して返す。利用者はBase64文字列を取得し、必要に応じてバイト列に変換できる。画像ファイル自体の妥当性は検査しない。`image` の欠損・型違い・不正なBase64は `WorkersAIInvalidResponse`、プロバイダーが返す例外は `WorkersAIException` とする。

Phoenixの応答がストリームでなければ `WorkersAIInvalidResponse` とする。正常なストリームは全量を読み込まずに返す。返却後の読み取り失敗は既存のストリームAPIで扱う。この対応には、Issue #9と重なるPhoenixのストリーム出力を含める。

## 結果

- **利点**　3モデルを共通のAPIで呼び出し、モデルに応じた結果を型で扱える。Phoenixは `ResponseBodyStream` に直接渡せる。
- **トレードオフ**　利用側でBase64画像とストリームを扱い分ける必要がある。Base64の応答は既に全体が文字列として返るため、形式を検証する際も応答全体を扱う。
- **フォローアップ**　FLUX.2を追加する際はmultipart入力の設計を行う。Issue #9では、Phoenix以外に残るストリーム対応の範囲を評価する。

## 遵守事項

- CIで、3モデルそれぞれの送信フィールド、任意入力の省略、正常応答、プロバイダー例外を検証する。Base64の欠損・型違い・不正値と、Phoenixの非ストリーム応答も検証する。
- workerdでPhoenixのストリームを全量読み込まずにHTTP応答へ渡せることを確認する。テスト題材は英単語に限定しない。
- FLUX.1 schnellで画像を生成し、`image/jpeg` のHTTP応答を返す最小例を用意する。
- リリース前に実際の Workers AI バインディングで各モデルを1回呼び出し、schnellとLucid OriginのBase64応答、Phoenixのストリーム応答を確認する。

## 参考資料

- [FLUX.1 schnellの仕様](https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/)
- [Lucid Originの仕様](https://developers.cloudflare.com/workers-ai/models/lucid-origin/)
- [Phoenix 1.0の仕様](https://developers.cloudflare.com/workers-ai/models/phoenix-1.0/)
- [FLUX.2の入力仕様](https://developers.cloudflare.com/agents/models/ai-sdk/)
