{
  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/*";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        formatter = pkgs.nixfmt-tree;

        grammar = pkgs.tree-sitter.buildGrammar {
          language = "nexus";
          version = "0.1.0";
          src = ./.;
        };
      in
      {
        packages.default = grammar;

        devShells.default = pkgs.mkShellNoCC {
          inputsFrom = [ grammar ];
          packages = with pkgs; [
            tree-sitter
            nodejs
            actionlint
            formatter
          ];
        };

        legacyPackages = pkgs;
        inherit formatter;
      }
    );
}
