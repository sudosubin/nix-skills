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

let
  skill = utils.getSkillName pname;
  root = "source" + (if path == "" || path == "." then "" else "/${path}");
in

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = skill;
  version = builtins.substring 0 7 rev;

  src = fetchFromGitHub {
    inherit owner repo rev;
    sha256 = hash;
  };

  sourceRoot = skill;
  dontMakeSourcesWritable = true;

  postUnpack = ''
    chmod -R u+w -- source
    mv ${lib.escapeShellArg root} ${lib.escapeShellArg skill}
  '';

  nativeBuildInputs = [ validateSkillHook ];

  dontBuild = true;
  doCheck = true;

  installPhase = ''
    runHook preInstall
    cp -R . "$out"
    runHook postInstall
  '';
})
