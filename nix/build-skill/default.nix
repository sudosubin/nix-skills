{
  lib,
  fetchFromGitHub,
  stdenvNoCC,
  validateSkillHook,
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

stdenvNoCC.mkDerivation {
  pname = utils.getSkillName pname;
  version = builtins.substring 0 7 rev;

  src = fetchFromGitHub {
    inherit owner repo rev;
    sha256 = hash;
  };

  sourceRoot = "source" + (if path == "" then "" else "/${path}");

  nativeBuildInputs = [ validateSkillHook ];

  dontBuild = true;
  doCheck = true;

  installPhase = ''
    runHook preInstall
    cp -R . "$out"
    runHook postInstall
  '';
}
