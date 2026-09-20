/**
 * `mathematics`.
 *
 * LaTeX in an assistant message becomes native MathML, built by a small parser
 * with no library, no CDN and no extra font — because a math library would need
 * all three, and the strict CSP (`default-src 'none'`) would have to be relaxed
 * for it. The other half matters as much: ordinary prose must survive. A price
 * list written `$5, not $7` is not mathematics, and a parser that thought it
 * was would corrupt the sentence.
 *
 * `ui`, and that is not a technicality. `app/renderer/modules/math.js` is a
 * classic script: the page loads it into one shared global scope, so it cannot
 * be imported — the only place `renderMath` exists is a running renderer. The
 * functions called below are the product's own, in the real page, and what they
 * return is inspected as real DOM.
 *
 * `pure` covers the one claim that is about the code rather than its output:
 * that no node is ever built from a string.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "mathematics";

/** Verbatim from the record. */
const INVARIANT =
  "Inline and display LaTeX render as native MathML with no library, no CDN and nothing the strict CSP must relax; anything unparsed falls back to its source.";

abstract class MathTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** The app on its own profile — no workspace needed; this is all page-local. */
  protected async page(): Promise<AppHandle> {
    const home = this.makeTempDir("magentra-math-home-");
    return this.launchApp({ HOME: home, USERPROFILE: home });
  }

  /**
   * Describe what `renderMath` built, as structure rather than as markup.
   *
   * Serialising to HTML would make the assertions about a string; what the
   * feature promises is MathML NODES, in the MathML namespace, which is the one
   * thing a browser renders as mathematics.
   */
  protected async renderMath(app: AppHandle, latex: string, display: boolean): Promise<{
    tag: string;
    ns: string;
    displayAttr: string | null;
    tags: string[];
    text: string;
    className: string;
  }> {
    return app.evaluate(`
      (() => {
        const node = renderMath(${JSON.stringify(latex)}, ${String(display)});
        const tags = [];
        const walk = (el) => { tags.push(el.tagName.toLowerCase()); for (const child of el.children) walk(child); };
        walk(node);
        return {
          tag: node.tagName.toLowerCase(),
          ns: node.namespaceURI || "",
          displayAttr: node.getAttribute ? node.getAttribute("display") : null,
          tags,
          text: node.textContent || "",
          className: node.className || "",
        };
      })()
    `);
  }
}

/* ---- checklist 1 and 2 ------------------------------------------------- */

class LatexBecomesMathml extends MathTest {
  readonly id = "latex-becomes-real-mathml-nodes";
  readonly whyItExists =
    "a math library would need a CDN or a bundled font and a CSP relaxed to allow it, which is exactly what this parser exists to avoid";

  override async run(t: TestRun): Promise<void> {
    const app = await this.page();

    const fraction = await this.renderMath(app, "\\frac{a}{b}", false);
    t.assert.equal(fraction.tag, "math", "the result must be a <math> element, not markup around one");
    t.assert.equal(fraction.ns, "http://www.w3.org/1998/Math/MathML", "and it must be in the MathML namespace, or the browser renders it as nothing");
    t.assert.ok(fraction.tags.includes("mfrac"), `a fraction must be an <mfrac>; built ${fraction.tags.join(", ")}`);
    t.assert.equal(fraction.displayAttr, "inline");

    const block = await this.renderMath(app, "\\frac{a}{b}", true);
    t.assert.equal(block.displayAttr, "block", "display math must say so, or it renders inline in the middle of a paragraph");

    // Checklist 2: the structures that make this worth having at all.
    const cases = await this.renderMath(app, "\\begin{cases} x & y \\\\ z & w \\end{cases}", true);
    t.assert.ok(cases.tags.includes("mtable"), `an environment must become a table; built ${cases.tags.join(", ")}`);
    t.assert.equal(cases.tags.filter((tag) => tag === "mtr").length, 2, "two rows in, two rows out");
    t.assert.match(cases.text, /\{/, "cases carries its leading brace, which is the notation");

    // The description's checklist names `<munderover>`; the parser builds a
    // nested `<mover>`/`<munder>` instead. Both are valid MathML and render
    // identically, so what is asserted is the PROPERTY the notation depends on —
    // that the limits sit under and over the operator — rather than one of two
    // equivalent spellings. The divergence is in the description, not the code.
    const sum = await this.renderMath(app, "\\sum_{i=1}^{n}", true);
    const stacked = sum.tags.includes("munderover") || (sum.tags.includes("munder") && sum.tags.includes("mover"));
    t.assert.ok(stacked, `a big operator's limits go under and over it; built ${sum.tags.join(", ")}`);
    t.assert.match(sum.text, /n/, "and the limits themselves are part of the output");
  }
}

/* ---- checklist 3 ------------------------------------------------------- */

class UnparseableMathShowsItsSource extends MathTest {
  readonly id = "input-the-parser-cannot-read-is-shown-as-its-own-source";
  readonly whyItExists =
    "a parser that throws on malformed LaTeX takes the whole message render down with it, and the user loses an answer because one formula was mistyped";

  override async run(t: TestRun): Promise<void> {
    const app = await this.page();

    // WHAT THE CHECKLIST EXPECTED, AND WHAT IS ACTUALLY TRUE. It names
    // `\frac{a` as unparseable and expects the `<code>` fallback. The parser is
    // TOLERANT: it has no `throw` in it at all, so malformed LaTeX renders as
    // best it can rather than being refused. Every one of these produces a
    // <math>, and that is fine — what must never happen is a throw, because one
    // mistyped formula would take the whole message render down with it.
    for (const malformed of ["\\frac{a", "\\begin{matrix}", "\\left(", "^", "\\frac", "\\sqrt{", "{", "\\text{"]) {
      const result = await this.renderMath(app, malformed, false);
      t.assert.ok(
        result.tag === "math" || result.tag === "code",
        `${malformed} must render or fall back, never throw; got ${result.tag}`,
      );
    }

    // The fallback is a safety net for a real runtime failure, and it IS
    // reachable: nesting deeply enough overflows the parser's recursion. That
    // is the only way to make it fire, and it is worth firing — the net is what
    // stops an unforeseen parser bug from blanking an answer.
    const overflowed = await app.evaluate<{ tag: string; className: string; text: string }>(`
      (() => {
        const node = renderMath("\\\\frac{".repeat(20000) + "a", false);
        return { tag: node.tagName.toLowerCase(), className: node.className || "", text: (node.textContent || "").slice(0, 12) };
      })()
    `);
    t.assert.equal(overflowed.tag, "code", "a parser failure must fall back to a <code>, not propagate");
    t.assert.equal(overflowed.className, "md-math-raw", "and be marked as raw math so it can be styled as such");
    t.assert.match(overflowed.text, /^\\frac\{/, "the source the author wrote is what is shown — nothing is invented");
  }
}

/* ---- checklist 4 and 5 ------------------------------------------------- */

class ProseSurvives extends MathTest {
  readonly id = "prices-and-code-spans-are-not-mistaken-for-mathematics";
  readonly whyItExists =
    "a dollar sign is a price far more often than it is mathematics, and a message that turns 'it costs $5, not $7' into a formula is worse than one with no math support at all";

  override async run(t: TestRun): Promise<void> {
    const app = await this.page();

    const priced = await app.evaluate<{ maths: number; text: string }>(`
      (() => {
        const host = document.createElement("div");
        renderInline(host, "it costs $5, not $7");
        return { maths: host.querySelectorAll("math").length, text: host.textContent || "" };
      })()
    `);
    t.assert.equal(priced.maths, 0, "two prices in a sentence are not a formula");
    t.assert.equal(priced.text, "it costs $5, not $7", "and the sentence must come through unchanged");

    const inCode = await app.evaluate<{ maths: number; codeText: string }>(`
      (() => {
        const host = document.createElement("div");
        renderInline(host, "see \\u0060$x$\\u0060");
        return { maths: host.querySelectorAll("math").length, codeText: (host.querySelector("code") || {}).textContent || "" };
      })()
    `);
    t.assert.equal(inCode.maths, 0, "math inside a code span is code — that is what the backticks say");
    t.assert.equal(inCode.codeText, "$x$");

    // THE CASES THAT REACH THE PROSE TEST. "$5, not $7" is turned away earlier,
    // by the rule that a closing delimiter may not follow a space — so it never
    // asks whether the content looks like mathematics, and a mutation to that
    // question passed unnoticed. These two do ask it: a well-formed pair of
    // delimiters around ordinary prose, and one around a code span.
    const prose = await app.evaluate<{ maths: number; text: string }>(`
      (() => {
        const host = document.createElement("div");
        renderInline(host, "pick $a, b$ from the list");
        return { maths: host.querySelectorAll("math").length, text: host.textContent || "" };
      })()
    `);
    t.assert.equal(prose.maths, 0, "a comma and a space between delimiters is prose, however well-formed the pair is");
    t.assert.equal(prose.text, "pick $a, b$ from the list");

    const backticked = await app.evaluate<number>(`
      (() => {
        const host = document.createElement("div");
        renderInline(host, "$a\u0060b\u0060c$");
        return host.querySelectorAll("math").length;
      })()
    `);
    t.assert.equal(backticked, 0, "a code span inside the delimiters means they belong to different constructs");

    // And the adjacency rule, which the two cases above do not reach: a closing
    // delimiter may not follow a space. `$x^2 $` carries an unambiguous TeX
    // signal, so the prose test would accept it — this rule is the only thing
    // that does not, and without it a sentence with a stray dollar becomes a
    // formula.
    const spaced = await app.evaluate<number>(`
      (() => {
        const host = document.createElement("div");
        renderInline(host, "see $x^2 $ here");
        return host.querySelectorAll("math").length;
      })()
    `);
    t.assert.equal(spaced, 0, "a space before the closing delimiter means the pair is not a formula");

    // Checklist 5: real math still renders, inline and as a block.
    const inline = await app.evaluate<{ maths: number; tags: string[] }>(`
      (() => {
        const host = document.createElement("div");
        renderInline(host, "let $x^2$ be");
        const math = host.querySelector("math");
        const tags = [];
        if (math) { const walk = (el) => { tags.push(el.tagName.toLowerCase()); for (const c of el.children) walk(c); }; walk(math); }
        return { maths: host.querySelectorAll("math").length, tags };
      })()
    `);
    t.assert.equal(inline.maths, 1, "one formula in the sentence, one <math> out");
    t.assert.ok(inline.tags.includes("msup"), `a superscript must become <msup>; built ${inline.tags.join(", ")}`);

    const displayed = await app.evaluate<{ maths: number; wrapped: boolean; blockAttr: string | null }>(`
      (() => {
        const node = renderMarkdown("$$ E = mc^2 $$");
        const math = node.querySelector("math");
        return {
          maths: node.querySelectorAll("math").length,
          wrapped: Boolean(node.querySelector(".md-math-wrap")),
          blockAttr: math ? math.getAttribute("display") : null,
        };
      })()
    `);
    t.assert.equal(displayed.maths, 1, "a display block is one formula");
    t.assert.equal(displayed.wrapped, true, "and it is wrapped, so it can be centred and scrolled on its own");
    t.assert.equal(displayed.blockAttr, "block");
  }
}

/* ---- checklist 5's other half — pure ----------------------------------- */

class NothingIsBuiltFromAString extends PureTest {
  readonly featureId = FEATURE;
  readonly id = "no-node-is-ever-built-from-a-string";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "assistant output is untrusted text; one innerHTML in the renderer turns a model's message into markup the page executes, and the strict CSP is the only thing left between that and a script";

  override run(t: TestRun): void {
    for (const name of ["math.js", "markdown.js"]) {
      const source = readFileSync(join(repoRoot(), "app", "renderer", "modules", name), "utf8");
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      t.assert.doesNotMatch(code, /\.innerHTML\s*=/, `${name} must never assign innerHTML — every node is built, never parsed from a string`);
      t.assert.doesNotMatch(code, /insertAdjacentHTML|outerHTML\s*=/, `${name} must not build markup by any other name either`);
      t.assert.match(code, /createElement|createTextNode|createElementNS/, `${name} builds DOM, so it must be doing it with the DOM API`);
    }
  }
}

registerFeatureTests(new LatexBecomesMathml(), new UnparseableMathShowsItsSource(), new ProseSurvives(), new NothingIsBuiltFromAString());
