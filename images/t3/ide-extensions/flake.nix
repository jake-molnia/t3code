{
  description = "Pinned Open VSX extensions for the T3 sandbox IDE";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      extensions = builtins.fromJSON (builtins.readFile ./extensions.json);
      archives = map (extension: {
        name = "${extension.id}-${extension.version}.vsix";
        path = if (extension.archive or null) != null
          then ./. + "/${extension.id}-${extension.version}.vsix"
          else builtins.fetchurl {
          inherit (extension) url;
          sha256 = extension.hash;
        };
      }) extensions;
    in {
      packages.${system} = {
        nix-builder = pkgs.nixVersions.stable;
        default = pkgs.linkFarm "t3-ide-extensions" (
          archives ++ [{ name = "extensions.json"; path = ./extensions.json; }]
        );
      };
    };
}
