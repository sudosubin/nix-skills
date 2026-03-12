{
  lib,
  fetchFromGitHub,
  stdenvNoCC,
}:

let
  utils = import ../utils.nix { inherit lib; };
in

{
  pname,
  owner,
  repo,
  rev,
  path,
  hash,
  ...
}:

let
  skill = utils.getSkillName pname;
  root = "source" + (if path == "" || path == "." then "" else "/${path}");
in

stdenvNoCC.mkDerivation {
  pname = skill;
  version = builtins.substring 0 7 rev;

  src = fetchFromGitHub {
    inherit owner repo rev;
    sha256 = hash;
  };

  sourceRoot = root;

  dontBuild = true;
  dontConfigure = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -RL . "$out"
    runHook postInstall
  '';
}
