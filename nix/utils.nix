{ lib }:

rec {
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

  # Get skill name from pname (last segment after splitPname)
  # "a.b.c" -> "c"
  # "a.b.c.d.e" -> "c.d.e"
  getSkillName = pname: lib.last (splitPname pname);

  # Recursively merge a list of attrsets
  recursiveMergeAttrs =
    listOfAttrs:
    lib.zipAttrsWith (
      name: values: if lib.all lib.isAttrs values then recursiveMergeAttrs values else lib.last values
    ) listOfAttrs;
}
