// Dependency-free LaTeX → MathML renderer for assistant messages.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.
//
// WHY MathML AND NOT A LIBRARY
// Chromium ships MathML Core natively (Chrome 109+; this app runs Electron 33 =
// Chromium 130), so mathematics needs no KaTeX/MathJax bundle, no CDN, and no
// extra web font. That keeps the strict CSP in index.html intact
// (`default-src 'none'`), keeps the app working in an offline or air-gapped
// environment, and adds no third-party licence to the product.
//
// Like markdown.js this builds real DOM nodes and never touches innerHTML:
// LaTeX from a model is untrusted text and must never become markup.
//
// SCOPE. What an assistant actually writes: symbols, sub/superscripts,
// fractions, roots, operators with limits, function names, delimiters, text
// runs, and the common matrix/cases environments. Anything unrecognized falls
// back to the literal source rather than throwing — a formula that renders as
// its own LaTeX is readable; a crashed message is not.

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

function mel(name, text) {
  const el = document.createElementNS(MATHML_NS, name);
  if (text !== undefined) el.textContent = text;
  return el;
}

// ---------------------------------------------------------------------------
// Symbol tables
// ---------------------------------------------------------------------------

/** Named symbols → their Unicode character. */
const MATH_SYMBOLS = {
  // Greek, lower case
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ",
  tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  // Greek, upper case
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // Relations
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈",
  equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝",
  ll: "≪", gg: "≫", subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇",
  in: "∈", notin: "∉", ni: "∋",
  // Operators
  times: "×", div: "÷", pm: "±", mp: "∓", cdot: "⋅", ast: "∗", star: "⋆",
  circ: "∘", bullet: "∙", oplus: "⊕", otimes: "⊗", wedge: "∧", vee: "∨",
  cap: "∩", cup: "∪", setminus: "∖",
  // Arrows
  to: "→", rightarrow: "→", Rightarrow: "⇒", leftarrow: "←", Leftarrow: "⇐",
  leftrightarrow: "↔", Leftrightarrow: "⇔", mapsto: "↦", implies: "⟹", iff: "⟺",
  // Misc
  infty: "∞", partial: "∂", nabla: "∇", forall: "∀", exists: "∃", neg: "¬",
  emptyset: "∅", varnothing: "∅", aleph: "ℵ", hbar: "ℏ", ell: "ℓ", Re: "ℜ", Im: "ℑ",
  angle: "∠", perp: "⊥", parallel: "∥", therefore: "∴", because: "∵",
  ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", dots: "…",
  prime: "′", degree: "°", checkmark: "✓",
  // Blackboard-bold sets, written as one symbol rather than a font switch.
  mathbbR: "ℝ", mathbbN: "ℕ", mathbbZ: "ℤ", mathbbQ: "ℚ", mathbbC: "ℂ",
};

/** Operators that take limits above and below in display style. */
const BIG_OPERATORS = {
  sum: "∑", prod: "∏", coprod: "∐", bigcup: "⋃", bigcap: "⋂",
  bigoplus: "⨁", bigotimes: "⨂", bigvee: "⋁", bigwedge: "⋀",
};

/** Integrals: big operators whose limits sit beside them, not above. */
const INTEGRALS = { int: "∫", iint: "∬", iiint: "∭", oint: "∮" };

/** Names set upright, as function names rather than a product of variables. */
const FUNCTION_NAMES = [
  "sin", "cos", "tan", "cot", "sec", "csc",
  "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
  "log", "ln", "lg", "exp", "det", "dim", "ker", "deg", "gcd", "arg",
  "min", "max", "sup", "inf", "lim", "limsup", "liminf",
];

/** \left…\right delimiters, and the bare characters that may follow them. */
const DELIMITERS = {
  "(": "(", ")": ")", "[": "[", "]": "]", "\\{": "{", "\\}": "}",
  "|": "|", "\\|": "‖", "\\langle": "⟨", "\\rangle": "⟩",
  "\\lceil": "⌈", "\\rceil": "⌉", "\\lfloor": "⌊", "\\rfloor": "⌋",
  ".": "",
};

/** Matrix-like environments → the delimiters they are drawn inside. */
const MATRIX_ENVIRONMENTS = {
  matrix: ["", ""],
  pmatrix: ["(", ")"],
  bmatrix: ["[", "]"],
  Bmatrix: ["{", "}"],
  vmatrix: ["|", "|"],
  Vmatrix: ["‖", "‖"],
  cases: ["{", ""],
};

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Splits LaTeX into tokens: control sequences (`\frac`), single characters, and
 * grouping braces. Whitespace is dropped — in mathematics it is not content,
 * and `\text{…}` captures its own spacing before this ever sees it.
 */
function tokenizeLatex(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      // \\ is a row break; \, \; \: \! are spacing; \word is a named command.
      const name = /^[A-Za-z]+/.exec(src.slice(i + 1));
      if (name) {
        tokens.push({ type: "cmd", value: name[0] });
        i += 1 + name[0].length;
      } else {
        tokens.push({ type: "cmd", value: src[i + 1] ?? "" });
        i += 2;
      }
      continue;
    }
    if (ch === "{" || ch === "}") {
      tokens.push({ type: ch === "{" ? "open" : "close" });
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    tokens.push({ type: "char", value: ch });
    i++;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser — tokens → MathML nodes
// ---------------------------------------------------------------------------

/**
 * A cursor over the token list. Kept as a plain object rather than a class to
 * match the rest of the renderer modules.
 */
function makeReader(tokens) {
  return { tokens, pos: 0 };
}

function peek(reader) {
  return reader.tokens[reader.pos];
}

function next(reader) {
  return reader.tokens[reader.pos++];
}

/** Reads one group: `{…}` as its contents, or a single token standing alone. */
function readGroup(reader) {
  const token = peek(reader);
  if (!token) return [];
  if (token.type === "open") {
    reader.pos++;
    const nodes = parseSequence(reader, true);
    return nodes;
  }
  return parseAtom(reader);
}

/** Wraps a node list into a single node, using <mrow> only when needed. */
function asSingle(nodes) {
  if (nodes.length === 1) return nodes[0];
  const row = mel("mrow");
  for (const node of nodes) row.appendChild(node);
  return row;
}

/** True when a token ends the current row of a matrix or the whole environment. */
function isRowBreak(token) {
  return token && token.type === "cmd" && token.value === "\\";
}

function parseMatrix(reader, envName) {
  const rows = [];
  let row = [];
  let cell = [];
  const flushCell = () => {
    row.push(asSingle(cell.length ? cell : [mel("mrow")]));
    cell = [];
  };
  const flushRow = () => {
    flushCell();
    rows.push(row);
    row = [];
  };

  for (;;) {
    const token = peek(reader);
    if (!token) break;
    if (token.type === "cmd" && token.value === "end") {
      reader.pos++;
      readGroup(reader); // consume the environment name
      break;
    }
    if (isRowBreak(token)) {
      reader.pos++;
      flushRow();
      continue;
    }
    if (token.type === "char" && token.value === "&") {
      reader.pos++;
      flushCell();
      continue;
    }
    cell.push(...parseAtom(reader));
  }
  if (cell.length || row.length) flushRow();

  const table = mel("mtable");
  for (const cells of rows) {
    const tr = mel("mtr");
    for (const c of cells) {
      const td = mel("mtd");
      td.appendChild(c);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }

  const [open, close] = MATRIX_ENVIRONMENTS[envName] ?? ["", ""];
  if (!open && !close) return [table];
  const wrap = mel("mrow");
  if (open) {
    const o = mel("mo", open);
    o.setAttribute("stretchy", "true");
    wrap.appendChild(o);
  }
  wrap.appendChild(table);
  if (close) {
    const c = mel("mo", close);
    c.setAttribute("stretchy", "true");
    wrap.appendChild(c);
  }
  return [wrap];
}

/** Collects the literal characters of a group, for \text and friends. */
function readGroupAsText(reader) {
  const token = peek(reader);
  if (!token) return "";
  if (token.type !== "open") {
    const single = next(reader);
    return single.type === "cmd" ? `\\${single.value}` : (single.value ?? "");
  }
  reader.pos++;
  let out = "";
  let depth = 1;
  while (reader.pos < reader.tokens.length) {
    const t = reader.tokens[reader.pos++];
    if (t.type === "open") {
      depth++;
      out += "{";
    } else if (t.type === "close") {
      depth--;
      if (depth === 0) break;
      out += "}";
    } else if (t.type === "cmd") {
      // Inside text, a control sequence is almost always a space or an escape.
      out += t.value === "," || t.value === " " ? " " : t.value;
    } else {
      out += t.value;
    }
  }
  return out;
}

/** Parses one atom, returning the node(s) it produced. */
function parseAtom(reader) {
  const token = next(reader);
  if (!token) return [];

  if (token.type === "open") {
    reader.pos--;
    return [asSingle(readGroup(reader))];
  }
  if (token.type === "close") return [];

  if (token.type === "char") {
    const ch = token.value;
    if (/[0-9.]/.test(ch)) {
      // Keep a multi-digit number in ONE <mn>: split digits get letter spacing
      // between them and read as a product.
      let num = ch;
      while (peek(reader) && peek(reader).type === "char" && /[0-9.]/.test(peek(reader).value)) {
        num += next(reader).value;
      }
      return [mel("mn", num)];
    }
    if (/[A-Za-z]/.test(ch)) return [mel("mi", ch)];
    if (ch === "+" || ch === "-" || ch === "=" || ch === "<" || ch === ">" || ch === "/") {
      return [mel("mo", ch === "-" ? "−" : ch)];
    }
    if (ch === "(" || ch === ")" || ch === "[" || ch === "]" || ch === "|") return [mel("mo", ch)];
    if (ch === ",") return [mel("mo", ",")];
    return [mel("mo", ch)];
  }

  // token.type === "cmd"
  const name = token.value;

  if (name === "frac" || name === "dfrac" || name === "tfrac") {
    const num = asSingle(readGroup(reader));
    const den = asSingle(readGroup(reader));
    const frac = mel("mfrac");
    frac.appendChild(num);
    frac.appendChild(den);
    return [frac];
  }

  if (name === "sqrt") {
    // \sqrt[n]{x} — the optional index arrives as literal [ n ] tokens.
    if (peek(reader) && peek(reader).type === "char" && peek(reader).value === "[") {
      reader.pos++;
      const index = [];
      while (peek(reader) && !(peek(reader).type === "char" && peek(reader).value === "]")) {
        index.push(...parseAtom(reader));
      }
      reader.pos++; // consume "]"
      const root = mel("mroot");
      root.appendChild(asSingle(readGroup(reader)));
      root.appendChild(asSingle(index));
      return [root];
    }
    const sqrt = mel("msqrt");
    sqrt.appendChild(asSingle(readGroup(reader)));
    return [sqrt];
  }

  if (name === "text" || name === "textrm" || name === "mbox") {
    return [mel("mtext", readGroupAsText(reader))];
  }
  if (name === "mathrm" || name === "operatorname") {
    const el = mel("mi", readGroupAsText(reader));
    el.setAttribute("mathvariant", "normal");
    return [el];
  }
  if (name === "mathbf" || name === "bm" || name === "boldsymbol") {
    const el = mel("mi", readGroupAsText(reader));
    el.setAttribute("mathvariant", "bold");
    return [el];
  }
  if (name === "mathbb") {
    const inner = readGroupAsText(reader);
    return [mel("mi", MATH_SYMBOLS[`mathbb${inner}`] ?? inner)];
  }
  if (name === "mathit") {
    return [mel("mi", readGroupAsText(reader))];
  }

  if (name === "begin") {
    const env = readGroupAsText(reader);
    if (MATRIX_ENVIRONMENTS[env]) return parseMatrix(reader, env);
    // Unknown environment: parse its body inline rather than losing it.
    return [];
  }
  if (name === "end") {
    readGroupAsText(reader);
    return [];
  }

  if (name === "left" || name === "right") {
    const delimToken = next(reader);
    if (!delimToken) return [];
    const key = delimToken.type === "cmd" ? `\\${delimToken.value}` : delimToken.value;
    const glyph = DELIMITERS[key] ?? key;
    if (!glyph) return [];
    const op = mel("mo", glyph);
    op.setAttribute("stretchy", "true");
    return [op];
  }

  if (BIG_OPERATORS[name]) {
    // A sum or product stacks its limits above and below; an integral sets them
    // beside itself. `_underOver` is how the script parser below knows which.
    const op = mel("mo", BIG_OPERATORS[name]);
    op.setAttribute("movablelimits", "false");
    op._underOver = true;
    return [op];
  }
  if (INTEGRALS[name]) {
    return [mel("mo", INTEGRALS[name])];
  }
  if (FUNCTION_NAMES.includes(name)) {
    const el = mel("mi", name);
    el.setAttribute("mathvariant", "normal");
    // \lim carries its limit underneath; the trigonometric names do not.
    if (name.startsWith("lim")) el._underOver = true;
    return [el];
  }

  if (MATH_SYMBOLS[name]) {
    const glyph = MATH_SYMBOLS[name];
    // A letter-like constant is an identifier; everything else is an operator.
    return [/[α-ωΑ-Ωℝℕℤℚℂℵℏℓℜℑ]/.test(glyph) ? mel("mi", glyph) : mel("mo", glyph)];
  }

  // Spacing commands and anything unknown: contribute nothing rather than
  // breaking the formula around them.
  if (name === "," || name === ";" || name === ":" || name === "!" || name === " ") {
    return [mel("mspace")];
  }
  if (name === "\\") return [];
  return [mel("mi", name)];
}

/**
 * Parses a run of atoms, applying `_` and `^` to whatever precedes them.
 * `stopAtClose` ends the run at the matching `}` (a group), otherwise it runs
 * to the end of the token list.
 */
function parseSequence(reader, stopAtClose) {
  const nodes = [];
  while (reader.pos < reader.tokens.length) {
    const token = peek(reader);
    if (stopAtClose && token.type === "close") {
      reader.pos++;
      break;
    }
    if (token.type === "char" && (token.value === "_" || token.value === "^")) {
      reader.pos++;
      const script = asSingle(readGroup(reader));
      const base = nodes.pop() ?? mel("mrow");
      const isSub = token.value === "_";
      // A second script on the same base makes it a sub-AND-superscript.
      const existing = base.nodeName ? base.nodeName.toLowerCase() : "";
      if ((existing === "msub" && !isSub) || (existing === "msup" && isSub)) {
        const inner = base.firstChild;
        const other = base.lastChild;
        const combined = mel(base._underOver ? "munderover" : "msubsup");
        combined.appendChild(inner);
        combined.appendChild(isSub ? script : other);
        combined.appendChild(isSub ? other : script);
        combined._underOver = base._underOver;
        nodes.push(combined);
        continue;
      }
      const useUnderOver = base._underOver === true;
      const wrapper = mel(useUnderOver ? (isSub ? "munder" : "mover") : isSub ? "msub" : "msup");
      wrapper.appendChild(base);
      wrapper.appendChild(script);
      wrapper._underOver = useUnderOver;
      nodes.push(wrapper);
      continue;
    }
    nodes.push(...parseAtom(reader));
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Renders `latex` as a `<math>` element. `display` picks block style (limits
 * above/below, centred) over inline style.
 *
 * Never throws: on any failure the source is returned as a `<code>` element, so
 * a formula this parser does not understand still reaches the reader intact.
 */
function renderMath(latex, display) {
  try {
    const reader = makeReader(tokenizeLatex(String(latex)));
    const nodes = parseSequence(reader, false);
    const math = mel("math");
    math.setAttribute("display", display ? "block" : "inline");
    math.className = display ? "md-math md-math-block" : "md-math";
    const row = mel("mrow");
    for (const node of nodes) row.appendChild(node);
    math.appendChild(row);
    return math;
  } catch {
    const fallback = document.createElement("code");
    fallback.className = "md-math-raw";
    fallback.textContent = String(latex);
    return fallback;
  }
}
