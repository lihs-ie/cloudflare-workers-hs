module Servant.Cloudflare.Workers.AccessSpec (spec) where

import Servant.Cloudflare.Workers.Access
import Test.Syd

spec :: Spec
spec = describe "Access verifier preflight" $ do
    it "preserves raw assertion text without treating wrapping as verification" $
        map (unAccessJWT . AccessJWT) ["", "header..signature", "opaque assertion"] `shouldBe` ["", "header..signature", "opaque assertion"]
    it "rejects too few JWT segments before runtime access" $
        verifyAccessJWT (AccessConfig "aud" "team" "https://team/certs") "not-a-jwt" `shouldReturn` Left (AccessErrorMalformed "expected header.payload.signature")
    it "rejects too many JWT segments before runtime access" $
        verifyAccessJWT (AccessConfig "aud" "team" "https://team/certs") "a.b.c.d" `shouldReturn` Left (AccessErrorMalformed "expected header.payload.signature")
    it "rejects empty segments before runtime access" $
        verifyAccessJWT (AccessConfig "aud" "team" "https://team/certs") "header..signature" `shouldReturn` Left (AccessErrorMalformed "expected header.payload.signature")
    it "rejects alg none before reaching JWKS or crypto" $
        verifyAccessJWT (AccessConfig "aud" "team" "https://team/certs") "eyJhbGciOiJub25lIiwia2lkIjoia2V5In0.e30.c2ln" `shouldReturn` Left (AccessErrorMalformed "unsupported alg: none")
