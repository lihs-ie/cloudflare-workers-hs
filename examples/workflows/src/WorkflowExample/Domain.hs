module WorkflowExample.Domain where
import Data.Aeson
import Data.Text (Text)
import Data.Time (UTCTime, defaultTimeLocale, formatTime, parseTimeM)
import Data.Text qualified as Text
import GHC.Generics (Generic)

data ApprovalRequest = ApprovalRequest {message :: Text, behavior :: Text, executeAt :: Maybe UTCTime} deriving stock (Show, Eq, Generic)
instance FromJSON ApprovalRequest where
    parseJSON = withObject "ApprovalRequest" $ \value -> do
        message' <- value .: "message"
        behavior' <- value .: "behavior"
        timestamp <- value .:? "executeAt"
        target <- traverse parseUTC timestamp
        pure (ApprovalRequest message' behavior' target)
      where
        parseUTC text = case parseTimeM True defaultTimeLocale "%Y-%m-%dT%H:%M:%S%QZ" (Text.unpack text) of
            Just utc | Text.pack (formatTime defaultTimeLocale "%Y-%m-%dT%H:%M:%S" utc) `Text.isPrefixOf` text
                     , Text.isSuffixOf "Z" text -> pure utc
            _ -> fail "executeAt must be a valid UTC RFC3339 timestamp ending in Z"
instance ToJSON ApprovalRequest
data CreateRequest = CreateRequest {identifier :: Text, parameters :: ApprovalRequest} deriving stock (Show, Eq, Generic)
instance FromJSON CreateRequest
instance ToJSON CreateRequest
newtype Approval = Approval {approved :: Bool} deriving stock (Show, Eq, Generic)
instance FromJSON Approval
instance ToJSON Approval
