# Inventory method

Built by reading every source file line by line, area by area, persisting
findings after each area so a context compaction cannot degrade the result.

Surface read: 36,410 lines.
  engine/  18,405 (.ts, excl. dist)
  app/     14,011 (.js/.html, excl. node_modules/build-resources/dist)
  tui/      3,994 (.ts/.tsx, src only)
  tools/    version lib + prompt-lab server (counted separately)

Cross-check target: FEATURES.md claims 112 features in 13 sections.
Task: verify that count, and add MAGENTRA's tooling (version tool, prompt-lab)
which FEATURES.md omits entirely.
