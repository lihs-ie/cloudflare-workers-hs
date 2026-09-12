# Spec: <feature>

<!-- spec-curator が grill-me 合意から正規化する。docs/specs/<feature>.md に置く。 -->

## Goal
- <何を実現するか。1〜3 行>

## Must (満たさなければ done でない)
- [ ] <Must-1: 機械検証可能な条件>
- [ ] <Must-2>

## Should (望ましいが必須でない)
- <Should-1>

## 受入条件 (acceptance — Must の確認方法)
- Must-1 → <確認コマンド / 観測可能挙動 (例: POST /x が 201 と body.id を返す)>
- Must-2 → <...>

## Non-goals (今回やらない)
- <scope 外 / 将来課題>

## Risk
- level: low | high-risk
- escalate_to_opus: true | false
- 理由: <DI/routing/auth/config/migration/schema/public export/background job/event subscription のどれに触れるか>

## Open questions (あれば)
- <人間判断が要る未確定点>
