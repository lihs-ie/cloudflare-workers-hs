# rubric pack: Haskell (servant / cabal)

cabal `exposed-modules` と app の結線が最頻の未配線点。`Api.hs`→`Main.hs`/`Application.hs`
への結線と、placeholder (`throwError err501` / `undefined`) の残置を重点検査する。

## 追加判定項目
- 新規 module が `exposed-modules` / `other-modules` に登録され、`Main.hs` か `Application.hs` から結線される。
- handler が `throwError err501` / `notImplemented` / `undefined` の placeholder を残していない。
- 新規 export 関数が本番呼び出し箇所から実参照される (`grep -rn '<fn>' src --include='*.hs'`)。
- server 起動 smoke と該当 endpoint が例外なく流れる。

## 推奨証拠
- `cabal build all` + `cabal test`。
- hlint の no-prod-doubles ルール (`*.Mock`/`*.Fake` module の restrict)。
- 文字列 parser / OIDC callback parser に `Test.QuickCheck` / fuzz target。
