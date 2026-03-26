# nix-skills

Nix expressions for AI agent skills from [skills.sh](https://skills.sh) and [skillsdirectory.com](https://www.skillsdirectory.com). A [GitHub Action](https://github.com/sudosubin/nix-skills/actions/workflows/update-skills.yml) updates the skills every 3 hours.

As of March 2026, this flake provides Nix derivations for over **480,000** skills sourced from nearly **13,000** GitHub repositories. Each **skill** is individually packaged, pinned to a specific revision, and made available through a nixpkgs overlay.

## Prerequisites

### (Optional) Enable flakes

Read about [Nix flakes](https://wiki.nixos.org/wiki/Flakes) and [set them up](https://wiki.nixos.org/wiki/Flakes#Setup).

## Overlay

Read about [Overlays](https://wiki.nixos.org/wiki/Overlays#Using_overlays).

### With flakes

Add `nix-skills` to your flake inputs:

```nix
{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    nix-skills.url = "github:sudosubin/nix-skills";
  };

  outputs = { nixpkgs, nix-skills, ... }:
    let
      pkgs = import nixpkgs {
        system = "aarch64-darwin"; # or "x86_64-linux", etc.
        overlays = [ nix-skills.overlays.default ];
      };
    in
    {
      # pkgs.skills.<owner>.<repo>.<skill-name>
    };
}
```

### Without flakes

```nix
let
  nix-skills = import (builtins.fetchGit {
    url = "https://github.com/sudosubin/nix-skills";
    ref = "refs/heads/main";
  });

  pkgs = import <nixpkgs> {
    overlays = [ nix-skills.overlays.default ];
  };
in
  # pkgs.skills.<owner>.<repo>.<skill-name>
```

## Usage

### Get `skills`

#### Get `skills` via the overlay

After applying the overlay (see [Overlay](#overlay)), skills are available under `pkgs.skills`:

```nix
pkgs.skills.<owner>.<repo>.<skill-name>
```

#### Get `skills` from `nix-skills` directly

Without the overlay, you can access skills from the flake outputs:

```nix
nix-skills.skills.${system}.<owner>.<repo>.<skill-name>
```

### Skill identifiers

Skills are organized in a three-level hierarchy: `<owner>.<repo>.<skill-name>`.

- `owner` — GitHub repository owner (e.g., `vercel-labs`)
- `repo` — GitHub repository name (e.g., `skills`)
- `skill-name` — skill directory name (e.g., `find-skills`)

For example, a skill from the repository `vercel-labs/skills` would be accessed as:

```nix
pkgs.skills.vercel-labs.skills.find-skills
```

> [!NOTE]
> If a skill identifier contains characters that aren't valid Nix identifiers, quote them like `pkgs.skills."01000001-01001110"."agent-jira-skills"."jira-issues"`.

### Example: install a skill for claude-code

```nix
# home-manager configuration
{ pkgs, ... }:

{
  programs.claude-code = {
    enable = true;
    skills = {
      find-skills = pkgs.skills.vercel-labs.skills.find-skills;
    };
  };
}
```

### Example: install a skill for pi

```nix
# home-manager configuration
{ pkgs, ... }:

{
  home.file.".pi/agent/skills/find-skills" = {
    source = pkgs.skills.vercel-labs.skills.find-skills;
    recursive = true;
  };
}
```

### Rename a skill

Each skill derivation supports `.override { name = "..."; }` to change the skill name. This updates both the derivation `pname` and the `name` field in `SKILL.md` frontmatter.

```nix
pkgs.skills.vercel-labs.skills.find-skills.override { name = "my-find-skills"; }
```

## Explore

### List available skills in REPL

```console
$ nix repl

nix-repl> :lf github:sudosubin/nix-skills

nix-repl> skills = outputs.skills.${builtins.currentSystem}

nix-repl> skills.vercel-labs.skills
{ find-skills = «derivation ...»; ... }

nix-repl> skills.vercel-labs.skills.find-skills
«derivation /nix/store/...-find-skills-4f1d38e.drv»
```

### Build a skill

```console
nix build github:sudosubin/nix-skills#skills.aarch64-darwin.vercel-labs.skills.find-skills
```

## How it works

1. A GitHub Actions workflow runs every 3 hours.
2. It fetches the latest skill listings from [skills.sh](https://skills.sh) and [skillsdirectory.com](https://www.skillsdirectory.com).
3. For each source repository, it resolves the latest commit, prefetches the tarball via `nix-prefetch-url`, and discovers all `SKILL.md` files.
4. The results are stored in `data/by-name/` as JSON files.
5. At evaluation time, Nix reads these JSON files and builds each skill using `fetchFromGitHub` with the pinned revision and hash.

## License

[MIT](LICENSE)