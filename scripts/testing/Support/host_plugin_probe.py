"""Measure the real host GHC parser plugin in an HPC-enabled compiler driver.

The ordinary ghc executable does not flush dynamically loaded plugin counters.
This driver uses the real GHC API and parser, never fabricated AST values.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess

DRIVER = r"""{-# LANGUAGE GADTs #-}
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
    targets <- mapM (\file -> guessTarget (unLoc file) Nothing Nothing) files
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
"""
PROBE = r"""module Main where
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
    Left err | value == 42 && "foreignValue' is a host-GHC type-checking stub" `isInfixOf` displayException err -> putStrLn "plugin probe passed"
    _ -> error "plugin probe failed"
"""


def collect(root, output, *, wasm_plugin=False):
    """Build an isolated shim and return fresh compiler .tix and dynamic .mix paths."""
    root, output = Path(root).resolve(), Path(output).resolve()
    output.relative_to(root)
    output.mkdir(parents=True, exist_ok=False)
    commands = []
    command_records = []
    sources = [root / 'cloudflare-workers/shim/compat/GHC/Wasm/FFI/Plugin.hs',
               root / 'cloudflare-workers/shim/compat/GHC/Wasm/Prim.hs']
    def hashes():
        return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}
    if wasm_plugin:
        sources = [root / 'cloudflare-workers/shim/wasm/GHC/Wasm/FFI/Plugin.hs']
    before = hashes()
    def run(args, label, tix=None):
        env = os.environ.copy()
        # Even compiler bootstrap has a private destination. Never append old ticks.
        target = tix or output / (label + '.tix')
        if target.exists():
            raise ValueError('refusing existing compiler tick file')
        env['HPCTIXFILE'] = str(target)
        commands.append(args)
        with (output / (label + '.log')).open('w') as log:
            completed = subprocess.run(args, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        command_records.append({'command': args, 'exitCode': completed.returncode, 'log': label + '.log',
                                'logSha256': hashlib.sha256((output / (label + '.log')).read_bytes()).hexdigest()})
    ffi = Path('/opt/homebrew/opt/libffi/include/ffi.h')
    cflags = ['-optc-I' + str(ffi.parent)] if ffi.exists() else []
    build = output / 'build'
    if wasm_plugin:
        package_dir = output / 'package'
        package_dir.mkdir()
        (package_dir / 'shim-wasm-probe.cabal').write_text(
            'cabal-version: 3.0\nname: shim-wasm-probe\nversion: 0.1.0.0\n'
            'build-type: Simple\nlibrary\n  exposed-modules: GHC.Wasm.FFI.Plugin\n'
            '  default-language: GHC2024\n  build-depends: base, ghc\n'
            '  hs-source-dirs: ' + str(root / 'cloudflare-workers/shim/wasm') + '\n')
        project = output / 'cabal.project'
        project.write_text('packages: ' + str(package_dir) + '\n')
        build_command = ['cabal', 'build', 'shim-wasm-probe', '--project-file=' + str(project)]
    else:
        build_command = ['cabal', 'build', 'cloudflare-workers:lib:ghc-wasm-shim']
    run(build_command + ['--builddir=' + str(build), '--enable-coverage']
        + (['--ghc-options=' + ' '.join(cflags)] if cflags else []), 'shim-build')
    package_dbs = list((build / 'packagedb').glob('ghc-*'))
    if len(package_dbs) != 1:
        raise ValueError('expected one isolated compiler package database')
    configs = list(package_dbs[0].glob('*.conf'))
    if len(configs) != 1:
        raise ValueError('expected one isolated shim package')
    package = configs[0].stem
    (output / 'Driver.hs').write_text(DRIVER)
    probe = ('module Main where\nmain :: IO ()\nmain = if (42 :: Int) == 42 then putStrLn \"plugin probe passed\" else fail \"ordinary declaration changed\"\n' if wasm_plugin else PROBE)
    (output / 'Main.hs').write_text(probe)
    run(['ghc', '-package', 'ghc', '-fhpc', '-hpcdir', str(output / 'driver-mix'),
         '-outputdir', str(output / 'driver-build'), *cflags, str(output / 'Driver.hs'),
         '-o', str(output / 'driver')], 'driver-build')
    libdir = subprocess.check_output(['ghc', '--print-libdir'], text=True).strip()
    ticks = output / 'compiler.tix'
    mode = 'wasm' if wasm_plugin else 'compat'
    ast_marker = 'parsed AST noop passed' if wasm_plugin else 'parsed AST compatibility passed'
    run([str(output / 'driver'), libdir, mode, '-package-db', str(package_dbs[0]),
         '-package-id', package, '-fplugin', 'GHC.Wasm.FFI.Plugin', '-fforce-recomp',
         '-outputdir', str(output / 'probe-build'), str(output / 'Main.hs'),
         '-o', str(output / 'probe'), *([] if wasm_plugin else ['-ddump-rn-ast'])], 'compiler', ticks)
    if ast_marker not in (output / 'compiler.log').read_text().splitlines():
        raise ValueError('compiler parsed AST contract did not succeed')
    run([str(output / 'probe')], 'probe')
    if not ticks.is_file() or 'GHC.Wasm.FFI.Plugin' not in ticks.read_text():
        raise ValueError('compiler did not emit plugin counters')
    if (output / 'probe.log').read_text().strip() != 'plugin probe passed':
        raise ValueError('behavior probe did not succeed')
    mixes = list(build.glob('**/hpc/dyn/mix/' + package + '/GHC.Wasm.FFI.Plugin.mix'))
    if len(mixes) != 1 or hashes() != before:
        raise ValueError('missing dynamic mix or sources changed during probe')
    run(['hpc', 'report', str(ticks), '--per-module', '--hpcdir=' + str(mixes[0].parent.parent),
         '--hpcdir=' + str(output / 'driver-mix')], 'coverage')
    compiler_ticks = ticks
    ticks = output / 'plugin-only.tix'
    run(['hpc', 'sum', '--exclude=Main', '--output=' + str(ticks), str(compiler_ticks)], 'select-plugin')
    proof = {'compiler_tix': str(compiler_ticks.relative_to(root)), 'status': 'passed', 'sources': before, 'commands': commands, 'commandRecords': command_records,
             'tix': str(ticks.relative_to(root)), 'mix': str(mixes[0].relative_to(root)),
             'tix_sha256': hashlib.sha256(ticks.read_bytes()).hexdigest(),
             'mix_sha256': hashlib.sha256(mixes[0].read_bytes()).hexdigest(),
             'prim': None if wasm_plugin else 'compiler accepted GHC.Wasm.Prim (JSVal) import; reexport has no runtime body',
             'parsedAst': {'mode': mode, 'successfulMarker': ast_marker},
             'limitations': 'The real parsed AST and compiled behavior are checked; generated driver Main is not repository coverage.'}
    (output / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n')
    return proof
