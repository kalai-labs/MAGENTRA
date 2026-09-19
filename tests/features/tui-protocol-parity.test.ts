/**
 * `tui-protocol-parity`.
 *
 * `tui/src/protocol.ts` is a hand-copied subset of the wire contract in
 * `engine/protocol/src/types.ts`, and nothing generates or checks it. A field
 * renamed or an event dropped on the engine side compiles fine in the TUI and
 * fails only at runtime, by silently ignoring or misreading frames — on the
 * seam this repository calls its most dangerous.
 *
 * `pure`. Both files are read as SOURCE with the TypeScript compiler API —
 * the same parser the gateway uses to discover these tests — and compared
 * arm by arm: every discriminant the TUI declares must exist on the engine
 * side, every property the TUI reads must exist on the matching engine arm
 * with the same optionality or stricter, and the compiler itself is asked
 * whether an engine event is assignable to the TUI's type (it must be) and
 * whether the reverse holds (it must not, for exactly the documented loose
 * catch-all arm). Neither file has an import, so the check needs no build.
 *
 * RED ON 2026-09-19, BY DESIGN (tests/README rule 4). Checklist item 5 fails:
 * the engine declares `background_notification.payload: unknown` while the
 * TUI's copy narrows it to `payload?: { description?, code?, outputFile?,
 * stopped? }`, so an engine event is NOT assignable to the TUI's type. The TUI
 * asserts a shape the wire never promised; the fix is either a real payload
 * type on the engine side or `unknown` plus narrowing in
 * `tui/src/engine/useEngine.ts`, and both touch files outside this record's
 * entry files, so the test stays red until the product owner decides which.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "tui-protocol-parity";

/** Verbatim from the record. */
const INVARIANT = "PROTOCOL_VERSION and every event and request type in the TUI's copy match engine/protocol.";

const ENGINE = "engine/protocol/src/types.ts";
const TUI = "tui/src/protocol.ts";

/** One arm of a discriminated union: its `type` literals and the properties it declares. */
interface Arm {
  readonly types: string[];
  readonly props: Map<string, { optional: boolean; text: string }>;
}

function parse(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, readFileSync(join(repoRoot(), rel), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** A top-level `export type Name = A | B | …` as its arms. */
function unionArms(file: ts.SourceFile, name: string): Arm[] {
  const decl = file.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === name);
  if (!decl) throw new Error(`${file.fileName} declares no type alias ${name}`);
  const members = ts.isUnionTypeNode(decl.type) ? decl.type.types : [decl.type];
  return members.map((member) => {
    if (!ts.isTypeLiteralNode(member)) throw new Error(`${file.fileName}: an arm of ${name} is not an object literal type: ${member.getText(file)}`);
    const props = new Map<string, { optional: boolean; text: string }>();
    let types: string[] = [];
    for (const m of member.members) {
      if (!ts.isPropertySignature(m) || !m.name || !ts.isIdentifier(m.name) || !m.type) continue;
      const key = m.name.text;
      if (key === "type") {
        const lits = ts.isUnionTypeNode(m.type) ? m.type.types : [m.type];
        types = lits.map((l) => (ts.isLiteralTypeNode(l) && ts.isStringLiteral(l.literal) ? l.literal.text : l.getText(file)));
        continue;
      }
      props.set(key, { optional: m.questionToken !== undefined, text: m.type.getText(file) });
    }
    return { types, props };
  });
}

function armFor(arms: Arm[], type: string): Arm | undefined {
  return arms.find((a) => a.types.includes(type));
}

function protocolVersion(file: ts.SourceFile): number {
  for (const s of file.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === "PROTOCOL_VERSION" && d.initializer && ts.isNumericLiteral(d.initializer)) return Number(d.initializer.text);
    }
  }
  throw new Error(`${file.fileName} declares no numeric PROTOCOL_VERSION`);
}

abstract class ParityTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheVersionsAgree extends ParityTest {
  readonly id = "protocol-version-is-the-same-number-in-both-files";
  readonly whyItExists = "the TUI refuses a session whose `v` differs from its own constant, so a bump on one side alone locks the TUI out of every engine";

  override run(t: TestRun): void {
    const engine = protocolVersion(parse(ENGINE));
    const tui = protocolVersion(parse(TUI));
    t.assert.equal(tui, engine, `tui/src/protocol.ts says v${tui}, engine/protocol says v${engine}`);
    t.assert.ok(Number.isInteger(engine) && engine >= 1);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class EveryTuiEventExistsOnTheEngine extends ParityTest {
  readonly id = "every-event-discriminant-the-tui-declares-is-an-engine-event";
  readonly whyItExists = "an event the TUI handles but the engine no longer emits is dead UI code, and one renamed on the engine side falls through the TUI's default arm unseen";

  override run(t: TestRun): void {
    const engine = unionArms(parse(ENGINE), "CoreEvent").flatMap((a) => a.types);
    const tui = unionArms(parse(TUI), "CoreEvent").flatMap((a) => a.types);
    t.assert.ok(tui.length >= 25, `the TUI declares ${tui.length} event types`);
    const missing = tui.filter((type) => !engine.includes(type));
    t.assert.deepEqual(missing, [], `the TUI declares event types the engine does not emit: ${missing.join(", ")}`);
    t.assert.equal(new Set(engine).size, engine.length, "the engine union has no duplicate discriminant");
    // The description's list, so a TUI arm quietly removed is noticed too.
    for (const expected of ["session_started", "permission_request", "question_request", "turn_finished", "cwd_changed", "background_notification"]) {
      t.assert.ok(tui.includes(expected), `the TUI must still declare ${expected}`);
    }
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class EveryTuiRequestExistsOnTheEngine extends ParityTest {
  readonly id = "every-request-the-tui-sends-exists-on-the-engine-with-the-same-required-properties";
  readonly whyItExists = "a request the TUI sends with a property the engine renamed is accepted by the wire and ignored by the handler, so the user's action does nothing";

  override run(t: TestRun): void {
    const engine = unionArms(parse(ENGINE), "FrontendRequest");
    const tui = unionArms(parse(TUI), "FrontendRequest");
    t.assert.ok(tui.length >= 11, `the TUI sends ${tui.length} request types`);
    for (const arm of tui) {
      for (const type of arm.types) {
        const counterpart = armFor(engine, type);
        t.assert.notEqual(counterpart, undefined, `the engine has no request "${type}"`);
        for (const [prop, { optional, text }] of arm.props) {
          const theirs = counterpart?.props.get(prop);
          t.assert.notEqual(theirs, undefined, `${type}.${prop}: the engine's request has no such property`);
          if (!optional) t.assert.equal(theirs?.optional, false, `${type}.${prop}: required in the TUI but optional on the engine`);
          t.assert.equal(theirs?.text, text, `${type}.${prop}: the TUI writes its type as ${text}, the engine as ${String(theirs?.text)}`);
        }
        // Every property the engine REQUIRES must be one the TUI sends.
        for (const [prop, { optional }] of counterpart?.props ?? []) {
          if (!optional) t.assert.ok(arm.props.has(prop), `${type}.${prop}: the engine requires it and the TUI never sends it`);
        }
      }
    }
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class EveryFieldTheTuiReadsExists extends ParityTest {
  readonly id = "every-event-field-the-tui-reads-exists-on-the-engine-arm-and-is-no-more-optional-there";
  readonly whyItExists = "a field required in the TUI copy but optional on the engine is an `undefined` the TUI dereferences, and a field the engine dropped is one the TUI reads forever as missing";

  override run(t: TestRun): void {
    const engine = unionArms(parse(ENGINE), "CoreEvent");
    const tui = unionArms(parse(TUI), "CoreEvent");
    let checked = 0;
    for (const arm of tui) {
      // The documented catch-all arm declares no fields, so there is nothing to compare.
      if (arm.props.size === 0) continue;
      for (const type of arm.types) {
        const counterpart = armFor(engine, type);
        t.assert.notEqual(counterpart, undefined, `no engine arm for ${type}`);
        for (const [prop, { optional }] of arm.props) {
          const theirs = counterpart?.props.get(prop);
          t.assert.notEqual(theirs, undefined, `${type}.${prop}: the TUI reads it and the engine arm has no such field`);
          if (!optional) t.assert.equal(theirs?.optional, false, `${type}.${prop}: required in the TUI copy but optional on the engine`);
          checked += 1;
        }
      }
    }
    t.assert.ok(checked >= 40, `only ${checked} fields compared — the TUI copy has shrunk past what this test expects`);
    // The specific fields the description names.
    const expectations: [string, string][] = [
      ["cwd_changed", "worktree"],
      ["permission_request", "subject"],
      ["permission_request", "grant"],
      ["agent_spawned", "background"],
      ["session_started", "commands"],
      ["turn_finished", "usage"],
    ];
    for (const [type, prop] of expectations) {
      t.assert.ok(armFor(tui, type)?.props.has(prop), `the TUI reads ${type}.${prop}`);
      t.assert.ok(armFor(engine, type)?.props.has(prop), `the engine declares ${type}.${prop}`);
    }
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

/** Typecheck `text` as a virtual file beside the two real ones, returning the diagnostics' messages. */
function diagnosticsFor(text: string): string[] {
  const fixture = join(repoRoot(), "tests", "__tui-parity-fixture__.ts").replace(/\\/g, "/");
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (f) => (f.replace(/\\/g, "/") === fixture ? text : readFile(f));
  host.fileExists = (f) => f.replace(/\\/g, "/") === fixture || fileExists(f);
  const program = ts.createProgram([fixture], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

class TheCompilerAgreesOnAssignability extends ParityTest {
  readonly id = "an-engine-event-is-assignable-to-the-tui-type-and-the-reverse-fails-only-on-the-catch-all";
  readonly whyItExists = "name-by-name comparison cannot see a nested shape change (a Question option, a Usage field); asking tsc whether the engine's union assigns to the TUI's catches those";

  override run(t: TestRun): void {
    const header = `import type { CoreEvent as EngineEvent, FrontendRequest as EngineRequest } from "../engine/protocol/src/types.ts";
import type { CoreEvent as TuiEvent, FrontendRequest as TuiRequest } from "../tui/src/protocol.ts";
declare const engineEvent: EngineEvent;
declare const tuiEvent: TuiEvent;
declare const tuiRequest: TuiRequest;
`;
    // Engine → TUI: every engine event is a TUI event (the loose arm absorbs the ones it ignores);
    // every request the TUI sends is a request the engine accepts.
    const forward = diagnosticsFor(`${header}const a: TuiEvent = engineEvent;\nconst b: EngineRequest = tuiRequest;\nexport {};\n`);
    t.assert.deepEqual(forward, [], `an engine event must be assignable to the TUI's type, and a TUI request to the engine's:\n${forward.join("\n")}`);

    // TUI → engine: must FAIL, and only because of the documented catch-all arm,
    // which declares no fields for the events the TUI ignores.
    const reverse = diagnosticsFor(`${header}const c: EngineEvent = tuiEvent;\nexport {};\n`);
    t.assert.equal(reverse.length, 1, `exactly one error is expected, got ${reverse.length}:\n${reverse.join("\n")}`);
    t.assert.match(reverse[0] ?? "", /"file_edited" \| "addon_draft" \| "addon_export"|file_edited/, "the one failure is the loose catch-all arm, not a real field mismatch");
  }
}

registerFeatureTests(new TheVersionsAgree(), new EveryTuiEventExistsOnTheEngine(), new EveryTuiRequestExistsOnTheEngine(), new EveryFieldTheTuiReadsExists(), new TheCompilerAgreesOnAssignability());
