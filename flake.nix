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

          buildSkill = prev.callPackage ./nix/build-skill { };

          repoSkillsData =
            let
              byNameDir = ./data/by-name;
              prefixes = builtins.attrNames (builtins.readDir byNameDir);
              readSkillsJson =
                prefix: builtins.fromJSON (builtins.readFile (byNameDir + "/${prefix}/skills.json"));
            in
            builtins.concatMap readSkillsJson prefixes;

          skillsFlat = builtins.listToAttrs (
            builtins.concatMap (
              repo:
              let
                parsed = utils.parseSource repo.source;
              in
              map (skillPath: rec {
                name = utils.mkPname parsed.owner parsed.repo (
                  let
                    skillName = utils.getSkillName skillPath;
                  in
                  if skillName == null then parsed.repo else skillName
                );
                value = buildSkill {
                  pname = name;
                  inherit (parsed) owner repo;
                  inherit (repo) rev hash;
                  path = skillPath;
                };
              }) repo.skills
            ) repoSkillsData
          );
        in
        {
          skills = utils.recursiveMergeAttrs (
            lib.mapAttrsToList (k: v: lib.setAttrByPath (utils.splitPname k) v) skillsFlat
          );
        };
    };
}
