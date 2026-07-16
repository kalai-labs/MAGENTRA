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

/** Append inline-formatted `text` to `parent`. Code spans win over everything
 * (their contents are literal); then links, then bold, then italic. */
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
      !/^ {0,3}\d+[.)]\s+/.test(lines[i])
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
