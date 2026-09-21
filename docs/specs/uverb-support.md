# Typed multi-status responses with `UVerb`

`servant-cloudflare-workers` supports Servant's standard `UVerb`, `Union`, and
`WithStatus` types on the server side. A handler chooses one response declared
in the API with the public `respond` helper. The selected type determines the
HTTP status, body encoder, and typed response headers.

```haskell
{-# LANGUAGE DataKinds #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TypeApplications #-}
{-# LANGUAGE TypeOperators #-}

import Data.Text (Text)
import Servant.API (Capture, Header, Headers, JSON, StdMethod (POST), addHeader, (:>))
import Servant.API.UVerb (UVerb, WithStatus (WithStatus))
import Servant.Cloudflare.Workers.Server (Server, respond)

type ClaimAPI =
  Capture "outcome" Text
    :> UVerb 'POST '[JSON]
      '[ WithStatus 201 (Headers '[Header "Location" Text] Text)
       , WithStatus 200 Int
       , WithStatus 409 Bool
       ]

claimHandler :: Text -> Server ClaimAPI ()
claimHandler outcome = case outcome of
  "created" -> respond (WithStatus @201 (addHeader ("/claims/example" :: Text) ("created" :: Text)))
  "done" -> respond (WithStatus @200 (1 :: Int))
  _ -> respond (WithStatus @409 True)
```

The compiler rejects responses absent from the union and duplicate status
codes. `Headers hs (WithStatus n a)` and `WithStatus n (Headers hs a)` are both
supported. `NoContent` may select its standard 204 status or another status
when wrapped in `WithStatus`. Content negotiation still applies to an empty
body. A `GET` UVerb accepts `HEAD`, preserving status and headers while
suppressing the body.

This feature interprets a Servant HTTP contract only. Applications remain
responsible for business decisions, authorization, retries, persistence, and
choosing which declared response to return. It adds neither a Cloudflare
binding nor a Servant client interpreter.
