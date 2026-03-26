{ lib }:

rec {
  # Parse source string "github:owner/repo" -> { owner, repo }
  parseSource =
    source:
    let
      afterColon = lib.last (lib.splitString ":" source);
      parts = lib.splitString "/" afterColon;
    in
    {
      owner = lib.elemAt parts 0;
      repo = lib.elemAt parts 1;
    };

  # Get skill name from skill path
  # "plugins/deepwiki-cli/skills/deepwiki-cli" -> "deepwiki-cli"
  # "." -> null (caller should use repo name)
  getSkillName =
    skillPath:
    if skillPath == "." || skillPath == "" then
      null
    else
      lib.last (lib.splitString "/" skillPath);

  # Build pname from owner, repo, and skill name
  # "owner" "repo" "skill-name" -> "owner.repo.skill-name"
  mkPname =
    owner: repo: skillName:
    "${owner}.${repo}.${skillName}";

  # Split pname into path segments (max 3 parts)
  # "a.b.c" -> ["a" "b" "c"]
  # "a.b.c.d.e" -> ["a" "b" "c.d.e"]
  splitPname =
    pname:
    let
      parts = lib.splitString "." pname;
    in
    if lib.length parts <= 3 then
      parts
    else
      (lib.take 2 parts) ++ [ (lib.concatStringsSep "." (lib.drop 2 parts)) ];

  # Recursively merge a list of attrsets
  recursiveMergeAttrs =
    listOfAttrs:
    lib.zipAttrsWith (
      name: values: if lib.all lib.isAttrs values then recursiveMergeAttrs values else lib.last values
    ) listOfAttrs;
}
