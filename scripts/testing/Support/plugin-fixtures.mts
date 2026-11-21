export const compilerDriver = `{-# LANGUAGE GADTs #-}
module Main where
import GHC
import GHC.Hs
import GHC.Parser.Annotation
import GHC.Types.Name.Reader (rdrNameOcc)
import GHC.Types.Name.Occurrence (occNameString)
import GHC.Types.SrcLoc (noLoc)
import Control.Monad (unless)
import Control.Monad.IO.Class (liftIO)
import System.Environment
import System.Exit

main :: IO ()
main = do
  libdir:mode:args <- getArgs
  result <- runGhc (Just libdir) $ do
    flags <- getSessionDynFlags
    logger <- getLogger
    (configured, files, _) <- parseDynamicFlags logger flags (map noLoc args)
    _ <- setSessionDynFlags configured
    targets <- mapM (\\file -> guessTarget (unLoc file) Nothing Nothing) files
    setTargets targets
    loaded <- load LoadAllTargets
    graph <- getModuleGraph
    parsed <- mapM parseModule (mgModSummaries graph)
    liftIO $ case mode of
      "compat" -> mapM_ verifyParsed parsed
      "wasm" -> mapM_ verifyNoopParsed parsed
      _ -> fail "unknown plugin probe mode"
    pure loaded
  case result of
    Succeeded -> pure ()
    Failed -> exitFailure

verifyParsed :: ParsedModule -> IO ()
verifyParsed parsed = do
  let declarations = hsmodDecls (unLoc (pm_parsed_source parsed))
      signature = [ canonicalSignature extension annotation
                  | L _ (SigD extension (TypeSig annotation [name] _)) <- declarations
                  , nameText name == "foreignValue" ]
      binding = [ canonicalExtension extension
                | L _ (ValD extension FunBind{fun_id=name}) <- declarations
                , nameText name == "foreignValue" ]
      ordinary = [ nameText name | L _ (ValD _ FunBind{fun_id=name}) <- declarations
                                , nameText name == "ordinaryValue" ]
      foreignDeclarations = [ () | L _ (ForD _ _) <- declarations ]
  unless (signature == [True] && binding == [True] && ordinary == ["ordinaryValue"] && null foreignDeclarations) $
    fail ("plugin parsed AST compatibility failed: " ++ show (signature,binding,ordinary,length foreignDeclarations))
  putStrLn "parsed AST compatibility passed"
  where
    nameText name = occNameString (rdrNameOcc (unLoc name))

canonicalExtension :: NoExtField -> Bool
canonicalExtension NoExtField = True

canonicalSignature :: NoExtField -> AnnSig -> Bool
canonicalSignature NoExtField (AnnSig NoEpUniTok Nothing Nothing) = True
canonicalSignature _ _ = False

verifyNoopParsed :: ParsedModule -> IO ()
verifyNoopParsed parsed = do
  let declarations = hsmodDecls (unLoc (pm_parsed_source parsed))
      names = [ occNameString (rdrNameOcc (unLoc name))
              | L _ (ValD _ FunBind{fun_id=name}) <- declarations ]
      foreignDeclarations = [ () | L _ (ForD _ _) <- declarations ]
  unless (names == ["main"] && null foreignDeclarations) $
    fail ("plugin parsed AST noop failed: " ++ show (names,length foreignDeclarations))
  putStrLn "parsed AST noop passed"
`;

export const compatibilityProbe = `module Main where
import Control.Exception
import Data.List (isInfixOf)
import GHC.Wasm.Prim (JSVal)
foreign import javascript unsafe "42" foreignValue :: IO Int
foreign export javascript "ordinaryValue" ordinaryValue :: IO Int
ordinaryValue :: IO Int
ordinaryValue = pure 42
reexportWitness :: Maybe JSVal
reexportWitness = Nothing
main :: IO ()
main = do
  value <- ordinaryValue
  result <- try foreignValue :: IO (Either SomeException Int)
  case result of
    Left err | value == 42 && "foreignValue' is a host-GHC type-checking stub" \`isInfixOf\` displayException err -> putStrLn "plugin probe passed"
    _ -> error "plugin probe failed"
`;
