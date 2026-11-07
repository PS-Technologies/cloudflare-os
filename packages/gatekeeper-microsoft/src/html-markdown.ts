// A small HTML-to-Markdown converter, for SharePoint pages and (after outlook-content.ts cleans it)
// mail: paragraphs, headings, emphasis, links, lists, tables, quotes, code, and line breaks. It
// tokenizes rather than parses, never evaluates anything, and drops what it does not know (scripts
// and styles with their content), so any HTML is safe to feed it. The output is for an agent to
// read, not to render.

/**
 * Named character references decoded, each spelled as a browser spells it (`&AMP;`, not `&Amp;`):
 * common ones, and every one that stands for an ASCII character, so a `style` attribute's CSS reads
 * as a browser reads it. Numeric references are always decoded; unknown names are kept.
 */
const ENTITIES: Record<string, string> = {
  amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">", quot: "\"", QUOT: "\"", apos: "'", nbsp: "\u00a0", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", copy: "©", COPY: "©", reg: "®", REG: "®", trade: "™", TRADE: "™",
  Tab: "\t", NewLine: "\n", excl: "!", num: "#", dollar: "$", percnt: "%", lpar: "(", rpar: ")", ast: "*", midast: "*", plus: "+", comma: ",",
  period: ".", sol: "/", colon: ":", semi: ";", equals: "=", quest: "?", commat: "@", lsqb: "[", lbrack: "[", bsol: "\\", rsqb: "]", rbrack: "]",
  Hat: "^", lowbar: "_", UnderBar: "_", grave: "`", DiacriticalGrave: "`", lcub: "{", lbrace: "{", verbar: "|", vert: "|", VerticalLine: "|",
  rcub: "}", rbrace: "}", fjlig: "fj",
};

/**
 * A character reference as a browser's tokenizer reads one in an attribute: a number, its `;`
 * optional; a name and `;`; or, of the names a browser reads without one, one not followed by a
 * letter, digit or `=`. `/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi` needed every `;`, and read
 * names in any case, so `&quot` with no `;` was no quote, and `&Quot;` was one.
 */
const REFERENCE = /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*);|(amp|AMP|lt|LT|gt|GT|quot|QUOT|nbsp|copy|COPY|reg|REG)(?![A-Za-z0-9=]))/g;

/** Decodes character references in text or an attribute's value. */
export function decodeEntities(text: string): string {
  return text.replace(REFERENCE, (match, hex?: string, decimal?: string, name?: string, bare?: string) => {
    if (hex === undefined && decimal === undefined) return Object.hasOwn(ENTITIES, (name ?? bare)!) ? ENTITIES[(name ?? bare)!]! : match;
    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(decimal!, 10);
    // Lone surrogates, NUL and numbers past Unicode become the replacement character rather than invalid strings.
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\uFFFD";
  });
}

/** One piece of tokenized HTML: raw (undecoded) text, an opening tag with decoded attributes, or a closing tag. */
export type Token =
  | { type: "text"; text: string }
  | { type: "open"; tag: string; attrs: Record<string, string>; legacy?: Record<string, string>; selfClosing: boolean }
  | { type: "close"; tag: string };

/** Elements a browser reads as text up to their own end tag: a tag or comment inside one is text. */
const RAW_TEXT = new Set(["iframe", "noembed", "noframes", "plaintext", "script", "style", "textarea", "title", "xmp"]);
/** Of those, the ones whose text is kept, as a text token between their tags; <plaintext> runs to the end. */
const KEPT_TEXT = new Set(["plaintext", "textarea", "title", "xmp"]);
/**
 * Elements dropped with everything in them, which is read as markup to their matching end tag, so a
 * tag or comment inside one counts: an HTML <template>'s content is inert, and <noscript>, SVG and
 * MathML hold nothing for the agent.
 */
const DROPPED = new Set(["math", "noscript", "svg", "template"]);
/**
 * In SVG or MathML, the start tags a browser reads as HTML, ending the SVG or MathML at that tag, and
 * the elements of each whose content it reads as HTML (its integration points, but for <title>, read
 * as raw text, and MathML's <annotation-xml>, one only with some encodings). An HTML element opened
 * by either can stay open past the end tag read here as the SVG's end.
 */
const BREAKOUT = new Set(["b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt", "em", "embed", "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "i", "img", "li", "listing", "menu", "meta", "nobr", "ol", "p", "pre", "ruby", "s", "small", "span", "strike", "strong", "sub", "sup", "table", "tt", "u", "ul", "var"]);
const INTEGRATION = { svg: new Set(["desc", "foreignobject"]), math: new Set(["mi", "mn", "mo", "ms", "mtext"]) };
/**
 * Start tags that, read as HTML inside SVG or MathML, change what is outside it: <html> and <body>
 * give the page's own their attributes, <frameset> can replace the body, and a <form> in an open form
 * is ignored but for its end tag, which the open form's then can't close.
 */
const OUTSIDE = new Set(["body", "form", "frameset", "html"]);

/** A stylesheet in a document, and whether only its rules that would hide are read: for one a browser may not apply, or may read otherwise. */
export type Sheet = { css: string; hidingOnly: boolean };
/** What {@link tokenize} gathers to read a document's styles: its stylesheets, and whether any of it can't be read as a browser may read it. */
export type Styles = { sheets: Sheet[]; unreadable: boolean };
/** Elements that never have content or a closing tag. */
export const VOID: ReadonlySet<string> = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);

/** Text lower-cased as HTML and CSS lower-case names, ASCII only: `toLowerCase` makes a Kelvin sign a `k`. */
export const asciiLowerCase = (text: string) => text.replace(/[A-Z]+/g, letters => letters.toLowerCase());

/**
 * A tag's attributes by name, lower-cased in ASCII, as a browser's tokenizer reads them: a name runs
 * to whitespace, `/`, `>` or `=`, and an unquoted value to whitespace. Of two with one name, a
 * browser keeps the first. Before, a name was lower-cased in Unicode, so `\u212A` (a Kelvin sign)
 * was a `k`, and JavaScript's whitespace (a no-break space) ended names and values.
 */
function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\t\n\f\r />][^\t\n\f\r />=]*)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r >]*)))?/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const name = asciiLowerCase(match[1]);
    if (!Object.hasOwn(attrs, name)) attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/** The named references the reader before this one decoded, in any case and only with a `;`. */
const LEGACY_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
};

/**
 * A tag's attributes as the reader before this one read them, where they differ from `attrs`: the
 * mail converter reads what that reader hid by them too. A name or unquoted value ended by
 * JavaScript's whitespace (a no-break space) and by quotes, a name lower-cased as JavaScript
 * lower-cases it (`\u212A`, a Kelvin sign, is a `k`), the last of a name kept, and a reference decoded
 * only with its `;`, its name in any case.
 */
function legacyAttributes(source: string, attrs: Record<string, string>): Record<string, string> | undefined {
  const legacy: Record<string, string> = {};
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    legacy[match[1].toLowerCase()] = (match[2] ?? match[3] ?? match[4] ?? "").replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (reference, name: string) => {
      if (name[0] !== "#") return LEGACY_ENTITIES[name.toLowerCase()] ?? reference;
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\uFFFD";
    });
  }
  const names = Object.keys(legacy);
  return names.length === Object.keys(attrs).length && names.every(name => Object.hasOwn(attrs, name) && attrs[name] === legacy[name]) ? undefined : legacy;
}

const isHtmlSpace = (char: string) => char === " " || char === "\t" || char === "\n" || char === "\f" || char === "\r";

/**
 * Where the tag whose name ends at `at` ends, as a browser's tokenizer reads it: the index of its
 * `>`, or -1 if the document ends first, and whether it closes itself. A quote opens a value only
 * after an attribute's name and `=`, and a `>` inside a quoted value doesn't end the tag. Only a `/`
 * just before the `>` closes it, and not one in an unquoted value (`a=b/>`): before, a tag ending in
 * `/` and whitespace (`<svg/ >`, a no-break space too) closed itself, and what followed was read.
 */
function tagEnd(html: string, at: number): { end: number; selfClosing: boolean } {
  // In the tag's name, between attributes, in an attribute's name, after one, before its value, or in an unquoted value.
  let state: "tag" | "between" | "name" | "after" | "before" | "unquoted" = "tag";
  for (; at < html.length; at++) {
    const char = html[at]!;
    if (char === ">") return { end: at, selfClosing: html[at - 1] === "/" && state === "between" };
    const space = isHtmlSpace(char);
    if (state === "before" && (char === "\"" || char === "'")) {
      at = html.indexOf(char, at + 1);
      if (at === -1) return { end: -1, selfClosing: false };
      state = "between";
    } else if (state === "tag" || state === "unquoted") {
      if (space || (char === "/" && state === "tag")) state = "between";
    } else if (state === "before") {
      if (!space) state = "unquoted";
    } else if (char === "=" && state !== "between") {
      state = "before";
    } else if (char === "/") {
      state = "between";
    } else if (space) {
      if (state === "name") state = "after";
    } else if (state !== "name") {
      state = "name";
    }
  }
  return { end: -1, selfClosing: false };
}

const COMMENT_END = /--!?>/g;

/** Where the comment opening at `at` ends: `<!-->` and `<!--->` where they start, another after `-->` or `--!>`, or at the end. */
function commentEnd(html: string, at: number): number {
  const empty = /^-?>/.exec(html.slice(at + 4, at + 6));
  if (empty) return at + 4 + empty[0].length;
  COMMENT_END.lastIndex = at + 4;
  return COMMENT_END.exec(html) ? COMMENT_END.lastIndex : html.length;
}

// A tag's name, as a browser's tokenizer reads it: up to whitespace, `/` or `>`. `[a-z0-9-]*` read
// `<style.x>` as a <style> and `<img:x>` as an <img>, which a browser reads as elements it doesn't know.
const TAG_NAME = /[a-z][^\t\n\f\r />]*/iy;

// A character reference in SVG or MathML markup, as a browser's tokenizer reads one: a number, its
// `;` optional; one of these names; or another name, which this doesn't decode.
const FOREIGN_REFERENCE = /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|(amp|lt|gt|quot|apos|AMP|LT|GT|QUOT);|[a-zA-Z])/g;
const FOREIGN_NAMES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

/**
 * A raw-text element's text in SVG or MathML, from `from` to its end tag at `close`, as a browser reads
 * it there, as markup: comments dropped, CDATA sections unwrapped and references decoded, with whether it
 * holds a reference this doesn't decode (a name other than FOREIGN_NAMES', or a number a browser maps to
 * another). Undefined where read as markup it could hold an element or end elsewhere: where it holds a
 * tag, a `<!…>` or `<?…>`, or a comment or CDATA section that holds a `<`. An HTML element there
 * (<foreignObject>, <mi>) holds it as raw text instead, as read out of SVG and MathML.
 */
function foreignText(html: string, from: number, close: number): { text: string; unknown: boolean } | undefined {
  let text = "";
  let unknown = false;
  const decode = (end: number) => {
    text += html.slice(from, end).replace(FOREIGN_REFERENCE, (reference, hex?: string, decimal?: string, name?: string) => {
      if (name !== undefined) return FOREIGN_NAMES[name.toLowerCase()]!;
      if (hex === undefined && decimal === undefined) {
        unknown = true;
        return reference;
      }
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(decimal!, 10);
      if (code >= 0x80 && code <= 0x9f) unknown = true;
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code);
    });
  };
  for (let at = html.indexOf("<", from); at !== -1 && at < close; at = html.indexOf("<", at + 1)) {
    let end: number;
    let held = "";
    if (html.startsWith("<!--", at)) {
      end = commentEnd(html, at);
    } else if (html.startsWith("<![CDATA[", at)) {
      const closing = html.indexOf("]]>", at + 9);
      end = closing === -1 ? html.length : closing + 3;
      held = html.slice(at + 9, closing === -1 ? html.length : closing);
    } else if (/[a-z!?/]/i.test(html[at + 1] ?? "")) {
      return undefined;
    } else {
      continue;
    }
    const next = html.indexOf("<", at + 1);
    if (next !== -1 && next < end) return undefined;
    decode(at);
    text += held;
    from = end;
    at = end - 1;
  }
  decode(close);
  return { text, unknown };
}

// What changes the state a script's text is read in, as a browser's tokenizer reads it: outside an
// escape, `<!--` begins one; in one, `<script` begins a double escape; in either, `-->` ends it. The
// `--` of `-->` can be the `<!--`'s own, so the escape is searched from that `<!--`'s dashes.
const SCRIPT_DATA = /<!--|<\/script[\t\n\f\r />]/gi;
const SCRIPT_ESCAPED = /-->|<(\/?)script[\t\n\f\r />]/gi;
const SCRIPT_DOUBLE_ESCAPED = /-->|<\/script[\t\n\f\r />]/gi;

/**
 * Where a script's text, starting at `from`, ends: at the `</script` that closes it, or the end of
 * the document. Inside `<!--`, a `<script` tag starts a double escape, in which `</script` only
 * ends the double escape, so `<script><!--<script>x</script>y</script>` holds `y`; `-->` ends both.
 */
function scriptEnd(html: string, from: number): number {
  let state: RegExp = SCRIPT_DATA;
  for (let at = from; ;) {
    state.lastIndex = at;
    const match = state.exec(html);
    if (!match) return html.length;
    if (match[0] === "<!--") {
      state = SCRIPT_ESCAPED;
      at = match.index + 2;
    } else if (match[0] === "-->") {
      state = SCRIPT_DATA;
      at = match.index + 3;
    } else if (state === SCRIPT_DATA || (state === SCRIPT_ESCAPED && match[1] === "/")) {
      return match.index;
    } else {
      // `<script` in an escape begins a double escape; `</script` in one ends it.
      state = state === SCRIPT_ESCAPED ? SCRIPT_DOUBLE_ESCAPED : SCRIPT_ESCAPED;
      at = match.index + match[0].length;
    }
  }
}

/**
 * Splits HTML into tags and text, in one pass, finding them where a browser's tokenizer does:
 * comments, doctypes and `<?…>` are skipped, a `>` inside a quoted attribute value doesn't end its
 * tag, a raw-text element (RAW_TEXT) runs to its own end tag whatever it holds, and `/>` closes
 * only a void element, as in HTML. RAW_TEXT elements' text is skipped unless KEPT_TEXT, and DROPPED
 * elements are skipped with all they hold. A tag is named by its whole name, and only that name
 * makes it a RAW_TEXT or DROPPED element. Before, a tag ended at its first `>`, a raw-text element at
 * the first `</` and its name, a <template> at the first `</template`, and `<style/>` held nothing,
 * so text a browser reads as an attribute value, a stylesheet or a template's content was shown.
 *
 * The text of each <style> outside an HTML <template> goes to `styles`, read only for what it hides
 * when a browser may not apply it: in <noscript>, which a reader running scripts reads as text, or in
 * SVG or MathML. There a browser reads it as markup ({@link foreignText}), unless an HTML element
 * there holds it, so it is read both ways. Where reading a raw-text element there as markup could hold
 * an element or end it elsewhere, `styles.unreadable` is set: what the document hides can't be known.
 * So it is where an HTML element a browser opens there may hold what follows the SVG's or MathML's
 * end tag, or its end may come elsewhere for a browser: at a start tag a browser reads as HTML
 * (BREAKOUT, OUTSIDE); at an end tag that, read as HTML, closes no element the SVG or MathML opened
 * (`</p>`, or `</div>` for a <div> around the SVG); or where an HTML element in an integration point
 * isn't closed by the next end tag. Past that, nothing more is read.
 */
export function tokenize(html: string, styles?: Styles): Token[] {
  const tokens: Token[] = [];
  // The DROPPED elements open, innermost last, each with whether it opened in SVG or MathML, and how
  // many of each are open; of those, how many are SVG or MathML, and how many an HTML <template> or <noscript>.
  type Dropped = { name: string; foreign: boolean };
  const dropping: Dropped[] = [];
  const dropped = new Map<string, number>();
  let foreign = 0;
  let inert = 0;
  let noscript = 0;
  const count = ({ name, foreign: inForeign }: Dropped, by: 1 | -1) => {
    dropped.set(name, (dropped.get(name) ?? 0) + by);
    if (name === "svg" || name === "math") foreign += by;
    else if (!inForeign && name === "template") inert += by;
    else if (!inForeign && name === "noscript") noscript += by;
  };
  // Read for `styles`: the elements open from the outermost <svg> or <math>, innermost last, each in
  // its namespace, as a browser's parser opens them.
  const elements: { name: string; ns: "html" | "svg" | "math" }[] = [];
  const push = (token: Token) => {
    if (dropping.length === 0) tokens.push(token);
  };
  // Where the text not yet taken starts.
  let from = 0;
  const text = (end: number) => {
    if (end > from) push({ type: "text", text: html.slice(from, end) });
    from = end;
  };
  // Past `from`, or past a `<` that is text.
  for (let at = html.indexOf("<"); at !== -1 && !styles?.unreadable; at = html.indexOf("<", Math.max(from, at + 1))) {
    if (html.startsWith("<!--", at)) {
      text(at);
      from = commentEnd(html, at);
      continue;
    }
    if (foreign > 0 && elements.at(-1)?.ns !== "html" && html.startsWith("<![CDATA[", at)) {
      // In SVG or MathML a CDATA section is text, to its `]]>`; in an HTML element there, a comment to the next `>`.
      text(at);
      const close = html.indexOf("]]>", at + 9);
      from = close === -1 ? html.length : close + 3;
      continue;
    }
    const end = html[at + 1] === "/";
    TAG_NAME.lastIndex = at + (end ? 2 : 1);
    const read = TAG_NAME.exec(html)?.[0];
    const name = read === undefined ? undefined : asciiLowerCase(read);
    if (name === undefined) {
      // `<!…>`, `<?…>` and `</…>` are read to the next `>` and skipped; any other `<` is text.
      if (!end && html[at + 1] !== "!" && html[at + 1] !== "?") continue;
      text(at);
      const gt = html.indexOf(">", at + 2);
      from = gt === -1 ? html.length : gt + 1;
      continue;
    }
    const attributes = TAG_NAME.lastIndex;
    const { end: gt, selfClosing: selfClosed } = tagEnd(html, attributes);
    text(at);
    // A tag the document ends inside is dropped, as a browser drops it.
    from = gt === -1 ? html.length : gt + 1;
    if (gt === -1) break;
    // In mail (`styles`), with its attributes as the reader before this one read them where they differ.
    const opened = (selfClosing: boolean) => {
      const source = html.slice(attributes, gt);
      const attrs = parseAttributes(source);
      const legacy = styles && legacyAttributes(source, attrs);
      push({ type: "open", tag: name, attrs, ...(legacy ? { legacy } : {}), selfClosing });
    };
    if (styles && (elements.length > 0 || (!end && (name === "svg" || name === "math")))) {
      const current = elements.at(-1);
      if (end) {
        // An end tag closes the current element if it is HTML and has its name; in SVG or MathML, the
        // innermost element it names, unless an HTML element comes first, as one does for </p> and </br>.
        const inHtml = current!.ns === "html";
        const at = inHtml ? (current!.name === name ? elements.length - 1 : -1)
          : elements.findLastIndex(element => element.ns === "html" || element.name === name);
        if (at === -1 || (elements[at]!.ns === "html") !== inHtml) styles.unreadable = true;
        else elements.length = at;
      } else {
        const asHtml = current === undefined || current.ns === "html" || INTEGRATION[current.ns].has(current.name);
        if (asHtml ? OUTSIDE.has(name) : BREAKOUT.has(name) || current!.name === "annotation-xml"
          || (name === "font" && ["color", "face", "size"].some(key => key in parseAttributes(html.slice(attributes, gt))))) {
          styles.unreadable = true;
        } else if (!RAW_TEXT.has(name) || KEPT_TEXT.has(name)) {
          // A raw-text element's end tag is read with it, and a void HTML element or one closed with `/>` in SVG or MathML has none.
          const ns = !asHtml ? current!.ns : name === "svg" || name === "math" ? name : "html";
          if (ns === "html" ? !VOID.has(name) : !selfClosed) elements.push({ name, ns });
        }
      }
    }
    if (end) {
      if (!dropped.get(name)) {
        push({ type: "close", tag: name });
        continue;
      }
      for (let open = dropping.pop()!; ; open = dropping.pop()!) {
        count(open, -1);
        if (open.name === name) break;
      }
      // The SVG or MathML ended for a browser and not here, or here and not for it.
      if (styles && (elements.length === 0) !== (foreign === 0)) styles.unreadable = true;
    } else if (DROPPED.has(name)) {
      // Only an SVG or MathML element closes itself with `/>`.
      if ((name === "svg" || name === "math") && selfClosed) continue;
      const opened = { name, foreign: foreign > 0 };
      dropping.push(opened);
      count(opened, 1);
    } else if (RAW_TEXT.has(name)) {
      // Searched case-insensitively in place: lower-casing the whole document per element is slow,
      // and can change its length (İ becomes two characters), which would misplace the index.
      const closing = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "gi");
      closing.lastIndex = from;
      const close = name === "plaintext" ? html.length : name === "script" ? scriptEnd(html, from) : closing.exec(html)?.index ?? html.length;
      const sheet = name === "style" && inert === 0;
      if (styles && foreign > 0) {
        const markup = foreignText(html, from, close);
        if (markup === undefined || (sheet && markup.unknown)) {
          styles.unreadable = true;
        } else if (sheet) {
          const raw = html.slice(from, close);
          styles.sheets.push({ css: markup.text, hidingOnly: true });
          if (raw !== markup.text) styles.sheets.push({ css: raw, hidingOnly: true });
        }
      } else if (sheet) {
        styles?.sheets.push({ css: html.slice(from, close), hidingOnly: noscript > 0 });
      }
      if (KEPT_TEXT.has(name)) {
        // Its end tag is read next, as one.
        opened(false);
        text(close);
      } else {
        const closeEnd = close < html.length ? tagEnd(html, close + 2 + name.length).end : -1;
        from = closeEnd === -1 ? html.length : closeEnd + 1;
      }
    } else {
      opened(VOID.has(name));
    }
  }
  text(html.length);
  return tokens;
}

/** Escapes text so Markdown reads it literally, without escaping what cannot be misread. */
function escapeMarkdown(text: string): string {
  return text
    .replace(/([\\`*_[\]<>|])/g, "\\$1")
    // A list number is escaped at its period, `1\.`: a backslash before a digit would be a literal one.
    .replace(/^(\s*)(?:([#>+-])|(\d+)\.)(\s)/gm, (_, space: string, mark: string | undefined, number: string | undefined, after: string) =>
      `${space}${mark !== undefined ? `\\${mark}` : `${number}\\.`}${after}`);
}

/** Whether a link target may be shown: http(s), mailto, or a relative path. Never `javascript:`. */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!/^(https?:|mailto:)/i.test(trimmed) && !/^[/#?.]/.test(trimmed)) return undefined;
  // Characters that would end the link target early, or a table cell, are percent-encoded;
  // `encodeURIComponent` leaves parentheses alone.
  return trimmed.replace(/[()|\s]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

type ListFrame = { ordered: boolean; index: number };

/** Lists and quotes nested deeper than this indent or prefix no further: output would otherwise grow with the square of the depth. */
const MAX_NESTING = 32;

/**
 * `text` without its trailing spaces and tabs (other whitespace kept), in one pass; `/[ \t]+$/`
 * backtracks quadratically over a long run of spaces that stops short of the end.
 */
export function trimTrailingBlanks(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  return text.slice(0, end);
}

/**
 * Converts HTML to Markdown. Whitespace is collapsed as a browser would, block elements become
 * paragraphs, and tables become GitHub-style tables (cell line breaks become spaces).
 */
export function htmlToMarkdown(html: string): string {
  const tokens = tokenize(html);
  const out: string[] = [];
  let line = "";
  const lists: ListFrame[] = [];
  let pre = 0;
  let quote = 0;
  const links: (string | undefined)[] = [];
  let table: { rows: string[][]; row: string[] | null; cell: string | null; header: boolean } | null = null;
  // Tables inside a table's cell: Markdown can't nest them, so their text flows into the cell.
  let nested = 0;
  // Whether the line, and the cell, are empty or end in whitespace, noted as they are written:
  // reading the end of a string built by appending copies all of it, which over a long line of
  // short writes was quadratic.
  let lineSpaced = true;
  let cellSpaced = true;
  const spacedAfter = (text: string, before: boolean) => text === "" ? before : /\s$/.test(text);

  const write = (text: string) => {
    if (table?.cell !== null && table?.cell !== undefined) {
      table.cell += text;
      cellSpaced = spacedAfter(text, cellSpaced);
    } else {
      line += text;
      lineSpaced = spacedAfter(text, lineSpaced);
    }
  };
  const prefix = () => "> ".repeat(Math.min(quote, MAX_NESTING));
  // A paragraph break: empty, or inside a quote the bare marker, so the quote continues past it.
  const isBreak = (text: string | undefined) => text !== undefined && /^[> ]*$/.test(text);
  const flush = () => {
    // Leading spaces are a list's indentation or code's: whitespace text is already collapsed away.
    const text = trimTrailingBlanks(line);
    if (text.trim() !== "") out.push(prefix() + text);
    line = "";
    lineSpaced = true;
  };
  const block = () => {
    flush();
    if (out.length > 0 && !isBreak(out[out.length - 1])) out.push(prefix().trimEnd());
  };

  for (const token of tokens) {
    if (token.type === "text") {
      const decoded = decodeEntities(token.text);
      if (pre > 0) write(decoded);
      else {
        const collapsed = decoded.replace(/\s+/g, " ");
        const spaced = table?.cell != null ? cellSpaced : lineSpaced;
        write(spaced ? escapeMarkdown(collapsed.replace(/^ /, "")) : escapeMarkdown(collapsed));
      }
      continue;
    }
    const { tag } = token;
    if (token.type === "open") {
      switch (tag) {
        case "p": case "div": case "section": case "article": case "header": case "footer": case "figure":
          if (!table) block();
          break;
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
          block();
          line = `${"#".repeat(Number(tag[1]))} `;
          lineSpaced = true;
          break;
        case "br":
          if (table?.cell != null) {
            table.cell += " ";
            cellSpaced = true;
          } else if (pre > 0) {
            line += "\n";
            lineSpaced = true;
          } else {
            flush();
          }
          break;
        case "hr": block(); out.push("---"); out.push(""); break;
        case "strong": case "b": write("**"); break;
        case "em": case "i": write("_"); break;
        case "s": case "strike": case "del": write("~~"); break;
        case "code": if (pre === 0) write("`"); break;
        case "pre": block(); pre++; out.push(`${prefix()}\`\`\``); break;
        case "blockquote": block(); quote++; break;
        case "a": {
          const href = safeHref(token.attrs.href);
          links.push(href);
          if (href) write("[");
          break;
        }
        case "img": {
          const alt = token.attrs.alt?.trim();
          write(alt ? `[image: ${escapeMarkdown(alt)}]` : "[image]");
          break;
        }
        case "ul": case "ol": flush(); lists.push({ ordered: tag === "ol", index: 0 }); break;
        case "li": {
          flush();
          const frame = lists[lists.length - 1] ?? { ordered: false, index: 0 };
          frame.index++;
          line = `${"  ".repeat(Math.max(0, Math.min(lists.length, MAX_NESTING) - 1))}${frame.ordered ? `${frame.index}.` : "-"} `;
          lineSpaced = true;
          break;
        }
        case "table":
          if (table) nested++;
          else { block(); table = { rows: [], row: null, cell: null, header: false }; }
          break;
        case "tr": if (table && nested === 0) table.row = []; break;
        case "th": case "td":
          if (nested > 0) write(" ");
          else if (table) { table.cell = ""; cellSpaced = true; if (tag === "th" && table.rows.length === 0) table.header = true; }
          break;
      }
      continue;
    }
    switch (tag) {
      case "p": case "div": case "section": case "article": case "header": case "footer": case "figure":
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        if (!table) block();
        break;
      case "strong": case "b": write("**"); break;
      case "em": case "i": write("_"); break;
      case "s": case "strike": case "del": write("~~"); break;
      case "code": if (pre === 0) write("`"); break;
      case "pre": flush(); pre = Math.max(0, pre - 1); out.push(`${prefix()}\`\`\``); out.push(""); break;
      case "blockquote":
        flush();
        if (quote > 0 && out[out.length - 1] === prefix().trimEnd()) out.pop();
        quote = Math.max(0, quote - 1);
        block();
        break;
      case "a": {
        const href = links.pop();
        if (href) write(`](${href})`);
        break;
      }
      case "ul": case "ol": flush(); lists.pop(); if (lists.length === 0) block(); break;
      case "li": flush(); break;
      case "th": case "td":
        if (nested > 0) break;
        // Cell text is already escaped, pipes included.
        if (table?.row && table.cell !== null) table.row.push(table.cell.trim());
        if (table) table.cell = null;
        break;
      case "tr":
        if (nested > 0) break;
        if (table?.row) table.rows.push(table.row);
        if (table) table.row = null;
        break;
      case "table": {
        if (nested > 0) {
          nested--;
          break;
        }
        if (table && table.rows.length > 0) {
          // Not Math.max(...): spreading more than about 120,000 rows into a call overflows the stack.
          const width = table.rows.reduce((most, row) => Math.max(most, row.length), 0);
          const pad = (row: string[]) => `| ${[...row, ...Array<string>(width - row.length).fill("")].join(" | ")} |`;
          const [head, ...body] = table.header ? table.rows : [Array<string>(width).fill(""), ...table.rows];
          out.push(prefix() + pad(head));
          out.push(prefix() + `| ${Array<string>(width).fill("---").join(" | ")} |`);
          // A short row is left short, as GitHub fills it: padding each to the widest made a wide
          // header over many narrow rows cost their product.
          for (const row of body) out.push(prefix() + `| ${row.join(" | ")} |`);
          out.push("");
        }
        table = null;
        break;
      }
    }
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
