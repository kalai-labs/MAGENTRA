---
name: GraphQuery
---
Query the workspace import graph to LOCATE code and judge IMPACT — a structural alternative to reading files one by one.

- slice: ranked minimal context for a topic. Give files and/or a query; returns the highest-relevance files (personalized PageRank) that fit a token budget, plus the edges among them. Use this instead of guessing which files to open.
- blast: what breaks if these files change — the transitive set of modules that import them, grouped by hop distance. Run before editing anything widely imported.
- deps: what a file relies on — its forward dependency closure, with external packages listed separately.
- structure: the skeleton of the repo — top files by PageRank, articulation points, bridges, component and file/edge counts. Use when you need the big picture before planning a change.
- rank: the most central files overall, or personalized to given seeds.

Seeds come from files (paths) and/or query (space-separated keywords, ANY substring match against paths). Results are computed from the import graph: they are structural, not semantic — a file the graph never links is invisible here.
