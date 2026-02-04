{
  fetchFromGitHub,
  stdenvNoCC,
  validateSkillHook,
}:

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
  pname = "skill-${builtins.replaceStrings ["."] ["-"] pname}";
  version = builtins.substring 0 7 rev;

  src = fetchFromGitHub {
    inherit owner repo rev hash;
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
