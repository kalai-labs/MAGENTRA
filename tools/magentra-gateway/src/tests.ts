/**
 * Test discovery — the second half of SPEC §11 step 6, and the answer to
 * "the gateway cannot see my tests".
 *
 * WHAT THIS FILE IS. The half of §11 step 6 that had not been built. §2.1
 * defines a record's `tests` as "test ids present in
 * `tests/features/<id>.test.ts`" and `status` as derived from it — but nothing
 * read that directory, so the array was a hand-typed copy of a fact nobody
 * checked and `covered` was unreachable by construction.
 *
 * NO FALSE GREEN HAD HAPPENED YET, and this file is not a repair of one. On
 * 2026-09-10 all 164 arrays were empty and `tests/features/` did not exist, so
 * "no tests. This feature is unproven" was the correct answer for every record;
 * the gap was that it was also the ONLY answer available. What was latent is
 * that a hand-typed id would have read as coverage with nothing behind it —
 * FEATURES.md's failure moved into the inventory, where the tool built to catch
 * it could not look. Discovery is what makes the answer come from the files.
 *
 * WHY THE FILES ARE PARSED AND NEVER RUN. decisions/0006 took the runner out
 * of the gateway: the implementing agent runs tests, this tool does not. So
 * discovery is STATIC. Nothing here imports a test module either — importing
 * one calls `node:test`'s `test()`, which outside the runner executes it, and a
 * gateway that spawns an Electron `ui` test to find out that it exists is a
 * gateway nobody leaves open.
 *
 * WHY THE TYPESCRIPT AST AND NOT A REGEX. A hand-rolled scanner would be the
 * second parser SPEC §6 refuses on the same grounds for the import graph, and
 * this one has to survive an alias (`import { ProcTest as Base }`), an
 * inherited property, a `const` used for an invariant shared by two tests, and
 * `"proc" as const`. A regex reading any of those wrong FAILS SILENTLY — it
 * reports a feature as untested, which looks exactly like the truth. `typescript`
 * is already the repo's own compiler and a root devDependency; the parser is
 * used, not the type checker, so nothing here needs a build to have run.
 *
 * WHAT IT REFUSES TO GUESS. A class whose `featureId`, `id` or `whyItExists`
 * cannot be read statically, a class that is never registered, a bare
 * `node:test` call outside the hierarchy, a file whose name does not match the
 * feature it tests — each becomes a named problem carrying its file and line.
 * None of them is skipped, because a silently skipped test file is the one
 * state this file exists to make impossible.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import type { Feature, FeatureProof, Kind } from "./schema.js";
import { repoRoot } from "./registry.js";

/** One test file per feature id, per decisions/0004's layout. */
export function testsDir(root = repoRoot()): string {
  return join(root, "tests", "features");
}

/**
 * The kind hierarchy's class names, mirrored from `tests/lib/`.
 *
 * A MIRRORED PAIR in the sense BIG-PICTURE §16 uses — the class names live in
 * `tests/lib/*.ts` and this map is the only other place they are written. It is
 * deliberate: `tests/lib` may not import the gateway (a broken tool must never
 * mean no tests, tests/README rule 5), so the gateway is the side that carries
 * the copy. A kind base renamed in `tests/lib` and not here does not fail
 * quietly — every test extending it becomes "extends an unknown base class",
 * named with its file and line, because {@link KIND_BY_BASE_CLASS} is also the
 * list of what counts as a test at all.
 */
const KIND_BY_BASE_CLASS: Readonly<Record<string, Kind>> = {
  PureTest: "pure",
  FsTest: "fs",
  ProcTest: "proc",
  NetTest: "net",
  LlmTest: "llm",
  UiTest: "ui",
};

/** `node:test`'s own entry points. A test file calling one directly is outside the hierarchy — see {@link TestProblem}. */
const BARE_TEST_CALLS = new Set(["test", "it", "describe", "suite"]);

/** The function a test file must call for its classes to run. */
const REGISTRAR = "registerFeatureTests";

export interface DiscoveredTest {
  readonly featureId: string;
  readonly id: string;
  readonly kind: Kind;
  readonly whyItExists: string;
  /** As written in the test file. Compared against the record's, which is the source of truth. */
  readonly invariant: string;
  readonly className: string;
  /** Repo-relative, so a message names the file to open. */
  readonly file: string;
  readonly line: number;
  /**
   * Whether the class is passed to `registerFeatureTests`. An unregistered
   * class never runs, so it never counts as coverage — it is a problem instead.
   */
  readonly registered: boolean;
}

export interface TestProblem {
  readonly file: string;
  readonly line?: number;
  readonly detail: string;
}

export interface TestInventory {
  readonly tests: readonly DiscoveredTest[];
  /** Files read. Zero means `tests/features/` is empty or absent — which is a fact, not a problem. */
  readonly scanned: number;
  readonly problems: readonly TestProblem[];
}

/* ---- literal resolution --------------------------------------------- */

/**
 * The value of an expression, if it can be known without running anything.
 *
 * Handles what a test actually writes: a string, a plain template, `as const`,
 * a parenthesis, two literals added, and a module-level `const` referred to by
 * name — the last of which is how two tests on one feature share an invariant.
 * Anything else returns undefined and becomes a problem naming the property,
 * never a guess.
 */
function literalOf(expr: ts.Expression | undefined, consts: ReadonlyMap<string, string>): string | undefined {
  if (expr === undefined) return undefined;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isParenthesizedExpression(expr)) {
    return literalOf(expr.expression, consts);
  }
  if (ts.isIdentifier(expr)) return consts.get(expr.text);
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalOf(expr.left, consts);
    const right = literalOf(expr.right, consts);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

/* ---- one file -------------------------------------------------------- */

interface LocalClass {
  readonly name: string;
  /** The identifier it extends, already mapped through any import alias. */
  readonly extendsName: string | undefined;
  readonly props: ReadonlyMap<string, string | undefined>;
  /** Property names present but unreadable — reported precisely rather than as "missing". */
  readonly unreadable: readonly string[];
  /**
   * `abstract class` — scaffolding, not a test. A shared base holding the
   * `featureId` and `invariant` of two tests legitimately declares neither `id`
   * nor `whyItExists`, and reporting it as an incomplete test would train the
   * reader to ignore the report. Its subclasses are what discovery emits, and
   * {@link propOf} walks up into it for what they inherit.
   */
  readonly isAbstract: boolean;
  readonly line: number;
}

const REQUIRED_PROPS = ["featureId", "id", "whyItExists", "invariant"] as const;

function scanFile(rel: string, text: string): { tests: DiscoveredTest[]; problems: TestProblem[] } {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true);
  const problems: TestProblem[] = [];
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  // `import { ProcTest as Base }` — the local name is what a heritage clause
  // says, the imported name is what this file's map knows.
  const aliases = new Map<string, string>();
  const consts = new Map<string, string>();
  const classes = new Map<string, LocalClass>();
  const registered = new Set<string>();

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause?.namedBindings !== undefined && ts.isNamedImports(stmt.importClause.namedBindings)) {
      for (const spec of stmt.importClause.namedBindings.elements) {
        aliases.set(spec.name.text, (spec.propertyName ?? spec.name).text);
      }
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const value = literalOf(decl.initializer, consts);
          if (value !== undefined) consts.set(decl.name.text, value);
        }
      }
    }
  }

  for (const stmt of sf.statements) {
    const decl = ts.isClassDeclaration(stmt) ? stmt : undefined;
    if (decl === undefined || decl.name === undefined) continue;

    const extended = decl.heritageClauses
      ?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
      ?.types[0]?.expression;
    const extendsRaw = extended !== undefined && ts.isIdentifier(extended) ? extended.text : undefined;

    const props = new Map<string, string | undefined>();
    const unreadable: string[] = [];
    for (const member of decl.members) {
      if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) continue;
      const name = member.name.text;
      const value = literalOf(member.initializer, consts);
      props.set(name, value);
      if (value === undefined && REQUIRED_PROPS.includes(name as (typeof REQUIRED_PROPS)[number])) unreadable.push(name);
    }

    classes.set(decl.name.text, {
      name: decl.name.text,
      extendsName: extendsRaw === undefined ? undefined : aliases.get(extendsRaw) ?? extendsRaw,
      props,
      unreadable,
      isAbstract: (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Abstract) !== 0,
      line: lineOf(decl),
    });
  }

  // `registerFeatureTests(new A(), new B())`, anywhere in the file.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (callee === REGISTRAR) {
        for (const arg of node.arguments) {
          if (ts.isNewExpression(arg) && ts.isIdentifier(arg.expression)) registered.add(arg.expression.text);
          else {
            problems.push({
              file: rel,
              line: lineOf(arg),
              detail:
                `${REGISTRAR} is called with something other than \`new SomeTest()\`, so discovery cannot tell which tests it registers. ` +
                `Pass the instances directly — the inventory reads this call to know what actually runs.`,
            });
          }
        }
      } else if (BARE_TEST_CALLS.has(callee) && classes.size === 0) {
        // Only worth saying when there is no class here at all: a file that has
        // both is using a helper, and the classes are what discovery reads.
        problems.push({
          file: rel,
          line: lineOf(node),
          detail:
            `calls \`${callee}()\` from node:test directly. A test outside the class hierarchy carries no featureId, invariant or whyItExists, ` +
            `so the inventory cannot see it and nothing can say what it proves (SPEC §3). Extend a kind class and register it.`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  /** Walk the local extends chain to the kind base, so an intermediate class in the same file still resolves. */
  const kindOf = (start: LocalClass): Kind | undefined => {
    const seen = new Set<string>();
    let current: LocalClass | undefined = start;
    while (current !== undefined && !seen.has(current.name)) {
      seen.add(current.name);
      const base = current.extendsName;
      if (base === undefined) return undefined;
      const kind = KIND_BY_BASE_CLASS[base];
      if (kind !== undefined) return kind;
      current = classes.get(base);
    }
    return undefined;
  };

  /** A property may be declared on a local intermediate base; take the nearest definition. */
  const propOf = (start: LocalClass, name: string): { value: string | undefined; declared: boolean } => {
    const seen = new Set<string>();
    let current: LocalClass | undefined = start;
    while (current !== undefined && !seen.has(current.name)) {
      seen.add(current.name);
      if (current.props.has(name)) return { value: current.props.get(name), declared: true };
      current = current.extendsName === undefined ? undefined : classes.get(current.extendsName);
    }
    return { value: undefined, declared: false };
  };

  const tests: DiscoveredTest[] = [];
  for (const cls of classes.values()) {
    if (cls.isAbstract) continue;
    const kind = kindOf(cls);
    if (kind === undefined) {
      // Abstract helpers in a test file are ordinary; only say something when
      // the class is plainly meant to be a test and its base is not known.
      if (cls.extendsName !== undefined && !classes.has(cls.extendsName)) {
        problems.push({
          file: rel,
          line: cls.line,
          detail:
            `class ${cls.name} extends "${cls.extendsName}", which is not one of the kind base classes ` +
            `(${Object.keys(KIND_BY_BASE_CLASS).join(", ")}). Tests inherit on kind (decisions/0004); a class outside that hierarchy is invisible to the inventory.`,
        });
      }
      continue;
    }

    const resolved: Record<string, string> = {};
    const missing: string[] = [];
    const unreadable: string[] = [];
    for (const name of REQUIRED_PROPS) {
      const { value, declared } = propOf(cls, name);
      if (value !== undefined) resolved[name] = value;
      else if (declared) unreadable.push(name);
      else missing.push(name);
    }

    if (missing.length > 0 || unreadable.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`does not declare ${missing.join(", ")}`);
      if (unreadable.length > 0) {
        parts.push(
          `declares ${unreadable.join(", ")} as something this reader cannot resolve without running the file ` +
            `(a call, an interpolated template, a getter) — write a string literal, or a module-level const holding one`,
        );
      }
      problems.push({
        file: rel,
        line: cls.line,
        detail: `class ${cls.name} is a "${kind}" test but ${parts.join("; and ")}. Until then the inventory cannot say which feature it proves or why it exists.`,
      });
      continue;
    }

    const isRegistered = registered.has(cls.name);
    if (!isRegistered) {
      problems.push({
        file: rel,
        line: cls.line,
        detail:
          `class ${cls.name} is never passed to ${REGISTRAR}(), so it does not run. ` +
          `It is counted as absent, not as coverage — a test that cannot run is the ticked box with nothing behind it.`,
      });
    }

    tests.push({
      featureId: resolved["featureId"]!,
      id: resolved["id"]!,
      kind,
      whyItExists: resolved["whyItExists"]!,
      invariant: resolved["invariant"]!,
      className: cls.name,
      file: rel,
      line: cls.line,
      registered: isRegistered,
    });
  }

  // A file in tests/features/ exists in order to hold a test. Yielding none,
  // with nothing else to say about it, must not be silent: the parser does not
  // throw on a syntax error, it returns a tree with no declarations in it — so
  // a broken file and an empty one look identical to everything above, and both
  // look exactly like "this feature has no test".
  if (tests.length === 0 && problems.length === 0) {
    problems.push({
      file: rel,
      detail:
        "no test class extending a kind base was found in this file, so nothing in it is visible to the inventory. " +
        "A syntax error, an empty file, and a class outside the hierarchy all look like this — check that `npm test` can run it.",
    });
  }

  // decisions/0004's layout: one file per feature id, named for it.
  const stem = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.test\.ts$/, "");
  for (const t of tests) {
    if (t.featureId !== stem) {
      problems.push({
        file: rel,
        line: t.line,
        detail:
          `class ${t.className} proves feature "${t.featureId}" from a file named for "${stem}". ` +
          `The layout is one file per feature id (decisions/0004) — move it to tests/features/${t.featureId}.test.ts.`,
      });
    }
  }

  return { tests, problems };
}

/* ---- the directory --------------------------------------------------- */

/**
 * Every test in `tests/features/`, read statically.
 *
 * An absent directory is legitimately empty — no test has been written yet —
 * and is not a problem, the same way `loadDescriptions` treats its folder.
 */
export function discoverTests(root = repoRoot()): TestInventory {
  const dir = testsDir(root);
  if (!existsSync(dir)) return { tests: [], scanned: 0, problems: [] };

  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort();
  } catch (err) {
    return {
      tests: [],
      scanned: 0,
      problems: [{ file: "tests/features/", detail: `cannot be read — ${err instanceof Error ? err.message : String(err)}` }],
    };
  }

  const tests: DiscoveredTest[] = [];
  const problems: TestProblem[] = [];
  for (const entry of entries) {
    const rel = `tests/features/${entry}`;
    let text: string;
    try {
      text = readFileSync(join(dir, entry), "utf8");
    } catch (err) {
      problems.push({ file: rel, detail: `cannot be read — ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const found = scanFile(rel, text);
    tests.push(...found.tests);
    problems.push(...found.problems);
  }

  // Two tests answering to one id would make the record's `tests` array
  // ambiguous, and `--test-name-pattern` would run both.
  const byKey = new Map<string, DiscoveredTest>();
  for (const t of tests) {
    const key = `${t.featureId}/${t.id}`;
    const first = byKey.get(key);
    if (first !== undefined) {
      problems.push({
        file: t.file,
        line: t.line,
        detail: `test id "${t.id}" is already used for this feature by ${first.className} at ${first.file}:${first.line} — an id is unique within its feature.`,
      });
    } else byKey.set(key, t);
  }

  return { tests, scanned: entries.length, problems };
}

/* ---- what the records say vs what the files hold ---------------------- */

/**
 * Proof per feature id, for {@link deriveStatus}. Only REGISTERED tests count:
 * a class that is never handed to the registrar does not run, and a status
 * derived from it would be the fabrication this tool exists to catch.
 */
export function proofByFeature(inventory: TestInventory): Map<string, FeatureProof> {
  const out = new Map<string, { ids: Set<string>; kinds: Set<Kind> }>();
  for (const t of inventory.tests) {
    if (!t.registered) continue;
    let entry = out.get(t.featureId);
    if (entry === undefined) {
      entry = { ids: new Set(), kinds: new Set() };
      out.set(t.featureId, entry);
    }
    entry.ids.add(t.id);
    entry.kinds.add(t.kind);
  }
  return new Map([...out].map(([id, v]) => [id, { ids: v.ids, kinds: v.kinds } satisfies FeatureProof]));
}

export interface TestDrift {
  /** Ids the record claims that no test file defines — a tick with nothing behind it. */
  readonly recordedWithoutTest: readonly string[];
  /** Tests that exist and run but the record does not list. */
  readonly testedWithoutRecord: readonly string[];
  /** A test whose `invariant` no longer matches the record's. */
  readonly invariantMismatch: readonly { readonly id: string; readonly inTest: string }[];
  readonly agrees: boolean;
}

/**
 * The record's `tests` array against the files — the drift check that makes the
 * array worth keeping.
 *
 * §2.1 defines the array as the ids present in the test file, so the file is
 * the referent and the array is a stored copy of it. `recordedWithoutTest` is
 * the failure mode that matters: it is exactly a ticked box, and nothing before
 * this could see one.
 */
export function driftOf(feature: Feature, inventory: TestInventory): TestDrift {
  const mine = inventory.tests.filter((t) => t.featureId === feature.id);
  const runnable = mine.filter((t) => t.registered);
  const recorded = new Set(feature.tests);
  const found = new Set(runnable.map((t) => t.id));

  const recordedWithoutTest = [...recorded].filter((id) => !found.has(id)).sort();
  const testedWithoutRecord = [...found].filter((id) => !recorded.has(id)).sort();
  const invariantMismatch = runnable
    .filter((t) => t.invariant !== feature.invariant)
    .map((t) => ({ id: t.id, inTest: t.invariant }));

  return {
    recordedWithoutTest,
    testedWithoutRecord,
    invariantMismatch,
    agrees: recordedWithoutTest.length === 0 && testedWithoutRecord.length === 0 && invariantMismatch.length === 0,
  };
}
