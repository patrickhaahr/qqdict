{
  description = "qqdict: push-to-talk dictation using your Codex sign-in";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        qqdict = pkgs.callPackage ./nix/package.nix { };
        default = qqdict;
      });

      apps = forAllSystems (pkgs:
        let package = self.packages.${pkgs.stdenv.hostPlatform.system}.qqdict;
        in rec {
          qqdict = { type = "app"; program = "${package}/bin/qqdict"; inherit (package) meta; };
          default = qqdict;
        });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_24 pkgs.pnpm_10 pkgs.electron_44 pkgs.wl-clipboard pkgs.wtype ];
          # The Electron that pnpm downloads is not linked for NixOS; use nixpkgs'.
          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron_44}/bin";
        };
      });
    };
}
