// Minimal, dependency-free Markdown → DOM renderer for assistant messages.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.
//
// Builds real DOM nodes (never innerHTML), so model output — which is
// untrusted text — cannot inject markup. Covers what a coding assistant
// actually emits: fenced code blocks, inline code, headings, bold/italic,
// links (as inert text + href label), ordered/unordered lists, blockquotes,
// and horizontal rules. Anything it does not recognize survives as plain text.

// ---------------------------------------------------------------------------
// Inline: code spans, bold, italic, links — within one block of text
// ---------------------------------------------------------------------------

/**
 * The closing `$` of an inline formula opening at `start`, or -1 when this is
 * not mathematics at all.
 *
 * The guards are what keep money out of the parser: "it costs $5, not $7" must
 * stay text. TeX's own convention is the test — no space after the opening
 * delimiter, none before the closing one — plus a refusal to close immediately
 * before a digit, which is what a second price looks like.
 */
function findInlineMathEnd(text, start) {
  const first = text[start + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  for (let k = start + 1; k < text.length; k++) {
    if (text[k] === "\\") {
      k++; // an escaped character can never be the closing delimiter
      continue;
    }
    if (text[k] !== "$") continue;
    if (/\s/.test(text[k - 1])) return -1;
    if (/[0-9]/.test(text[k + 1] ?? "")) return -1;
    return k > start + 1 && looksLikeMath(text.slice(start + 1, k)) ? k : -1;
  }
  return -1;
}

/**
 * Whether the text between two `$` delimiters is plausibly a formula.
 *
 * The delimiter rules alone are not enough. "costs $5, not $7 — see `$x$`" has a
 * perfectly well-formed pair of delimiters spanning ordinary prose, so without
 * this the sentence renders as mathematics. Requiring a positive signal is what
 * makes the common case — money — stay text.
 */
function looksLikeMath(content) {
  // A code span can never be inside a formula; if one is, the delimiters
  // belong to different constructs and this is prose.
  if (content.includes("`")) return false;
  // A TeX command, a script, a group or a relation is unambiguous.
  if (/[\\^_{}=<>+/]/.test(content)) return true;
  // Otherwise only a compact token qualifies: `$x$`, `$a-b$`, `$f(n)$`. Prose
  // between two dollar signs always carries a space or a comma.
  return !/[\s,]/.test(content);
}

/** Append inline-formatted `text` to `parent`. Code spans win over everything
 * (their contents are literal); then math, then links, then bold, then italic. */
function renderInline(parent, text) {
  let i = 0;
  const flushText = (s) => {
    if (s) parent.appendChild(document.createTextNode(s));
  };
  let plainStart = 0;

  while (i < text.length) {
    const ch = text[i];

    // inline code — literal until the matching backtick, no nesting
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flushText(text.slice(plainStart, i));
        const code = document.createElement("code");
        code.textContent = text.slice(i + 1, end);
        parent.appendChild(code);
        i = end + 1;
        plainStart = i;
        continue;
      }
    }

    // inline math $…$ — checked after code spans so `$x$` inside backticks
    // stays literal, which is what a reader writing about TeX expects.
    if (ch === "$" && text[i + 1] !== "$") {
      const end = findInlineMathEnd(text, i);
      if (end !== -1) {
        flushText(text.slice(plainStart, i));
        parent.appendChild(renderMath(text.slice(i + 1, end), false));
        i = end + 1;
        plainStart = i;
        continue;
      }
    }

    // inline math \(…\) — the unambiguous form, with no currency problem
    if (ch === "\\" && text[i + 1] === "(") {
      const end = text.indexOf("\\)", i + 2);
      if (end !== -1) {
        flushText(text.slice(plainStart, i));
        parent.appendChild(renderMath(text.slice(i + 2, end), false));
        i = end + 2;
        plainStart = i;
        continue;
      }
    }

    // link [label](url)
    if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      if (close !== -1 && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd !== -1) {
          const label = text.slice(i + 1, close);
          const url = text.slice(close + 2, urlEnd);
          flushText(text.slice(plainStart, i));
          const a = document.createElement("a");
          a.className = "md-link";
          a.textContent = label;
          // Inert by default (CSP blocks navigation anyway); the href is shown
          // so the destination is visible without being clickable-dangerous.
          a.title = url;
          parent.appendChild(a);
          i = urlEnd + 1;
          plainStart = i;
          continue;
        }
      }
    }

    // bold **...** or __...__
    if ((ch === "*" && text[i + 1] === "*") || (ch === "_" && text[i + 1] === "_")) {
      const marker = ch + ch;
      const end = text.indexOf(marker, i + 2);
      if (end !== -1) {
        flushText(text.slice(plainStart, i));
        const strong = document.createElement("strong");
        renderInline(strong, text.slice(i + 2, end));
        parent.appendChild(strong);
        i = end + 2;
        plainStart = i;
        continue;
      }
    }

    // italic *...* or _..._ (single marker, not part of a double)
    if ((ch === "*" || ch === "_") && text[i + 1] !== ch) {
      const end = text.indexOf(ch, i + 1);
      if (end !== -1 && text[end - 1] !== ch) {
        flushText(text.slice(plainStart, i));
        const em = document.createElement("em");
        renderInline(em, text.slice(i + 1, end));
        parent.appendChild(em);
        i = end + 1;
        plainStart = i;
        continue;
      }
    }

    i++;
  }
  flushText(text.slice(plainStart));
}

// ---------------------------------------------------------------------------
// Block: fences, headings, lists, quotes, rules, paragraphs
// ---------------------------------------------------------------------------

function makeCodeBlock(lines, lang) {
  const pre = document.createElement("pre");
  pre.className = "md-code";
  const code = document.createElement("code");
  if (lang) code.dataset.lang = lang;
  code.textContent = lines.join("\n");
  pre.appendChild(code);
  return pre;
}

/**
 * Splits one GFM table row into trimmed cells. A pipe escaped as `\|` is
 * content, not a separator — the only way to put a literal pipe in a cell.
 */
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);

  const cells = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (s[k] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += s[k];
    }
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Per-column alignment when `line` is a table delimiter row (`|---|:--:|`),
 * else null — which is also what tells the block parser this is not a table.
 */
function tableAlignments(line) {
  if (!line || !line.includes("-")) return null;
  const cells = splitTableRow(line);
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    aligns.push(left && right ? "center" : right ? "right" : left ? "left" : "");
  }
  return aligns;
}

/** Builds one table; cells carry inline markdown, so `**x**` and `code` work. */
function makeTable(headerCells, aligns, bodyRows) {
  const table = document.createElement("table");
  table.className = "md-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headerCells.forEach((cell, idx) => {
    const th = document.createElement("th");
    if (aligns[idx]) th.style.textAlign = aligns[idx];
    renderInline(th, cell);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of bodyRows) {
    const tr = document.createElement("tr");
    // Ragged rows are common in generated markdown; pad or drop the overflow
    // so the table stays rectangular instead of rendering a broken grid.
    for (let idx = 0; idx < headerCells.length; idx++) {
      const td = document.createElement("td");
      if (aligns[idx]) td.style.textAlign = aligns[idx];
      renderInline(td, row[idx] ?? "");
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  // A wide table must scroll inside its own column rather than stretching the
  // transcript, which would push the whole conversation sideways.
  const wrap = document.createElement("div");
  wrap.className = "md-table-wrap";
  wrap.appendChild(table);
  return wrap;
}

/** True when `lines[i]` starts a GFM table (header row + delimiter beneath). */
function tableStartsAt(lines, i) {
  if (i + 1 >= lines.length || !lines[i].includes("|")) return null;
  const aligns = tableAlignments(lines[i + 1]);
  if (!aligns) return null;
  const header = splitTableRow(lines[i]);
  // GFM requires the delimiter to have exactly as many cells as the header;
  // holding that line is what keeps ordinary prose containing a "|" out.
  return aligns.length === header.length ? { header, aligns } : null;
}

/** Render `md` into a DocumentFragment of block-level elements. */
function renderMarkdown(md) {
  const frag = document.createDocumentFragment();
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block ``` or ~~~
    const fence = line.match(/^(```+|~~~+)(.*)$/);
    if (fence) {
      const marker = fence[1][0].repeat(3);
      const lang = fence[2].trim();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(marker)) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (or run off the end — unterminated is fine)
      frag.appendChild(makeCodeBlock(body, lang));
      continue;
    }

    // display math $$…$$ or \[…\] — checked AFTER the fence branch, so a `$$`
    // inside a code block is shown as source rather than rendered.
    const mathOpen = line.match(/^\s*(\$\$|\\\[)\s*(.*)$/);
    if (mathOpen) {
      const closing = mathOpen[1] === "$$" ? "$$" : "\\]";
      const body = [];
      const sameLineEnd = mathOpen[2].indexOf(closing);
      if (sameLineEnd !== -1) {
        body.push(mathOpen[2].slice(0, sameLineEnd));
        i++;
      } else {
        if (mathOpen[2].trim()) body.push(mathOpen[2]);
        i++;
        while (i < lines.length && !lines[i].includes(closing)) {
          body.push(lines[i]);
          i++;
        }
        if (i < lines.length) {
          const tail = lines[i].slice(0, lines[i].indexOf(closing));
          if (tail.trim()) body.push(tail);
          i++; // consume the closing line (or run off the end — unterminated is fine)
        }
      }
      const wrap = document.createElement("div");
      wrap.className = "md-math-wrap";
      wrap.appendChild(renderMath(body.join("\n"), true));
      frag.appendChild(wrap);
      continue;
    }

    // blank line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // horizontal rule
    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) {
      frag.appendChild(document.createElement("hr"));
      i++;
      continue;
    }

    // heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const h = document.createElement("h" + heading[1].length);
      h.className = "md-h";
      renderInline(h, heading[2].trim());
      frag.appendChild(h);
      i++;
      continue;
    }

    // blockquote (consecutive > lines)
    if (/^ {0,3}>/.test(line)) {
      const quote = document.createElement("blockquote");
      quote.className = "md-quote";
      const inner = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        inner.push(lines[i].replace(/^ {0,3}>\s?/, ""));
        i++;
      }
      for (const child of renderMarkdown(inner.join("\n")).childNodes) quote.appendChild(child);
      frag.appendChild(quote);
      continue;
    }

    // table (header row + delimiter row, then rows until a blank/pipe-less line)
    const table = tableStartsAt(lines, i);
    if (table) {
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        body.push(splitTableRow(lines[i]));
        i++;
      }
      frag.appendChild(makeTable(table.header, table.aligns, body));
      continue;
    }

    // list (consecutive item lines of the same family)
    const isUl = /^ {0,3}[-*+]\s+/.test(line);
    const isOl = /^ {0,3}\d+[.)]\s+/.test(line);
    if (isUl || isOl) {
      const list = document.createElement(isOl ? "ol" : "ul");
      list.className = "md-list";
      while (
        i < lines.length &&
        (isOl ? /^ {0,3}\d+[.)]\s+/.test(lines[i]) : /^ {0,3}[-*+]\s+/.test(lines[i]))
      ) {
        const li = document.createElement("li");
        renderInline(li, lines[i].replace(isOl ? /^ {0,3}\d+[.)]\s+/ : /^ {0,3}[-*+]\s+/, ""));
        list.appendChild(li);
        i++;
      }
      frag.appendChild(list);
      continue;
    }

    // paragraph — gather until a blank line or a block starter
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(```+|~~~+)/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^ {0,3}>/.test(lines[i]) &&
      !/^ {0,3}[-*+]\s+/.test(lines[i]) &&
      !/^ {0,3}\d+[.)]\s+/.test(lines[i]) &&
      // display math may follow prose directly, with no blank line between
      !/^\s*(\$\$|\\\[)/.test(lines[i]) &&
      // a table may follow prose directly, with no blank line between
      !tableStartsAt(lines, i)
    ) {
      para.push(lines[i]);
      i++;
    }
    const p = document.createElement("p");
    p.className = "md-p";
    renderInline(p, para.join("\n"));
    frag.appendChild(p);
  }

  return frag;
}
