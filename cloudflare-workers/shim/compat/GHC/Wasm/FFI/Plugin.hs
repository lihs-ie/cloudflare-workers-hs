module GHC.Wasm.FFI.Plugin (plugin) where

import GHC.Builtin.Names (error_RDR)
import GHC.Hs
import GHC.Plugins
import GHC.Types.ForeignCall (CCallConv (JavaScriptCallConv), CExportSpec (CExportStatic))

plugin :: Plugin
plugin =
    defaultPlugin
        { pluginRecompile = purePlugin
        , parsedResultAction = eraseJavaScriptForeign
        }

eraseJavaScriptForeign :: [CommandLineOption] -> ModSummary -> ParsedResult -> Hsc ParsedResult
eraseJavaScriptForeign _options _summary parsed =
    pure parsed{parsedResultModule = rewritten}
  where
    parsedModule = parsedResultModule parsed
    rewritten = parsedModule{hpm_module = eraseInModule <$> hpm_module parsedModule}

eraseInModule :: HsModule GhcPs -> HsModule GhcPs
eraseInModule hsModule = hsModule{hsmodDecls = concatMap eraseDecl (hsmodDecls hsModule)}

eraseDecl :: LHsDecl GhcPs -> [LHsDecl GhcPs]
eraseDecl (L declSpan (ForD _ ForeignImport{fd_name = name, fd_sig_ty = declaredType, fd_fi = CImport _ (L _ JavaScriptCallConv) _ _ _})) =
    [ L declSpan (SigD noExtField (stubSignature name declaredType))
    , L declSpan (ValD noExtField (stubBinding name))
    ]
eraseDecl (L _ (ForD _ ForeignExport{fd_fe = CExport _ (L _ (CExportStatic _ _ JavaScriptCallConv))})) =
    []
eraseDecl anythingElse = [anythingElse]

stubSignature :: LIdP GhcPs -> LHsSigType GhcPs -> Sig GhcPs
stubSignature name declaredType = TypeSig noAnn [name] (mkHsWildCardBndrs declaredType)

stubBinding :: LIdP GhcPs -> HsBind GhcPs
stubBinding name = mkFunBind (Generated OtherExpansion SkipPmc) name [stubEquation]
  where
    stubEquation = mkMatch (mkPrefixFunRhs name noAnn) (noLocA []) stubBody (EmptyLocalBinds noExtField)
    stubBody = nlHsApp (nlHsVar error_RDR) (nlHsLit (mkHsString (stubMessage name)))

stubMessage :: LIdP GhcPs -> String
stubMessage name =
    "GHC.Wasm.FFI.Plugin: '"
        ++ occNameString (rdrNameOcc (unLoc name))
        ++ "' is a host-GHC type-checking stub for a JavaScript foreign import; \
           \it has no host implementation and must never be forced (the real \
           \binding exists only on the wasm32-wasi target)"
