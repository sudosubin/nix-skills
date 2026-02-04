(import (
  let
    lock = builtins.fromJSON (builtins.readFile ./flake.lock);
    nodeName = lock.nodes.root.inputs.nixpkgs;
  in
  fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/${lock.nodes.${nodeName}.locked.rev}.tar.gz";
    sha256 = lock.nodes.${nodeName}.locked.narHash;
  }
) { }).callPackage ./nix/build-skill.nix { }
