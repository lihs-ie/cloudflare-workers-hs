{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TypeApplications #-}
module APIContractsSpec (spec) where
import Servant.API.Generic (fromServant, toServant)
import Servant.Links (AsLink, Link, allFieldLinks, fieldLink, linkURI)
import Test.Syd
import WorkflowExample.API qualified as Workflow

spec :: Spec
spec = describe "workflows public API" $ do
    it "keeps workflow creation and generated-identifier creation distinct" $ do
        let routes = workflowLinks
        render (Workflow.health routes) `shouldBe` "health"
        render (Workflow.create routes) `shouldBe` "workflows"
        render (Workflow.createGenerated routes) `shouldBe` "workflows/generated"

    it "preserves the same escaped workflow identifier across lifecycle links" $ do
        let routes = workflowLinks
            identifier = "approval/team one"
        render (Workflow.status routes identifier)
            `shouldBe` "workflows/approval%2Fteam%20one"
        render (Workflow.approve routes identifier)
            `shouldBe` "workflows/approval%2Fteam%20one/approve"
        render (Workflow.control routes identifier)
            `shouldBe` "workflows/approval%2Fteam%20one/control"
        render (Workflow.audit routes identifier)
            `shouldBe` "workflows/approval%2Fteam%20one/audit"
  where
    render = show . linkURI
    workflowLinks :: Workflow.Routes (AsLink Link)
    workflowLinks = fromServant (toServant (allFieldLinks @Workflow.Routes))
