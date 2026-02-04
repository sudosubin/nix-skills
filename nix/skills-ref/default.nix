{ fetchFromGitHub, python3Packages }:

python3Packages.buildPythonApplication {
  pname = "skills-ref";
  version = "0.1.0";

  src = fetchFromGitHub {
    owner = "agentskills";
    repo = "agentskills";
    rev = "547831f3a23724ba64a9b79bbf59c5e0bc8f2d1a";
    hash = "sha256-IXBMz0P4lxKxjFCNpzQQNIOqXsOZ+oiJJ9CvQJKPQaU=";
  };

  sourceRoot = "source/skills-ref";

  pyproject = true;

  build-system = [
    python3Packages.hatchling
  ];

  propagatedBuildInputs = [
    python3Packages.click
    python3Packages.strictyaml
  ];
}
