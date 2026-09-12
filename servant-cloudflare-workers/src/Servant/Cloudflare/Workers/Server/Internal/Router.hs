module Servant.Cloudflare.Workers.Server.Internal.Router (
    CaptureHint (..),
    Router,
    Router' (..),
    RoutingApplication,
    pathRouter,
    leafRouter,
    choice,
    runRouter,
    runRouterEnv,
    runChoice,
    worseHTTPCode,
    unionAllow,
    splitPathSegments,
) where

import Cloudflare.Workers.HTTP (Request, Response)
import Cloudflare.Workers.Reactor (WorkersExecutionContext)
import Cloudflare.Workers.URL (percentDecode)
import Data.Function (on)
import Data.List (nub)
import Data.Map.Strict (Map)
import Data.Map.Strict qualified as Map
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Typeable (TypeRep)
import Servant.Cloudflare.Workers.Error (ServerError (serverErrorHeaders, serverErrorStatusCode), err404)
import Servant.Cloudflare.Workers.Server.Internal.RouteResult (RouteResult (Fail))

type RoutingApplication bindingEnv =
    [Text] ->
    Request ->
    WorkersExecutionContext ->
    bindingEnv ->
    IO (RouteResult Response)

data CaptureHint = CaptureHint
    { captureName :: Text
    , captureType :: TypeRep
    }
    deriving stock (Show, Eq)

data Router' captureEnv a
    = StaticRouter (Map Text (Router' captureEnv a)) [captureEnv -> a]
    | CaptureRouter [CaptureHint] (Router' (Text, captureEnv) a)
    | CaptureAllRouter [CaptureHint] (Router' ([Text], captureEnv) a)
    | RawRouter (captureEnv -> a)
    | Choice (Router' captureEnv a) (Router' captureEnv a)
    deriving stock (Functor)

type Router captureEnv bindingEnv = Router' captureEnv (RoutingApplication bindingEnv)

pathRouter :: Text -> Router' captureEnv a -> Router' captureEnv a
pathRouter segment router = StaticRouter (Map.singleton segment router) []

leafRouter :: (captureEnv -> a) -> Router' captureEnv a
leafRouter leaf = StaticRouter Map.empty [leaf]

choice :: Router' captureEnv a -> Router' captureEnv a -> Router' captureEnv a
choice (StaticRouter table1 leaves1) (StaticRouter table2 leaves2) =
    StaticRouter (Map.unionWith choice table1 table2) (leaves1 ++ leaves2)
choice (CaptureRouter hints1 router1) (CaptureRouter hints2 router2) =
    CaptureRouter (nub (hints1 ++ hints2)) (choice router1 router2)
choice router1 (Choice router2 router3) = Choice (choice router1 router2) router3
choice router1 router2 = Choice router1 router2

splitPathSegments :: Text -> [Text]
splitPathSegments rawPath
    | Text.null rawPath = []
    | otherwise = map percentDecode (Text.splitOn "/" (dropLeadingSlash rawPath))
  where
    dropLeadingSlash path = case Text.uncons path of
        Just ('/', rest) -> rest
        _ -> path

unionAllow :: ServerError -> ServerError -> ServerError
unionAllow error1 error2 =
    error1
        { serverErrorHeaders =
            ("Allow", Text.intercalate ", " (nub (allowValues error1 ++ allowValues error2)))
                : filter (not . isAllowHeader) (serverErrorHeaders error1)
        }
  where
    isAllowHeader (headerName, _) = headerName == "Allow"
    allowValues serverError =
        maybe
            []
            (filter (not . Text.null) . map Text.strip . Text.splitOn ",")
            (lookup "Allow" (serverErrorHeaders serverError))

runChoice :: [RoutingApplication bindingEnv] -> RoutingApplication bindingEnv
runChoice applicacations segments request cloudflareContext bindingEnv =
    case applicacations of
        [] -> pure (Fail err404)
        [application] -> application segments request cloudflareContext bindingEnv
        application : restApplications -> do
            firstResult <- application segments request cloudflareContext bindingEnv
            case firstResult of
                Fail firstError -> do
                    restResult <- runChoice restApplications segments request cloudflareContext bindingEnv
                    pure (highestPriority firstError restResult)
                _ -> pure firstResult
  where
    highestPriority e1 (Fail e2)
        | serverErrorStatusCode e1 == 405 && serverErrorStatusCode e2 == 405 = Fail (unionAllow e1 e2)
        | worseHTTPCode (serverErrorStatusCode e1) (serverErrorStatusCode e2) = Fail e2
        | otherwise = Fail e1
    highestPriority _ secondResult = secondResult

worseHTTPCode :: Int -> Int -> Bool
worseHTTPCode = on (<) toPriority
  where
    toPriority :: Int -> Int
    toPriority 404 = 0 -- not found
    toPriority 405 = 1 -- method not allowed
    toPriority 401 = 2 -- unauthorized
    toPriority 415 = 3 -- unsupported media type
    toPriority 406 = 4 -- not acceptable
    toPriority 400 = 6 -- bad request
    toPriority _ = 5

runRouter :: Router () bindingEnv -> RoutingApplication bindingEnv
runRouter router = runRouterEnv router ()

runRouterEnv :: Router captureEnv bindingEnv -> captureEnv -> RoutingApplication bindingEnv
runRouterEnv router captureEnv segments request cloudflareContext bindingEnv =
    case router of
        StaticRouter table leaves ->
            case segments of
                [] -> runChoice (map ($ captureEnv) leaves) segments request cloudflareContext bindingEnv
                [""] -> runChoice (map ($ captureEnv) leaves) segments request cloudflareContext bindingEnv
                firstSegment : restSegments
                    | Just router' <- Map.lookup firstSegment table ->
                        runRouterEnv router' captureEnv restSegments request cloudflareContext bindingEnv
                _ -> pure (Fail err404)
        CaptureRouter _hints router' ->
            case segments of
                [] -> pure (Fail err404)
                [""] -> pure (Fail err404)
                firstSegment : restSegments -> runRouterEnv router' (firstSegment, captureEnv) restSegments request cloudflareContext bindingEnv
        CaptureAllRouter _hints router' ->
            let capturedSegemts = case segments of
                    "" : restSegments -> restSegments
                    otherSegments -> otherSegments
             in runRouterEnv router' (capturedSegemts, captureEnv) [] request cloudflareContext bindingEnv
        RawRouter app -> app captureEnv segments request cloudflareContext bindingEnv
        Choice router1 router2 ->
            runChoice [runRouterEnv router1 captureEnv, runRouterEnv router2 captureEnv] segments request cloudflareContext bindingEnv
