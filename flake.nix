{
  description = "sudosubin/nix-skills";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      forAllSystems =
        with nixpkgs.lib;
        f: genAttrs platforms.unix (system: f (import nixpkgs { inherit system; }));
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            gh
            nodejs-slim
            nodePackages.pnpm
          ];
        };
      });

      skills = forAllSystems (pkgs: (self.overlays.default pkgs pkgs).skills);

      overlays.default =
        final: prev:
        let
          inherit (prev) lib;

          utils = import ./nix/utils.nix { inherit lib; };

          skills-ref = prev.callPackage ./nix/skills-ref { };
          validateSkillHook = prev.callPackage ./nix/validate-skill-hook { inherit skills-ref; };
          buildSkill = prev.callPackage ./nix/build-skill { inherit validateSkillHook; };

          skillsData =
            let
              byNameDir = ./data/by-name;
              prefixes = builtins.attrNames (builtins.readDir byNameDir);
              readSkillsJson = prefix: builtins.fromJSON (builtins.readFile (byNameDir + "/${prefix}/skills.json"));
            in
            builtins.concatMap readSkillsJson prefixes;

          skillsFlat = builtins.listToAttrs (
            map (v: {
              name = v.pname;
              value = buildSkill {
                inherit (v) pname path;
                inherit (v.source)
                  owner
                  repo
                  rev
                  hash
                  ;
              };
            }) skillsData
          );
        in
        {
          inherit skills-ref validateSkillHook;
          skills = utils.recursiveMergeAttrs (
            lib.mapAttrsToList (k: v: lib.setAttrByPath (utils.splitPname k) v) skillsFlat
          );
        };
    };
}
