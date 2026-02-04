{ makeSetupHook, skills-ref }:

makeSetupHook {
  name = "validate-skill-hook";
  propagatedBuildInputs = [ skills-ref ];
} ./hook.sh
