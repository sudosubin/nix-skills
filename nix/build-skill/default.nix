{
  lib,
  fetchFromGitHub,
  stdenvNoCC,
  yq-go,
}:

let
  utils = import ../utils.nix { inherit lib; };

in
lib.makeOverridable (
  {
    pname,
    owner,
    repo,
    rev,
    path,
    hash,
    name ? utils.getSkillName pname,
  }:
  stdenvNoCC.mkDerivation {
    pname = name;
    version = builtins.substring 0 7 rev;

    src = fetchFromGitHub {
      inherit owner repo rev;
      sha256 = hash;
    };

    sourceRoot = "source" + (if path == "" || path == "." then "" else "/${path}");

    nativeBuildInputs = [ yq-go ];

    dontBuild = true;
    dontConfigure = true;

    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -RL . "$out"

      if [ -f "$out/SKILL.md" ]; then
        yq --inplace --front-matter=process \
          ${lib.escapeShellArg ".name = \"${name}\""} \
          "$out/SKILL.md"
      fi

      runHook postInstall
    '';
  }
)
