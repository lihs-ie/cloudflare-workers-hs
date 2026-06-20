# Lesson: <settings save flow can look successful while not persisting>

<!-- memory/lessons/<date>-<slug>.md。1 lesson 1 file。誤りと判明したら削除、重複は更新。 -->

## One-line summary
<UI success toast alone is not evidence; verify persisted state after reload.>

## Trigger
<PR #481 passed unit tests but failed manual smoke: "Saved" displayed, DB unchanged.>

## Verified facts
- <POST /api/settings returned 200>
- <service method executed>
- <repository write was skipped due to missing DI binding>
- <page reload restored old value>

## General rule
<For every user-visible save/update action, require one persistence evidence check:
reload, DB state diff, or downstream read-back.>

## Promotion status
- [ ] Added smoke / eval (evals/wiring/<...>.yml)
- [ ] Added wiring rubric item
- [ ] Added Stop hook / gate criterion
- [ ] Considered arch test for container bindings
