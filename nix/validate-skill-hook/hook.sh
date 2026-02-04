# shellcheck shell=bash

appendToVar preCheckHooks validateSkillHook

validateSkillHook() {
    echo "Validating skill..."
    skills-ref validate "$PWD"
}
