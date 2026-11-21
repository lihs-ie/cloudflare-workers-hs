{ pkgs, system }:
let
  nodeVersion = pkgs.lib.removeSuffix "\n" (builtins.readFile ../.node-version);
  pnpmVersion = pkgs.lib.removePrefix "pnpm@" (builtins.fromJSON (builtins.readFile ../package.json)).packageManager;
  release = {
    x86_64-linux = {
      name = "linux-x64";
      nodeHash = "sha256-TysXWm1TpcYXqA26JnYjigaIzvKMbaTro1x9hE5m/Ps=";
      pnpmHash = "sha512-iBAZAYCYoow6g0aObKmprKkIBGO72mK4KFfqIrY7jIdHRkAbN67tcN0zgaPE39UAEdMcrkLhLwEml+VMxf8h8Q==";
    };
    aarch64-darwin = {
      name = "darwin-arm64";
      nodeHash = "sha256-HWQTbIpD1kjRs7rRB5ekyZWxygMtK96Hmd5Ds38Fj+U=";
      pnpmHash = "sha512-CU0m1tFFVW2QD2PDVTsdejYGoPzhMq04l/MnwhpCuM2iBXkMXqV52kH24U5A2SYULV4Y/TTYsKL5InKZblVNvw==";
    };
  }.${system};
  linux = pkgs.stdenv.isLinux;
  binaryArchive = { pname, version, url, hash, installPhase }:
    pkgs.stdenvNoCC.mkDerivation {
      inherit pname version installPhase;
      src = pkgs.fetchurl { inherit url hash; };
      nativeBuildInputs = pkgs.lib.optionals linux [ pkgs.autoPatchelfHook ];
      buildInputs = pkgs.lib.optionals linux [ pkgs.stdenv.cc.cc.lib ];
      dontBuild = true;
      dontConfigure = true;
    };
in
{
  node = binaryArchive {
    pname = "nodejs";
    version = nodeVersion;
    url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-${release.name}.tar.xz";
    hash = release.nodeHash;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -R . "$out"
      runHook postInstall
    '';
  };
  pnpm = binaryArchive {
    pname = "pnpm";
    version = pnpmVersion;
    url = "https://registry.npmjs.org/@pnpm/exe.${release.name}/-/exe.${release.name}-${pnpmVersion}.tgz";
    hash = release.pnpmHash;
    installPhase = ''
      runHook preInstall
      install -Dm755 pnpm "$out/bin/pnpm"
      runHook postInstall
    '';
  };
}
