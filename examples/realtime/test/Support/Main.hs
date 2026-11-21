{-# LANGUAGE CPP #-}
module Main (main) where
import Cloudflare.Workers.Entrypoint.DurableObject
import Cloudflare.Workers.Binding.DurableObject
import GHC.Wasm.Prim (JSVal)
import Support.RoomFixture qualified as RoomFixture
#ifdef WASM_COVERAGE
import Support.Coverage (withCoverage)
#endif

main :: IO ()
main = pure ()

roomOversizeCheck :: JSVal -> JSVal -> JSVal -> IO ()
roomOversizeCheck storage state socket = RoomFixture.oversizedMessage (DurableObjectStorage storage) (WebSocketState state) (WebSocketConnection socket)
#ifdef WASM_COVERAGE
coverage_roomOversizeCheck :: JSVal -> JSVal -> JSVal -> IO ()
coverage_roomOversizeCheck storage state socket = withCoverage (roomOversizeCheck storage state socket)
foreign export javascript "roomOversizeCheck" coverage_roomOversizeCheck :: JSVal -> JSVal -> JSVal -> IO ()
#else
foreign export javascript "roomOversizeCheck" roomOversizeCheck :: JSVal -> JSVal -> JSVal -> IO ()
#endif
