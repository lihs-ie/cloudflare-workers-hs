module URLShortener.DO () where

data WebSocketConnection = WebSocketConnectionSTUB
    deriving stock (Show, Eq)

data CounterState = CounterState
    { counterStateCount :: IORef Int
    , counterStateSubscribers :: IORef [WebSocketConnection]
    }
