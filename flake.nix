{
  description = "cloudflare-workers-hs dev shell (WASM toolchain + Node/pnpm; host GHC is intentionally NOT supplied here, install via ghcup)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    ghc-wasm-meta.url = "gitlab:haskell-wasm/ghc-wasm-meta?host=gitlab.haskell.org";
  };

  outputs =
    { self, nixpkgs, ghc-wasm-meta }:
    let
      systems = [ "x86_64-linux" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          fourmolu = pkgs.writeShellApplication {
            name = "fourmolu";
            runtimeInputs = [ pkgs.dotslash ];
            text = ''
              exec dotslash ${./fourmolu} "$@"
            '';
          };
        in
        {
          default = pkgs.mkShell {
            buildInputs = [
              ghc-wasm-meta.packages.${system}.all_9_14
              pkgs.nodejs_24
              pkgs.pnpm
              pkgs.gmp
              fourmolu
              pkgs.hlint
              pkgs.just
            ];

            shellHook = ''
              echo "cloudflare-workers-hs dev shell: wasm32-wasi (ghc-wasm-meta) + Node 24 + pnpm"
              echo "host GHC 9.14.1 is intentionally NOT supplied by this flake -- install it via ghcup instead"
              wasm_env=${ghc-wasm-meta.packages.${system}.all_9_14}/bin/env
              if [ -f "$wasm_env" ]; then
                source "$wasm_env"
              fi
            '';
          };
        }
      );
    };
}
