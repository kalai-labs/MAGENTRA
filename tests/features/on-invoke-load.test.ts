/**
 * `on-invoke-load`.
 *
 * Only an addon's name and description ride in the system prompt; the `Addon`
 * tool is the one moment its body is paid for. It returns the invocation
 * header plus the body with every `$ARGUMENTS` replaced — or an `ARGUMENTS:`
 * line appended when the body has no placeholder and args were given — and
 * lists a directory addon's bundled files. A name not in the roster is an
 * error that lists the real names, so the model recovers instead of inventing.
 *
 * `pure`: the tool is a function of its input and of the roster on
 * `ctx.session.addons`. It reads no file — the roster it is handed is the
 * loaded one — so the real tool runs here with the real header builder and a
 * roster built in the test.
 */

import { addonInvocationHeader, type Addon, type ToolContext } from "@magentra/core";
import { addonTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "on-invoke-load";

/** Verbatim from the record. */
const INVARIANT = "The Addon tool returns the body, substitutes $ARGUMENTS or appends args, and errors with the real roster on an unknown name.";

function addon(name: string, body: string, resources: string[] = []): Addon {
  return { name, description: `the ${name} addon`, body, resources, source: "workspace", path: `/ws/.magentra/addons/${name}.md` };
}

abstract class AddonToolTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected ctx(roster: Addon[]): ToolContext {
    return { cwd: "/ws", session: strictServices({ addons: roster }) };
  }

  protected async invoke(roster: Addon[], input: { addon: string; args?: string }): Promise<{ text: string; isError: boolean }> {
    const result = await runTool(addonTool, input, this.ctx(roster));
    return { text: resultText(result), isError: result.isError === true };
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class EveryPlaceholderIsSubstituted extends AddonToolTest {
  readonly id = "every-arguments-placeholder-in-the-body-is-replaced-with-the-args";
  readonly whyItExists = "a single-replace left the second $ARGUMENTS literal in the procedure, so the model followed an instruction that still said '$ARGUMENTS' where the task should have been";

  override async run(t: TestRun): Promise<void> {
    const { text, isError } = await this.invoke([addon("foo", "Do $ARGUMENTS then $ARGUMENTS")], { addon: "foo", args: "X" });
    t.assert.equal(isError, false);
    t.assert.ok(text.includes("Do X then X"), text);
    t.assert.equal(text.includes("$ARGUMENTS"), false, "no placeholder survives");
    t.assert.equal(text.includes("ARGUMENTS:"), false, "with a placeholder present no ARGUMENTS line is appended");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ArgsAreAppendedWhenThereIsNoPlaceholder extends AddonToolTest {
  readonly id = "without-a-placeholder-args-are-appended-as-an-arguments-line-and-omitted-args-add-nothing";
  readonly whyItExists = "args passed to an addon whose body had no placeholder were silently dropped, so '/review the auth module' reviewed nothing in particular";

  override async run(t: TestRun): Promise<void> {
    const roster = [addon("foo", "Review the code carefully.")];
    const withArgs = await this.invoke(roster, { addon: "foo", args: "X" });
    t.assert.ok(withArgs.text.endsWith("Review the code carefully.\nARGUMENTS: X"), withArgs.text);
    const withoutArgs = await this.invoke(roster, { addon: "foo" });
    t.assert.ok(withoutArgs.text.endsWith("Review the code carefully."), "no ARGUMENTS line when none were given");
    t.assert.equal(withoutArgs.text.includes("ARGUMENTS"), false);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnUnknownNameListsTheRoster extends AddonToolTest {
  readonly id = "an-unknown-addon-is-an-error-naming-the-installed-addons-or-none-installed";
  readonly whyItExists = "a bare 'unknown addon' sent the model guessing plausible names for several rounds; the list lets it pick a real one in the next call";

  override async run(t: TestRun): Promise<void> {
    const missing = await this.invoke([addon("foo", "a"), addon("bar", "b")], { addon: "missing" });
    t.assert.equal(missing.isError, true);
    t.assert.equal(missing.text, 'Unknown addon "missing". Available addons: foo, bar.');
    const empty = await this.invoke([], { addon: "missing" });
    t.assert.equal(empty.isError, true);
    t.assert.equal(empty.text, 'Unknown addon "missing". Available addons: (none installed).');
    // Names match exactly — the model is told to copy them from the list.
    const wrongCase = await this.invoke([addon("foo", "a")], { addon: "Foo" });
    t.assert.equal(wrongCase.isError, true, "the lookup is exact, as the description tells the model to copy the name verbatim");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheHeaderComesFirst extends AddonToolTest {
  readonly id = "the-content-opens-with-the-invocation-header-naming-the-addon";
  readonly whyItExists = "the addon body arriving without the header let a relentless procedure outrank the user's own later instructions, because nothing said the user ranked above it";

  override async run(t: TestRun): Promise<void> {
    const { text } = await this.invoke([addon("foo", "Body here.")], { addon: "foo" });
    t.assert.ok(text.startsWith("<system-reminder>"), "the content opens with the reminder block");
    t.assert.ok(text.includes('The "foo" addon was invoked'), "the header names the addon");
    t.assert.ok(text.includes("The user outranks them in turn"), "and the user's precedence over the addon");
    t.assert.ok(text.includes("</system-reminder>\n<command-name>/foo</command-name>\n"), "the command-name tag follows the reminder");
    t.assert.ok(text.startsWith(addonInvocationHeader("foo")), "it is the ONE shared header both invocation paths use, verbatim");
    t.assert.ok(text.endsWith("Body here."), "and the body follows it");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class BundledFilesAreListedNotInlined extends AddonToolTest {
  readonly id = "a-directory-addons-resources-are-listed-in-a-reminder-and-a-flat-addon-has-no-such-block";
  readonly whyItExists = "inlining a directory addon's notes and scripts put kilobytes of reference material into the turn; naming them lets the model Read only the ones the procedure points at";

  override async run(t: TestRun): Promise<void> {
    const bundled = await this.invoke([addon("kit", "Use the notes.", ["x/notes.md", "x/scripts/run.sh"])], { addon: "kit" });
    t.assert.ok(bundled.text.includes("<system-reminder>Files bundled with this addon"), bundled.text);
    t.assert.ok(bundled.text.includes("\n- x/notes.md\n- x/scripts/run.sh</system-reminder>"), "each resource is one dash line, paths as given");
    t.assert.ok(bundled.text.indexOf("Use the notes.") < bundled.text.indexOf("Files bundled"), "the body comes before the file list");
    const flat = await this.invoke([addon("flat", "Just do it.")], { addon: "flat" });
    t.assert.equal(flat.text.includes("Files bundled"), false, "a flat addon has no bundled-files block");
  }
}

registerFeatureTests(new EveryPlaceholderIsSubstituted(), new ArgsAreAppendedWhenThereIsNoPlaceholder(), new AnUnknownNameListsTheRoster(), new TheHeaderComesFirst(), new BundledFilesAreListedNotInlined());
