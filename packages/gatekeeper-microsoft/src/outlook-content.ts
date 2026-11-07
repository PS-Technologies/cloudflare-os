// Mail content for agents to read and write. Mail is written by its sender, not the user, so an agent
// reads what a person would see in Outlook and nothing they wouldn't: scripts, styles and comments
// go; hidden text (display:none, zero-size or background-coloured text, preheaders, invisible
// characters) and tracking images are removed and counted; every link shows its real target,
// unwrapped from Safe Links and URL Defense, and is flagged when its text names another site. Layout
// tables flatten to text. HTML is tokenized, built into a small tree, cleaned, and handed to
// `htmlToMarkdown`; nothing is evaluated.
//
// For composing, `markdownToMailHtml` writes Markdown as HTML with inline styles only (Outlook
// ignores <style>), and the parse and check functions validate what an agent passes.

import { escapeHtml } from "@gadgets/gatekeeper-kit/connect-pages";
import { parseMarkdown, safeHref as safeMarkdownHref, type MdBlock, type MdInline } from "./content/markdown-parse";
import { VOID, asciiLowerCase, commentEnd, decodeEntities, htmlToMarkdown, tokenize, trimTrailingBlanks, type Sheet, type Styles } from "./html-markdown";
import type { AttachmentInput, EmailAddress, MessageLink, SenderKind } from "./outlook-types";

// -- reading ------------------------------------------------------------------------------------

/** What `mailToMarkdown` makes of a body. */
export type MailMarkdown = {
  markdown: string; links: MessageLink[]; removed: string[];
  /** Whether some of the message was left out at a limit of this reader's, or cut at `maxChars`. */
  truncated: boolean;
  /** Whether text was left out because it doesn't show when read: hidden regions or invisible characters. */
  hidesText: boolean;
};

/** The most links listed for one message. */
export const MAX_LINKS = 200;
/**
 * How deep the tree is built: as deep as Chromium's parser nests elements, counting its <html> and
 * <body> and the table parts it adds. Past it Chromium attaches an element beside the one it would be
 * in, and puts the text inside it there too; HTML nested that deep is not read at all ({@link UNREADABLE}).
 * Flattened at 200, an element past it held none of the text inside it, and its end tags closed
 * elements outside it, so text a browser keeps in a hidden element was shown.
 */
const MAX_DEPTH = 512;
/**
 * The most HTML converted, in characters. Crafted HTML this long holds the converter's heap under
 * 96 MB in workerd, of a Worker's 128 MB, and an ordinary newsletter is well under it. Past it the
 * HTML is not converted: what is read is a note to open the original, so nothing hidden is shown.
 */
export const MAX_MAIL_HTML_CHARS = 300_000;
const TOO_LONG = "This is too long to read here. Open the original to read it.";
/** What is read of HTML a browser may read otherwise than this does ({@link tokenize}): nothing, so nothing hidden is shown. */
const UNREADABLE = "This message is written in a way that can't be read safely here. Open the original to read it.";
/** Written where text is first left out past what is reopened for one message (MAX_REOPENED), which a browser shows. */
const TOO_COMPLEX = "Some of what follows is too complex to read here. Open the original to read all of it.";

/**
 * Characters a person can't see: Unicode's default-ignorable set (zero-width spaces and joiners,
 * bidi controls, the BOM, soft hyphens, Hangul fillers, variation selectors, and the tag characters
 * U+E0000–E007F that can spell out text a model reads and a person doesn't), and controls.
 */
// oxlint-disable-next-line no-control-regex -- matching invisible and control characters is the point
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
/** Of those, the variation selectors that pick text or emoji presentation, which hide nothing worth a note. */
const PRESENTATION_SELECTORS = /^[\ufe0e\ufe0f]$/u;

/** Text with the characters a person can't see removed: for subjects, names and previews. */
export function visibleText(text: string): string {
  return text.replace(INVISIBLE, "");
}

/** Elements removed with everything in them. */
const DROPPED = new Set([
  "script", "style", "head", "title", "template", "noscript", "iframe", "object", "embed", "applet", "frame", "frameset",
  "form", "input", "button", "select", "option", "textarea", "svg", "math", "audio", "video", "canvas", "map", "link", "meta",
]);

/**
 * Elements that end a paragraph when opened inside one, as browsers close them. Not a table: a
 * browser reading mail without a doctype, as most is, opens it inside the paragraph.
 */
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "center", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "listing", "main", "menu", "nav", "ol", "p", "plaintext", "pre", "search",
  "section", "summary", "ul", "xmp",
]);
/**
 * Start tags a browser puts in the <head> before the <body> is begun, as the HTML spec's "in head"
 * step does; any other begins the <body>. The tokenizer reads most to their end, so only <base>
 * (read for its link), <head>, <title>, <meta>, <link>, <basefont> and <bgsound> reach the tree.
 */
const HEAD = new Set(["base", "basefont", "bgsound", "head", "link", "meta", "noframes", "noscript", "script", "style", "template", "title"]);
/** Start tags a browser ignores outside a table. */
const TABLE_PARTS = new Set(["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"]);
/** A table's row groups, which a browser adds a <tbody> for when a row is written without one. */
const SECTIONS = new Set(["tbody", "tfoot", "thead"]);
/**
 * Where a browser's parser puts each table part, closing whatever is open inside it first: a cell in
 * its row (or the row group or table it adds one in), a row in its row group (or the table), and the
 * rest straight in the table. So a cell ends an open cell, caption or column group; a row, an open
 * row too; and a row group, caption or column group, an open row group too.
 */
const TABLE_CONTEXTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ...["td", "th"].map(tag => [tag, new Set(["tr", ...SECTIONS, "table"])] as const),
  ["tr", new Set([...SECTIONS, "table"])],
  ...["caption", "col", "colgroup", "tbody", "tfoot", "thead"].map(tag => [tag, new Set(["table"])] as const),
]);
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"];
/**
 * Headings: one opened while another is the innermost element ends it, as a browser's parser does,
 * as an <option> or <optgroup> ends an <option>; and a heading's end tag ends the innermost open.
 */
const HEADINGS = new Set(HEADING_TAGS);

/** A ruby's parts, which a browser opens without reopening formatting elements first. */
const RUBY_PARTS = new Set(["rb", "rp", "rt", "rtc"]);
/** The elements whose end tags a browser implies before a ruby's part, closing the innermost while it is one. */
const IMPLIED_ENDS = new Set(["dd", "dt", "li", "p", "rb", "rp", "rt", "rtc"]);

/** The open elements a link can't close an older link across: tables and the HTML spec's markers. */
const LINK_SCOPE = ["table", "td", "th", "caption", "object", "applet", "marquee", "template"];
/** The HTML spec's markers: a formatting element closed inside one is never reopened outside it. */
const MARKERS = new Set(["td", "th", "caption", "object", "applet", "marquee", "template"]);
/** The HTML spec's formatting elements. */
const FORMATTING = new Set(["a", "b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt", "u"]);
/** The HTML spec's special elements: blocks, tables, lists, forms, and the like. */
const SPECIAL = new Set([
  "address", "applet", "area", "article", "aside", "base", "basefont", "bgsound", "blockquote", "body", "br", "button", "caption", "center", "col",
  "colgroup", "dd", "details", "dir", "div", "dl", "dt", "embed", "fieldset", "figcaption", "figure", "footer", "form", "frame", "frameset",
  "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "iframe", "img", "input", "keygen", "li", "link", "listing", "main",
  "marquee", "menu", "meta", "nav", "noembed", "noframes", "noscript", "object", "ol", "p", "param", "plaintext", "pre", "script", "search", "section",
  "select", "source", "style", "summary", "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "title", "tr", "track", "ul", "wbr", "xmp",
]);
/** Special elements a browser opens as it does text, reopening formatting elements first. */
const INLINE_SPECIAL = new Set(["applet", "area", "br", "button", "embed", "img", "input", "keygen", "marquee", "object", "select", "wbr", "xmp"]);
/** The HTML spec's scopes: an end tag whose element is open only past one of these is ignored. */
const SCOPE = new Set(LINK_SCOPE);
const BUTTON_SCOPE = new Set([...LINK_SCOPE, "button"]);
const LIST_ITEM_SCOPE = new Set([...LINK_SCOPE, "ol", "ul"]);
const TABLE_SCOPE = new Set(["table", "template"]);
/** Where a browser stops looking for an <li> to close: any special element but these. */
const LIST_ITEM_STOPS = new Set([...SPECIAL].filter(tag => tag !== "address" && tag !== "div" && tag !== "p"));
/** Where a browser stops looking for the element an end tag names: any special element stops an ordinary one (</span>). */
const endTagScope = (tag: string): ReadonlySet<string> =>
  tag === "table" || TABLE_PARTS.has(tag) ? TABLE_SCOPE : tag === "p" ? BUTTON_SCOPE : tag === "li" ? LIST_ITEM_SCOPE : SPECIAL.has(tag) ? SCOPE : SPECIAL;
/**
 * The most copies of formatting elements reopened for one message. Each text can need every one
 * an end tag closed, so a crafted message could otherwise make them by the million; past this, what
 * would be inside them is left out where it would be, with a note that it was ({@link TOO_COMPLEX}).
 * A copy shares its original's attributes, and all they say of it is read once ({@link readOf}), so
 * a copy costs the same however long they are.
 */
const MAX_REOPENED = 20_000;
/**
 * The most formatting elements alike (one tag, the same attributes) reopened together, as the HTML
 * spec's "Noah's Ark" clause keeps at most three in its list. Without it, a paragraph that leaves a
 * <font> open reopened every earlier one's, and ordinary mail spent MAX_REOPENED in 200 paragraphs.
 */
const MAX_ALIKE = 3;

/** An element: `legacy`, its attributes as the reader before this one read them, where they differ ({@link pinHides}). */
type Element = { tag: string; attrs: Record<string, string>; legacy?: Record<string, string>; children: Node[]; parent: Element | null };
type Node = Element | { text: string };

const isElement = (node: Node): node is Element => "tag" in node;

/** Formatting elements to reopen, in order, with how many of each tag and of each alike set ({@link MAX_ALIKE}) it holds. */
type Pending = { elements: Element[]; tags: Map<string, number>; alike: Map<string, number> };

/** Attributes spelled out in name order, once for each set (a copy shares its original's). */
const spelled = new WeakMap<Record<string, string>, string>();
const spelling = (attrs: Record<string, string> | undefined): string => {
  if (attrs === undefined) return "";
  let text = spelled.get(attrs);
  if (text === undefined) spelled.set(attrs, text = JSON.stringify(Object.entries(attrs).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
  return text;
};
/**
 * What makes formatting elements alike: tag and attributes, as read now and as the reader before this
 * one read them. Kept for each attribute set, as a copy has its original's tag and attributes, so a
 * long one isn't joined and hashed again at every list it is put in or looked for in.
 */
const alikeKeys = new WeakMap<Record<string, string>, string>();
const alikeKey = (element: Element) => {
  let key = alikeKeys.get(element.attrs);
  if (key === undefined) alikeKeys.set(element.attrs, key = `${element.tag}\u0000${spelling(element.attrs)}\u0000${spelling(element.legacy)}`);
  return key;
};
/** Adds to `to`, in place, the attributes of `from` it hasn't, as a browser adds a second <html>'s or <body>'s to its own. */
const addAttributes = (to: Record<string, string>, from: Record<string, string>) => {
  for (const name of Object.keys(from)) if (!Object.hasOwn(to, name)) to[name] = from[name]!;
};

/**
 * The attributes of what stands where text was left out past MAX_REOPENED: an element of its own,
 * known by this object, which no tag's attributes are.
 */
const CUT: Record<string, string> = Object.freeze({}) as Record<string, string>;

/** Builds a tree from tokens, closing elements as a browser would, and gathers the stylesheets; `styles.unreadable` when it is deeper than MAX_DEPTH. */
function buildTree(html: string): { root: Element; base?: string; styles: Styles } {
  // Named as no rule names an element (`#root` is an ID's), so only a `*` rule applies to it.
  const root: Element = { tag: "", attrs: {}, children: [], parent: null };
  const styles: Styles = { sheets: [], unreadable: false };
  let current = root;
  // How deep a browser's tree is here ({@link MAX_DEPTH}): from its <html> and <body>, with the
  // <tbody> and <tr> it adds around a row or cell written straight into a table (`implied`).
  let depth = 2;
  const implied = new WeakMap<Element, number>();
  // How many elements are open, however `depth` is counted: never more than a browser's tree nests,
  // as each end tag can walk them ({@link pageTag}).
  let stack = 0;
  let base: string | undefined;
  // The link each open element is in and whether it is in a ruby, unless LINK_SCOPE comes between, and
  // the marker each is in (the root when none is): looked up, so an <a> or <rt> under a deep stack
  // doesn't walk it.
  const linkOf = new Map<Element, Element>();
  const rubied = new WeakSet<Element>();
  const markerOf = new Map<Element, Element>();
  // The open elements inside a <table>, so a table part's start tag doesn't walk the stack to find
  // one, and how many of each tag are open, so an end tag for one that isn't doesn't walk it either.
  const tabled = new WeakSet<Element>();
  const openTags = new Map<string, number>();
  // The <html> and <body>, each opened once: by its start tag, or implied by what a browser opens it
  // for ({@link startBody}).
  const sole = new Map<string, Element>();
  const closing = (node: Element) => {
    depth -= 1 + (implied.get(node) ?? 0);
    stack -= 1;
    openTags.set(node.tag, openTags.get(node.tag)! - 1);
  };
  // By marker, formatting elements closed but not by their own end tag, which a browser reopens, as
  // copies, before the next text or inline element inside that marker. A list is appended to in
  // place and emptied as it is reopened, and an end tag's element is looked for in it only when its
  // count says it is there.
  const pending = new Map<Element, Pending>();
  // Markers in which MAX_REOPENED ran out: until one closes, text in it goes in an element that leaves
  // it out ({@link CUT}, `cuts`), and nothing more is kept to reopen. Before, the list kept growing,
  // read whole at every end tag and copied at every close, so a crafted message took seconds.
  const spent = new Set<Element>();
  const cuts = new WeakSet<Element>();
  let reopened = 0;
  /** Counts copies of `elements` against what the message may copy, if they fit. */
  const afford = (elements: readonly Element[]): boolean => {
    if (reopened + elements.length > MAX_REOPENED) return false;
    reopened += elements.length;
    return true;
  };
  const open = (tag: string, attrs: Record<string, string>, enters = true, legacy?: Record<string, string>) => {
    // A browser has one <html> and one <body>, counted already (one of each at most is opened here,
    // and never closed), and adds a <tbody> or <tr> a table part needs: counted for any not written
    // just outside it, so never fewer than it adds.
    const adds = tag === "html" || tag === "body" ? -1
      : tag === "tr" ? (SECTIONS.has(current.tag) ? 0 : 1)
      : tag === "td" || tag === "th" ? (current.tag === "tr" ? 0 : SECTIONS.has(current.tag) ? 1 : 2) : 0;
    // A browser attaches an element deeper than this beside the one it would be in, and text in it
    // there. The deepest it nests is one past MAX_DEPTH, so no more than that are ever open here.
    if (depth + adds > MAX_DEPTH || (enters && stack > MAX_DEPTH)) {
      styles.unreadable = true;
      return;
    }
    const element: Element = { tag, attrs, children: [], parent: current };
    if (legacy) element.legacy = legacy;
    current.children.push(element);
    if (!enters) return;
    if (adds !== 0) implied.set(element, adds);
    const link = tag === "a" ? element : linkOf.get(current);
    if (link && !LINK_SCOPE.includes(tag)) linkOf.set(element, link);
    if ((tag === "ruby" || rubied.has(current)) && !LINK_SCOPE.includes(tag)) rubied.add(element);
    markerOf.set(element, MARKERS.has(tag) ? element : markerOf.get(current) ?? root);
    if (tag === "table" || tabled.has(current)) tabled.add(element);
    if (tag === "html" || tag === "body") sole.set(tag, element);
    openTags.set(tag, (openTags.get(tag) ?? 0) + 1);
    current = element;
    depth += 1 + adds;
    stack += 1;
  };
  const remove = (list: Pending, at: number) => {
    const [element] = list.elements.splice(at, 1);
    list.tags.set(element!.tag, list.tags.get(element!.tag)! - 1);
    const key = alikeKey(element!);
    list.alike.set(key, list.alike.get(key)! - 1);
  };
  /** Puts what follows in an element that leaves it out, unless it already is in one put there for `marker`. */
  const cut = (marker: Element) => {
    for (let node = current; node !== marker && node !== root; node = node.parent!) if (cuts.has(node)) return;
    const outside = current;
    open("span", CUT);
    if (current !== outside) cuts.add(current);
  };
  const reopen = () => {
    const marker = markerOf.get(current) ?? root;
    if (spent.has(marker)) {
      cut(marker);
      return;
    }
    const list = pending.get(marker);
    if (!list) return;
    pending.delete(marker);
    if (!afford(list.elements)) {
      spent.add(marker);
      cut(marker);
      return;
    }
    for (const { tag, attrs, legacy } of list.elements) open(tag, attrs, true, legacy);
  };
  /** Adds formatting elements just closed, outermost first, to those to reopen where the tree now is. */
  const queue = (elements: readonly Element[]) => {
    if (elements.length === 0) return;
    const marker = markerOf.get(current) ?? root;
    if (spent.has(marker)) return;
    let list = pending.get(marker);
    if (!list) pending.set(marker, list = { elements: [], tags: new Map(), alike: new Map() });
    for (const element of elements) {
      const key = alikeKey(element);
      // A fourth alike drops the earliest, as a browser's list does.
      if ((list.alike.get(key) ?? 0) >= MAX_ALIKE) remove(list, list.elements.findIndex(other => alikeKey(other) === key));
      list.elements.push(element);
      list.tags.set(element.tag, (list.tags.get(element.tag) ?? 0) + 1);
      list.alike.set(key, (list.alike.get(key) ?? 0) + 1);
    }
    // Reopened, more than this would nest deeper than a browser nests ({@link MAX_DEPTH}), so the
    // message can't be read. Saying so now keeps the list, which an end tag or a fourth alike looks
    // through, no longer than the elements open at once.
    if (list.elements.length > MAX_DEPTH) styles.unreadable = true;
  };
  /** Takes the last pending `tag` off its list, as a browser does when its end tag comes before it's reopened. */
  const forget = (tag: string): boolean => {
    const marker = markerOf.get(current) ?? root;
    const list = pending.get(marker);
    if (!list?.tags.get(tag)) return false;
    remove(list, list.elements.findLastIndex(element => element.tag === tag));
    if (list.elements.length === 0) pending.delete(marker);
    return true;
  };
  // An end tag, or a start tag that ends a paragraph or cell, closes the elements open inside the one
  // it closes. A browser reopens the formatting elements among them, unless a marker it closed held
  // them, so text after them is still in them, and hidden by whatever hid them; this does the same.
  // An end tag is ignored, as a browser ignores it, when `stops` comes before the element it names.
  const closeTo = (tag: string, stops?: ReadonlySet<string>): boolean => {
    if (!openTags.get(tag)) return false;
    let target: Element | null = current;
    while (target && target !== root && target.tag !== tag) {
      if (stops?.has(target.tag)) return false;
      target = target.parent;
    }
    if (!target || target === root) return false;
    closeThrough(target);
    return true;
  };
  /** Closes `target` and what is open inside it; `reopens`, when a browser reopens `target` too, as a formatting element closed but not by its own end tag. */
  const closeThrough = (target: Element, reopens = false) => {
    let closed: Element[] = [];
    for (let node = current; ; node = node.parent!) {
      closing(node);
      if (MARKERS.has(node.tag)) {
        closed = [];
        pending.delete(node);
        spent.delete(node);
      } else if ((node !== target || reopens) && FORMATTING.has(node.tag)) {
        closed.push(node);
      }
      if (node === target) break;
    }
    current = target.parent!;
    queue(closed.toReversed());
  };
  const closeIfOpen = (tags: readonly string[], stopAt: ReadonlySet<string>): boolean => {
    if (!tags.some(tag => openTags.get(tag))) return false;
    for (let node: Element | null = current; node && node !== root; node = node.parent) {
      if (tags.includes(node.tag)) {
        closeThrough(node);
        return true;
      }
      if (stopAt.has(node.tag)) return false;
    }
    return false;
  };
  const inTable = () => tabled.has(current);
  // A </tr> or </tbody> closes the row or row group it names, or the one a browser added
  // (`implied`) around a row or cell written straight into a table, which is an element to it: so
  // in <table><td>a</tr>b, b is outside the cell, as in a browser, and not left in it.
  const closeRowPart = (tag: "tr" | "tbody"): boolean => {
    for (let node = current; node !== root && !TABLE_SCOPE.has(node.tag); node = node.parent!) {
      const adds = implied.get(node) ?? 0;
      if (node.tag === tag || (tag === "tr" ? adds > 0 && node.tag !== "tr" : adds === (node.tag === "tr" ? 1 : 2))) {
        closeThrough(node);
        return true;
      }
    }
    return false;
  };
  // A table part's start tag ends what is open inside the element it goes in, as a browser's parser
  // ends it ({@link TABLE_CONTEXTS}): so a cell ends the cell before it, and a row the row before it.
  // Ending only the innermost cell, as before, put a row written without its optional end tags
  // (<tr><td>a<td>b) inside the row before it, and valid HTML 255 rows long was too deep to read.
  // A formatting element ended so, written straight in the table (<table><b>), is reopened after it,
  // as a browser's list still holds it: not reopened, a hidden one left the text after the table shown.
  const clearTo = (context: ReadonlySet<string>) => {
    let inside: Element | undefined;
    for (let node = current; node !== root; node = node.parent!) {
      if (context.has(node.tag) || TABLE_SCOPE.has(node.tag)) {
        if (inside) closeThrough(inside, true);
        return;
      }
      inside = node;
    }
  };
  // A browser has one <html> and one <body>, as the HTML spec's "before html", "in head" and "after
  // head" steps build them: the <html> opened by its start tag or by any other, or text; the <body> by
  // its start tag, or by text or any start tag but those that go in the head ({@link HEAD}), which end
  // the head first. So a `body` rule applies to what follows a <head>, as it does to what a <body>
  // holds that isn't written. Any later start tag for either opens nothing: it adds to the one there
  // the attributes it hasn't, so what they hide the whole page hides. Opened inside what came first,
  // an <html> or <body> hid only what came after it; and each held the next, without counting in
  // `depth`, so a crafted message held 30,000 open and each of its end tags walked them all.
  const startHtml = (attrs: Record<string, string> = {}, legacy?: Record<string, string>): Element => {
    if (!sole.has("html")) open("html", attrs, true, legacy);
    return sole.get("html")!;
  };
  const startBody = (attrs: Record<string, string> = {}, legacy?: Record<string, string>) => {
    const page = startHtml();
    // What is open in the <html> (its <head>) ends, as it does for a browser.
    if (current !== page) {
      let top = current;
      while (top.parent !== page) top = top.parent!;
      closeThrough(top);
    }
    open("body", attrs, true, legacy);
  };
  const pageTag = (tag: string, attrs: Record<string, string>, legacy?: Record<string, string>) => {
    const element = sole.get(tag);
    if (element === undefined) {
      if (tag === "html") startHtml(attrs, legacy);
      else startBody(attrs, legacy);
      return;
    }
    // The one there: open still, as only its own end tag, which is ignored, names it. Its attributes
    // are its own, so each tag adds to them in place, costing what it holds: copied whole at each,
    // 16,000 <body> tags of one attribute each took 23.5 seconds in workerd.
    if (legacy !== undefined && element.legacy === undefined) element.legacy = { ...element.attrs };
    addAttributes(element.attrs, attrs);
    if (element.legacy !== undefined) addAttributes(element.legacy, legacy ?? attrs);
  };
  /** The open formatting element an end tag names, unless a table, cell or marker comes first. */
  const openFormatting = (tag: string): Element | undefined => {
    if (tag === "a") return linkOf.get(current);
    if (!openTags.get(tag)) return undefined;
    for (let node = current; node !== root; node = node.parent!) {
      if (node.tag === tag) return node;
      if (SCOPE.has(node.tag)) return undefined;
    }
  };
  // Closes a formatting element as a browser's parser does, for its end tag, and a link for a link
  // opened inside it too, so no link holds another and each link's text is its own. Of the elements
  // open inside it, a browser keeps the special ones (div, li) open, and the formatting ones (bold,
  // font) around them; reopens the formatting ones inside the innermost special one before the next
  // text; and closes the rest (span). This does the same, keeping elements open as copies. A browser
  // gives up with eight special elements inside and leaves the element open; so does this, reading no
  // further, and when the copies would pass what the message may copy.
  const closeFormatting = (element: Element): boolean => {
    const inside: Element[] = [];
    let specials = 0;
    for (let node = current; node !== element; node = node.parent!) {
      if (SPECIAL.has(node.tag) && ++specials >= 8) return false;
      inside.push(node);
    }
    const special = inside.findIndex(node => SPECIAL.has(node.tag));
    const kept = special === -1 ? [] : inside.slice(special).filter(node => FORMATTING.has(node.tag) || SPECIAL.has(node.tag));
    if (!afford(kept)) return false;
    for (const node of inside) closing(node);
    closing(element);
    current = element.parent!;
    for (const { tag, attrs, legacy } of kept.toReversed()) open(tag, attrs, true, legacy);
    queue((special === -1 ? inside : inside.slice(0, special)).filter(node => FORMATTING.has(node.tag)).toReversed());
    return true;
  };
  // An end tag that closed nothing, and a start tag that closed no paragraph, by the element they were
  // read in: read there again, each closes nothing again, as the elements open around it are the same,
  // so they aren't walked again. Repeated, each walked every open element, up to 512. A formatting
  // element's end tag still first takes a copy waiting to be reopened off its list, which can change
  // while the same elements are open.
  const idle = new Map<string, Element>();
  for (const token of tokenize(html, styles)) {
    // Too deep ({@link MAX_DEPTH}): nothing more is read.
    if (styles.unreadable) break;
    // A <colgroup> holds only <col>s: text or any other tag ends it first, as a browser's "in column
    // group" step does, so what follows is in the table, not in it.
    if (current.tag === "colgroup" && (token.type === "text" ? /[^ \t\n\f\r]/.test(token.text) : token.tag !== "col" && token.tag !== "colgroup")) {
      closeThrough(current);
    }
    if (token.type === "text") {
      const shows = /[^ \t\n\f\r]/.test(token.text);
      // Text but a <title>'s, the only element before the <body> that holds any, is in the <body>.
      if (shows && !sole.has("body") && current.tag !== "title") startBody();
      if ((pending.size > 0 || spent.size > 0) && shows) reopen();
      current.children.push({ text: token.text });
      continue;
    }
    // Outlook's namespaced tags (`o:p`, `v:shape`) are named whole, as a browser names them: elements it doesn't know.
    const tag = token.tag;
    if (token.type === "close") {
      // A browser's </body> and </html> close nothing: what follows goes where the document was.
      if (tag === "body" || tag === "html") continue;
      const at = current;
      if (!FORMATTING.has(tag)) {
        // A heading's end tag closes the innermost heading open, whatever its level, as a browser's does.
        const close = () => (tag === "tr" || tag === "tbody" ? closeRowPart(tag)
          : HEADINGS.has(tag) ? closeIfOpen(HEADING_TAGS, SCOPE) : closeTo(tag, endTagScope(tag)));
        if (idle.get(`/${tag}`) !== at && !close()) idle.set(`/${tag}`, at);
      } else if (!forget(tag) && idle.get(`/${tag}`) !== at) {
        // An </a> closes only a link in its own table cell, as a browser's does: a nested link's
        // leftover </a> must not close a link around the table.
        const element = openFormatting(tag);
        if (!element || !closeFormatting(element)) idle.set(`/${tag}`, at);
      }
      continue;
    }
    if (tag === "base") {
      base ??= token.attrs.href;
      continue;
    }
    if (tag === "html" || tag === "body") {
      pageTag(tag, token.attrs, token.legacy);
      continue;
    }
    if (!sole.has("body")) {
      if (HEAD.has(tag)) startHtml();
      else startBody();
    } else if (tag === "head") {
      // A <head> in the <body> opens nothing, as in a browser. Opened, it hid what followed it, and
      // its </head> closed what was open inside it, a hidden heading among them.
      continue;
    }
    if (TABLE_PARTS.has(tag) && !inTable()) continue;
    if (tag === "a" && !forget("a")) {
      const link = linkOf.get(current);
      if (link) closeFormatting(link);
    }
    // A <nobr> ends one open in scope, as a link ends a link, with the formatting elements around it reopened.
    if (tag === "nobr") {
      reopen();
      const nobr = openFormatting("nobr");
      if (nobr) closeFormatting(nobr);
    }
    if ((!SPECIAL.has(tag) || INLINE_SPECIAL.has(tag)) && !RUBY_PARTS.has(tag)) reopen();
    if (tag === "li") closeIfOpen(["li"], LIST_ITEM_STOPS);
    if (tag === "dd" || tag === "dt") closeIfOpen(["dd", "dt"], LIST_ITEM_STOPS);
    if (CLOSES_P.has(tag) && idle.get("<p") !== current) {
      const at = current;
      if (!closeIfOpen(["p"], BUTTON_SCOPE)) idle.set("<p", at);
    }
    if (HEADINGS.has(tag) && HEADINGS.has(current.tag)) closeThrough(current);
    if ((tag === "option" || tag === "optgroup") && current.tag === "option") closeThrough(current);
    const context = TABLE_CONTEXTS.get(tag);
    if (context) clearTo(context);
    // A <table> straight in a table, not in a cell or caption, ends it, and goes beside it.
    if (tag === "table" && inTable()) {
      for (let node = current; node !== root && node.tag !== "td" && node.tag !== "th" && node.tag !== "caption"; node = node.parent!) {
        if (node.tag === "table") {
          closeThrough(node);
          break;
        }
      }
    }
    // In a ruby, a part ends the one before it (an <rp> or <rt> ends no <rtc>), as a browser's parser
    // implies its end tag: so an <rt> written after an unclosed <rp> is shown, not hidden in it.
    if (RUBY_PARTS.has(tag) && rubied.has(current)) {
      const kept = tag === "rp" || tag === "rt" ? "rtc" : undefined;
      while (IMPLIED_ENDS.has(current.tag) && current.tag !== kept) closeTo(current.tag);
    }
    open(tag, token.attrs, !token.selfClosing && !VOID.has(tag), token.legacy);
  }
  return { root, styles, ...(base !== undefined ? { base } : {}) };
}

/**
 * A style rule: its selector list, its own declarations, whether it is nested in another style rule,
 * and whether it is in an at-rule's block (`@media print`, `@supports`), which may not apply.
 */
type CssRule = { selectors: string; declarations: string; nested: boolean; conditional: boolean };

/** An `@media` prelude of only `print` and `only print` queries, which no screen matches. */
const PRINT_ONLY = /^@media[\t\n\f\r ]+(?:only[\t\n\f\r ]+)?print[\t\n\f\r ]*(?:,[\t\n\f\r ]*(?:only[\t\n\f\r ]+)?print[\t\n\f\r ]*)*$/i;

/**
 * Each style rule of a stylesheet skeleton ({@link cssSkeleton}), in one pass, its blocks read as CSS
 * Syntax reads them. A rule's prelude runs from the end of the rule, at-rule or declaration before
 * it to its `{`: at the top level a stray `}` or `;` is part of it, and a leading `<!--` or `-->` is
 * not. A block with no prelude is a rule a browser drops, with all it holds. A rule's declarations
 * are its block's own text, without the rules nested in it, so those after a nested rule count too.
 * An at-rule ends at its `;` or its block, which holds rules. A `{`, `}` or `;` inside `(…)` or
 * `[…]` opens, closes and ends nothing, so a semicolon there is blanked: a function left open takes
 * the rest of the sheet. A block left open runs to the end of the sheet. Brackets cost a byte each,
 * so deep nesting costs little. Nothing in an `@media` block for print only (PRINT_ONLY) is read, as
 * a screen applies none of it; one for other media may apply. The regex `/([^{}@]+)\{([^{}]*)\}/g`
 * found the rules but not one left open nor one holding a block, and backtracked quadratically over a
 * long stylesheet with no braces.
 */
function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  type RuleBlock = CssRule & { own: number };
  // The open blocks, innermost last: a style rule's (its own text resumes at `own`), or null for an at-rule's.
  const blocks: (RuleBlock | null)[] = [];
  let rulesOpen = 0;
  let atRulesOpen = 0;
  // How many blocks were open around the `@media print` block open, if one is: nothing in it is a rule a screen applies.
  let printFrom = -1;
  // The open brackets' closing characters, innermost last; where the outermost opened, and whether
  // it is a dropped rule's block rather than a value's.
  let closers = new Uint8Array(16);
  let brackets = 0;
  let bracketsFrom = 0;
  let dropped = false;
  const bracket = (close: number) => {
    if (brackets === closers.length) {
      const grown = new Uint8Array(brackets * 2);
      grown.set(closers);
      closers = grown;
    }
    closers[brackets++] = close;
  };
  // The bracketed text up to `end`, its semicolons blanked, or nothing for a dropped rule's block.
  const bracketed = (end?: number) => (dropped ? "" : css.slice(bracketsFrom, end).replaceAll(";", " "));
  // Where the prelude or declaration being read starts, and whether it is an at-rule's, once known.
  let item = 0;
  let atRule: boolean | undefined;
  const isAtRule = () => {
    if (atRule === undefined) {
      const lead = blocks.length === 0 ? /(?:[\t\n\f\r ]|<!--|-->)*@/y : /[\t\n\f\r ]*@/y;
      lead.lastIndex = item;
      atRule = lead.test(css);
    }
    return atRule;
  };
  const next = (at: number) => {
    item = at;
    atRule = undefined;
  };
  const STRUCTURE = /[{}()[\];]/g;
  for (let match = STRUCTURE.exec(css); match; match = STRUCTURE.exec(css)) {
    const at = match.index;
    const code = css.charCodeAt(at);
    const top = blocks.at(-1);
    if (brackets > 0) {
      if (code === closers[brackets - 1]) {
        if (--brackets > 0) continue;
        if (top) {
          top.declarations += css.slice(top.own, bracketsFrom) + bracketed(at + 1);
          top.own = at + 1;
        }
        if (dropped) next(at + 1);
      } else if (code === 40 || code === 91 || code === 123) {
        bracket(code === 40 ? 41 : code === 91 ? 93 : 125);
      }
    } else if (code === 40 || code === 91) {
      bracketsFrom = at;
      dropped = false;
      bracket(code === 40 ? 41 : 93);
    } else if (code === 59) {
      if (blocks.length > 0 || isAtRule()) next(at + 1);
    } else if (code === 123) {
      const selectors = isAtRule() ? undefined : css.slice(item, at).replace(blocks.length === 0 ? /^(?:[\t\n\f\r ]|<!--|-->)*/ : /^[\t\n\f\r ]*/, "");
      if (selectors === "") {
        bracketsFrom = item;
        dropped = true;
        bracket(125);
        continue;
      }
      if (top) top.declarations += css.slice(top.own, item);
      if (selectors === undefined) {
        if (printFrom === -1 && PRINT_ONLY.test(css.slice(css.indexOf("@", item), at))) printFrom = blocks.length;
        blocks.push(null);
        atRulesOpen++;
      } else {
        const rule = { selectors, declarations: "", nested: rulesOpen > 0, conditional: atRulesOpen > 0, own: at + 1 };
        if (printFrom === -1) rules.push(rule);
        blocks.push(rule);
        rulesOpen++;
      }
      next(at + 1);
    } else if (code === 125 && blocks.length > 0) {
      blocks.pop();
      if (top) {
        top.declarations += css.slice(top.own, at);
        rulesOpen--;
      } else {
        atRulesOpen--;
      }
      if (blocks.length === printFrom) printFrom = -1;
      const parent = blocks.at(-1);
      if (parent) parent.own = at + 1;
      next(at + 1);
    }
  }
  // The innermost block left open runs to the end, a bracket left open in it too; those around it stopped where it began.
  const top = blocks.at(-1);
  if (top) top.declarations += brackets === 0 ? css.slice(top.own) : css.slice(top.own, bracketsFrom) + bracketed();
  return rules;
}

/** A declaration's value, lower-cased, and whether it is `!important`. */
type Declaration = { value: string; important: boolean };
/** A block's declarations: those a browser keeps (`valid`), and those read only because they would hide (`hiding`). */
type Declarations = { valid: Map<string, Declaration>; hiding: Map<string, Declaration> };

/** Whitespace JavaScript's `\s` and `trim` take that CSS doesn't (a no-break space, U+3000, U+FEFF…): to CSS, part of a name. */
const NOT_CSS_SPACE = /[^\S\t\n\f\r ]/;

/** Text without the whitespace CSS has (tab, newline, form feed, carriage return, space) at either end. */
function cssTrim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isCssWhitespace(text.charCodeAt(start))) start++;
  while (end > start && isCssWhitespace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

/**
 * A declaration block's declarations of the properties the converter reads (READ_PROPERTIES), from a
 * skeleton ({@link cssSkeleton}), as a browser reads them: split at semicolons outside brackets, with
 * `!important` (CSS whitespace allowed after the `!`) read off the end, and names lower-cased in
 * ASCII. One whose value every major browser accepts ({@link validValue}) is `valid`: of two for one
 * property an important one wins, and otherwise the later. One that isn't is dropped, so it overrides
 * nothing, unless it would hide its element ({@link hidingStrength}): then it is kept apart
 * (`hiding`), read only where reading it can hide ({@link styleOf}), until a valid one at least as
 * important comes after it; of two, the one that hides more surely. A value holding whitespace CSS
 * doesn't have is never valid. `font` is read as the `font-size` it sets, and `background` as the
 * `background-color`.
 */
function parseDeclarations(css: string, quirks: boolean): Declarations {
  const valid = new Map<string, Declaration>();
  const hiding = new Map<string, Declaration>();
  const add = (text: string) => {
    const colon = text.indexOf(":");
    if (colon <= 0) return;
    const property = asciiLowerCase(cssTrim(text.slice(0, colon)));
    const read = property === "font" ? "font-size" : property === "background" ? "background-color" : property;
    if (!READ_PROPERTIES.has(read)) return;
    let value = asciiLowerCase(cssTrim(text.slice(colon + 1)));
    const bang = /![\t\n\f\r ]*important$/.exec(value);
    if (bang) value = cssTrim(value.slice(0, bang.index));
    const important = bang !== null;
    // A `!` anywhere else (`#000 !important !important`) is one a browser rejects the declaration for.
    if (value.includes("!")) return;
    const accepted = NOT_CSS_SPACE.test(value) ? undefined : validValue(property, value, quirks);
    if (accepted !== undefined) {
      // One after an important one loses to it.
      if (valid.get(read)?.important && !important) return;
      valid.set(read, { value: accepted, important });
      if (important || !hiding.get(read)?.important) hiding.delete(read);
    } else {
      const strength = hidingStrength(read, value);
      const held = hiding.get(read);
      const heldStrength = held ? hidingStrength(read, held.value) : -1;
      if (strength === 0 || heldStrength > strength || (heldStrength === strength && held!.important && !important)) return;
      hiding.set(read, { value, important });
    }
  };
  // The open brackets' closing characters, innermost last: a semicolon inside one ends nothing.
  const closers: string[] = [];
  let from = 0;
  const STRUCTURE = /[()[\]{};]/g;
  for (let match = STRUCTURE.exec(css); match; match = STRUCTURE.exec(css)) {
    const char = match[0];
    if (char === ";" && closers.length === 0) {
      add(css.slice(from, match.index));
      from = match.index + 1;
    } else if (char === closers.at(-1)) {
      closers.pop();
    } else if (char === "(" || char === "[" || char === "{") {
      closers.push(char === "(" ? ")" : char === "[" ? "]" : "}");
    }
  }
  add(css.slice(from));
  return { valid, hiding };
}

/** CSS's keywords that every property takes. */
const CSS_WIDE = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
/** A CSS number: a sign, digits with a fraction or without, or a fraction alone, and an exponent. */
const CSS_NUMBER = String.raw`[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:e[+-]?[0-9]+)?`;
const NUMBER = new RegExp(`^${CSS_NUMBER}$`);
/** A number with a length's unit, a percentage, or no unit. */
const DIMENSION = new RegExp(`^(${CSS_NUMBER})(%|px|cm|mm|q|in|pt|pc|r?(?:em|ex|ch|ic|cap|lh)|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))?$`);

/** What a length property takes: negative values, percentages, its keywords, and the number of pixels at which it hides. */
type LengthGrammar = { negative: boolean; keywords: ReadonlySet<string>; hides: (pixels: number) => boolean };
const SIZE_KEYWORDS = ["min-content", "max-content", "fit-content"];
const SIZE: LengthGrammar = { negative: false, keywords: new Set(["auto", ...SIZE_KEYWORDS]), hides: pixels => pixels <= MAX_CLIPPED_PX };
const MAX_SIZE: LengthGrammar = { negative: false, keywords: new Set(["none", ...SIZE_KEYWORDS]), hides: pixels => pixels <= MAX_CLIPPED_PX };
const OFFSET: LengthGrammar = { negative: true, keywords: new Set(["auto"]), hides: pixels => pixels <= OFF_SCREEN_PX };
const FONT_SIZE: LengthGrammar = {
  negative: false,
  keywords: new Set(["xx-small", "x-small", "small", "medium", "large", "x-large", "xx-large", "xxx-large", "smaller", "larger"]),
  hides: pixels => pixels <= MAX_HIDDEN_FONT_PX,
};
const LENGTHS: ReadonlyMap<string, LengthGrammar> = new Map([
  ["width", SIZE], ["height", SIZE], ["max-width", MAX_SIZE], ["max-height", MAX_SIZE],
  ["left", OFFSET], ["top", OFFSET], ["right", OFFSET], ["bottom", OFFSET], ["margin-left", OFFSET], ["margin-top", OFFSET],
  ["text-indent", { negative: true, keywords: new Set(), hides: pixels => pixels <= OFF_SCREEN_PX }],
  ["letter-spacing", { negative: true, keywords: new Set(["normal"]), hides: pixels => pixels <= COLLAPSED_SPACING_PX }],
  ["font-size", FONT_SIZE],
]);

/**
 * A length a browser accepts. With no unit, a number is a length when it is zero, or in quirks mode,
 * where a browser reads a message with no doctype. A doctype can leave a browser in quirks mode too,
 * so with one, a number with no unit is read where it would hide, and not where it would show. So is
 * a length in a unit not every major browser has had for long (`rcap`, `rch`, `rex`, `ric`).
 */
function lengthValue(value: string, grammar: LengthGrammar, quirks: boolean): string | undefined {
  if (grammar.keywords.has(value)) return value;
  const match = DIMENSION.exec(value);
  if (!match) return undefined;
  const number = Number(match[1]);
  if (number < 0 && !grammar.negative) return undefined;
  const unsure = match[2] === undefined ? !quirks : /^r(?:cap|ch|ex|ic)$/.test(match[2]);
  if (unsure && number !== 0 && !grammar.hides(cssLength(value) ?? Number.POSITIVE_INFINITY)) return undefined;
  return value;
}

/** `display`'s keywords every major browser accepts alone (not `math`, `ruby` or `ruby-text`). */
const DISPLAY = new Set([
  "none", "contents", "block", "inline", "flow", "flow-root", "table", "flex", "grid", "list-item", "inline-block", "inline-table",
  "inline-flex", "inline-grid", "table-row-group", "table-header-group", "table-footer-group", "table-row", "table-cell", "table-column-group",
  "table-column", "table-caption", "-webkit-box", "-webkit-inline-box", "-webkit-flex", "-webkit-inline-flex",
]);
const DISPLAY_OUTSIDE = new Set(["block", "inline"]);
const DISPLAY_INSIDE = new Set(["flow", "flow-root", "table", "flex", "grid"]);

/** A `display` every major browser accepts: one keyword, or an outer and an inner one (`block flow`), but not with `list-item`. */
function displayValue(value: string): string | undefined {
  if (DISPLAY.has(value)) return value;
  const [first = "", second = "", ...rest] = value.split(/\s+/);
  return rest.length === 0 && ((DISPLAY_OUTSIDE.has(first) && DISPLAY_INSIDE.has(second)) || (DISPLAY_INSIDE.has(first) && DISPLAY_OUTSIDE.has(second)))
    ? value : undefined;
}

const FONT_STRETCH = new Set(["ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "semi-expanded", "expanded", "extra-expanded", "ultra-expanded"]);
const SYSTEM_FONTS = new Set(["caption", "icon", "menu", "message-box", "small-caption", "status-bar"]);
const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "cursive", "fantasy", "monospace", "system-ui", "emoji", "math", "fangsong", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "-webkit-body", "-webkit-pictograph", "-moz-fixed"]);
const FAMILY_WORD = /^(?:--|-?[a-z_\u0080-\uffff])[\w\u0080-\uffff-]*$/;
const ANGLE = new RegExp(`^(${CSS_NUMBER})(deg|grad|rad|turn)$`);
const DEGREES: Readonly<Record<string, number>> = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };
const OPACITY = new RegExp(`^${CSS_NUMBER}%?$`);
const OVERFLOW = new Set(["visible", "hidden", "clip", "scroll", "auto"]);

/**
 * The `font-size` a `font` shorthand sets, if a browser accepts it: up to four style, variant, weight
 * and stretch keywords (`normal` for any), `oblique` with an angle of at most 90 degrees either way
 * (a grad counted as a degree), then the size, with no unit only when zero, then `/` and a line
 * height, then families. A shorthand that sets a size small enough to hide text is read however its
 * angle and families are written, since reading it hides more, never less.
 */
function fontShorthandSize(value: string): string | undefined {
  if (CSS_WIDE.has(value)) return value;
  if (SYSTEM_FONTS.has(value)) return "medium";
  const words = value.match(/[^\s/,]+|[/,]/g) ?? [];
  const seen = new Set<string>();
  let bounded = true;
  let at = 0;
  for (; at < words.length && seen.size < 4; at++) {
    const word = words[at]!;
    const kind = word === "normal" ? `normal${at}` : word === "italic" || word === "oblique" ? "style" : word === "small-caps" ? "variant"
      : word === "bold" || word === "bolder" || word === "lighter" || (NUMBER.test(word) && Number(word) >= 1 && Number(word) <= 1000) ? "weight"
        : FONT_STRETCH.has(word) ? "stretch" : undefined;
    if (kind === undefined) break;
    if (seen.has(kind)) return undefined;
    seen.add(kind);
    const angle = word === "oblique" ? ANGLE.exec(words[at + 1] ?? "") : null;
    if (angle) {
      bounded = Math.abs(Number(angle[1])) * Math.max(1, DEGREES[angle[2]!]!) <= 90;
      at++;
    }
  }
  const size = words[at];
  if (size === undefined || lengthValue(size, FONT_SIZE, false) === undefined) return undefined;
  if ((cssLength(size) ?? Infinity) <= MAX_HIDDEN_FONT_PX) return size;
  if (!bounded) return undefined;
  let family = at + 1;
  if (words[family] === "/") {
    const height = words[family + 1] ?? "";
    if (height !== "normal" && !(DIMENSION.test(height) && !height.startsWith("-"))) return undefined;
    family += 2;
  }
  // Families: comma-separated, each a string alone or names, none a reserved word; a generic one alone.
  const entries = words.slice(family).join(" ").split(",").map(entry => entry.trim().split(" "));
  const valid = family < words.length && entries.every(entry => entry[0] === "\"\"" ? entry.length === 1 : entry.every(word => FAMILY_WORD.test(word)
    && !CSS_WIDE.has(word) && word !== "default" && (entry.length === 1 || !GENERIC_FAMILIES.has(word))));
  return valid ? size : undefined;
}

/** A colour a browser accepts, as far as `parseColor` reads them; a hex colour needs its `#` but in quirks mode. */
const colorValue = (value: string, quirks: boolean) =>
  value === "currentcolor" || (parseColor(value) !== undefined && (value.startsWith("#") || !/^[0-9a-f]+$/.test(value) || (quirks && (value.length === 3 || value.length === 6))))
    ? value : undefined;

/** Keyword sets of the properties read as keywords. */
const KEYWORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["visibility", new Set(["visible", "hidden", "collapse"])],
  ["position", new Set(["static", "relative", "absolute", "fixed", "sticky"])],
  ["overflow-x", OVERFLOW],
  ["overflow-y", OVERFLOW],
]);

/**
 * A declaration's value as it is read, if every major browser has long accepted it for the property:
 * a keyword every property takes; `display`'s keywords, one or two; a keyword of `visibility`,
 * `position` and `overflow`; `opacity` as a number or percentage; lengths (in {@link lengthValue});
 * the size of a `font` shorthand; a colour, and the one a `background` shorthand sets; `none` for a
 * `transform` or `clip-path`, `auto` for a `clip`; Word's `mso-list`. Anything else, `var()` and
 * maths functions such as `calc()` included, is not read, so it overrides nothing ({@link
 * parseDeclarations} still reads one that would hide). Before, other properties' values were read as
 * written, so `transform: scale(red) !important` overrode a later `transform: scale(0)`.
 */
function validValue(property: string, value: string, quirks: boolean): string | undefined {
  if (value === "") return undefined;
  if (CSS_WIDE.has(value)) return value;
  const length = LENGTHS.get(property);
  // Chrome reads a percentage in letter spacing only since version 145.
  if (property === "letter-spacing" && value.endsWith("%")) return undefined;
  if (length) return lengthValue(value, length, quirks);
  const keywords = KEYWORDS.get(property);
  if (keywords) return keywords.has(value) ? value : undefined;
  switch (property) {
    case "display": return displayValue(value);
    case "opacity": return OPACITY.test(value) ? value : undefined;
    case "overflow": {
      const words = value.split(/\s+/);
      return words.length <= 2 && words.every(word => OVERFLOW.has(word)) ? value : undefined;
    }
    case "font": return fontShorthandSize(value);
    case "color": case "background-color": return colorValue(value, quirks);
    case "background": return backgroundValue(value);
    case "transform": case "clip-path": return value === "none" ? value : undefined;
    case "clip": return value === "auto" ? value : undefined;
    case "mso-list": return value;
    default: return undefined;
  }
}

const POSITION_X = new Set(["left", "center", "right"]);
const POSITION_Y = new Set(["top", "center", "bottom"]);
const POSITION: LengthGrammar = { negative: true, keywords: new Set(), hides: () => false };
const BACKGROUND_SIZE: LengthGrammar = { negative: false, keywords: new Set(["auto"]), hides: () => false };
const BACKGROUND_WORDS: ReadonlyMap<string, string> = new Map([
  ...["repeat-x", "repeat-y", "repeat", "space", "round", "no-repeat"].map(word => [word, "repeat"] as const),
  ...["scroll", "fixed", "local"].map(word => [word, "attachment"] as const),
  ...["border-box", "padding-box", "content-box"].map(word => [word, "box"] as const),
  ["none", "image"],
]);

/**
 * The colour a `background` shorthand sets, `transparent` when it sets none, if it is one layer that
 * every major browser accepts and is read here: a colour, an image (`none` or a `url()`), a repeat,
 * an attachment, up to two boxes, and a position of one or two values with a size after a `/`.
 * Another (a gradient, several layers, a three-value position) is not read, so it overrides nothing.
 */
function backgroundValue(value: string): string | undefined {
  const tokens = value.match(/[a-z-]+\([^()]*\)|[^\s/()]+|[/()]/g) ?? [];
  const isLength = (token: string | undefined, grammar: LengthGrammar) => token !== undefined && lengthValue(token, grammar, false) !== undefined;
  const isPosition = (token: string | undefined, axis: ReadonlySet<string>) => token !== undefined && (axis.has(token) || isLength(token, POSITION));
  const seen = new Map<string, number>();
  let color = "transparent";
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    let kind = BACKGROUND_WORDS.get(token) ?? (/^url\(\s*(?:"")?\s*\)$/.test(token) ? "image" : undefined);
    if (kind === "repeat" && !token.startsWith("repeat-") && /^(?:repeat|space|round|no-repeat)$/.test(tokens[at + 1] ?? "")) {
      at++;
    } else if (kind === undefined && (isPosition(token, POSITION_X) || isPosition(token, POSITION_Y))) {
      kind = "position";
      const next = tokens[at + 1];
      if ((isPosition(token, POSITION_X) && isPosition(next, POSITION_Y)) || (POSITION_Y.has(token) && POSITION_X.has(next ?? ""))) at++;
      if (tokens[at + 1] === "/") {
        at += 2;
        if (tokens[at] !== "cover" && tokens[at] !== "contain") {
          if (!isLength(tokens[at], BACKGROUND_SIZE)) return undefined;
          if (isLength(tokens[at + 1], BACKGROUND_SIZE)) at++;
        }
      }
    } else if (kind === undefined && colorValue(token, false) !== undefined) {
      kind = "color";
      color = token;
    }
    const count = (seen.get(kind ?? "") ?? 0) + 1;
    if (kind === undefined || count > (kind === "box" ? 2 : 1)) return undefined;
    seen.set(kind, count);
  }
  return tokens.length > 0 ? color : undefined;
}

/**
 * What a message's own <style> blocks say about its elements, which inline styles alone would miss:
 * hiding (`.preheader { display: none }`), and the colours and sizes that decide whether text shows.
 * Hiding may be read loosely, but showing only where a rule certainly applies. So a rule is kept two
 * ways. Where a browser certainly applies it as read (`proven`): one compound of a type, classes,
 * IDs and attribute tests, in no at-rule and not nested, in a selector list a browser can't drop.
 * And loosely, by its last compound's classes, IDs or else type, as a browser may apply it
 * (`loose`, `pin`): there a hiding selector's last compound decides, so `table td.x` hides every
 * `.x`, and colours and sizes come only from single-compound selectors (`.x`, `td.x`), since
 * `.header a { color: #fff }` says nothing about the links elsewhere.
 */
export type StyleRules = {
  /** Rules certainly applied as read, by their compound's first ID, else class, else type, else `*`: `#id`, `.class`, `td`, `*`. */
  proven: Map<string, Proven[]>;
  /** For each key, as {@link styleOf} reads them: the values that may hide, and the colours and sizes of rules not proven. */
  loose: Map<string, Map<string, Candidate>>;
  /** For each key, the last value of each property its rules set, as the reader before this one read them ({@link pinStylesheetRules}). */
  pin: Map<string, Map<string, string>>;
  /** Attributes whose presence a hiding rule selects on (`[data-preheader]`). */
  hiddenAttributes: Set<string>;
  /** Whether the message is read in quirks mode, as a browser reads one with no doctype. */
  quirks: boolean;
};

/** A declaration's value and its weight in the cascade ({@link weigh}). */
type Weighted = { value: string; weight: number };
/** A declaration that may apply, and how surely it hides ({@link hidingStrength}; colours and sizes count 1). */
type Candidate = Weighted & { strength: number };
/** A compound's classes, IDs, and attributes or their values. */
type Tests = { classes: string[]; ids: string[]; attributes: [name: string, value?: string][] };
/**
 * A rule a browser certainly applies to an element its compound matches: its type and its tests, as
 * written and folded to lower case in ASCII, and its declarations, with those that may hide where it
 * matches only ignoring case ({@link candidate}).
 */
type Proven = { tag?: string; tests: Tests; folded: Tests; declarations: ReadonlyMap<string, Weighted>; candidates: ReadonlyMap<string, Candidate> };

/** A specificity above any selector's: an element's own `style` attribute. */
const INLINE_SPECIFICITY = 2 ** 24;
/**
 * A declaration's place in the cascade as one number, so the highest wins: importance first, then
 * specificity (a `style` attribute's above any selector's), then source order.
 */
const weigh = (important: boolean, specificity: number, order: number) => (important ? 2 ** 50 : 0) + specificity * 2 ** 24 + order;

/** A selector's parts as specificity counts them: attribute tests, pseudo-classes and pseudo-elements, IDs, classes and types. */
const SPECIFICITY_PARTS = /\[[^\]]*\]?|::?[\w\u0080-\uffff-]*|[#.]?[\w\u0080-\uffff-]+/g;

/**
 * A selector's specificity as one number: IDs, then classes, attribute tests and pseudo-classes, then
 * types and pseudo-elements, each counted up to 255. A pseudo-class's argument is counted as part of
 * the selector, which is more than `:where()`, `:not()` or `:nth-child()` add.
 */
function specificity(selector: string): number {
  let ids = 0;
  let classes = 0;
  let types = 0;
  for (const [part] of selector.matchAll(SPECIFICITY_PARTS)) {
    if (part[0] === "#") ids++;
    else if (part.startsWith("::")) types++;
    else if (part[0] === "." || part[0] === "[" || part[0] === ":") classes++;
    else if (!/^[0-9-]/.test(part)) types++;
  }
  return Math.min(ids, 255) * 65_536 + Math.min(classes, 255) * 256 + Math.min(types, 255);
}

/**
 * The declarations text inherits, the only ones taken from `html` and `body` rules, as upstream takes
 * them. What else such a rule sets (`display`, `visibility`, `opacity`) isn't read, though a browser
 * applies it; `<body hidden>` and a `<body>` style that hides do hide the whole message.
 */
const INHERITED_PROPERTIES = new Set(["color", "background-color", "font-size"]);
const isPage = (key: string) => key === "html" || key === "body";
/** The declarations that decide whether text shows by what is around it, not by hiding its element. */
const TEXT_PROPERTIES = new Set([...INHERITED_PROPERTIES, "mso-list"]);

/**
 * Every property the converter reads from an element's style; a stylesheet's other declarations are
 * dropped as it is read. Kept, they were copied for every selector in a rule and every element a
 * rule matched, so a long rule over many elements cost their product. A property read from a style
 * must be listed here.
 */
const READ_PROPERTIES = new Set([
  "display", "visibility", "mso-hide", "content-visibility", "opacity", "overflow", "overflow-x", "overflow-y",
  "max-height", "height", "max-width", "width", "position", "left", "top", "right", "bottom", "margin-left", "margin-top",
  "text-indent", "letter-spacing", "clip", "clip-path", "transform", "scale", "filter", ...TEXT_PROPERTIES,
]);

/** What a declaration needs beside it to hide where it doesn't alone: a small box clips only with `overflow`, an offset moves only a positioned box. */
const HIDING_PARTNERS = new Map<string, readonly [string, string]>([
  ...["overflow", "overflow-x", "overflow-y"].map(property => [property, ["height", "1px"]] as const),
  ...["height", "width", "max-height", "max-width"].map(property => [property, ["overflow", "hidden"]] as const),
  ["position", ["left", "-9999px"]],
  ...["left", "top", "right", "bottom"].map(property => [property, ["position", "absolute"]] as const),
]);

/** How surely a declaration hides its element: 2 alone, 1 beside its partner ({@link HIDING_PARTNERS}), 0 not at all. */
function hidingStrength(property: string, value: string): number {
  if (hidesElement(new Map([[property, value]]))) return 2;
  const partner = HIDING_PARTNERS.get(property);
  return partner && hidesElement(new Map([[property, value], partner])) ? 1 : 0;
}

/** A declaration that may apply, unless it can't hide: colours and sizes, which hide by what is around them, always may. */
function candidate(property: string, value: string, weight: number): Candidate | undefined {
  const strength = TEXT_PROPERTIES.has(property) ? 1 : hidingStrength(property, value);
  return strength > 0 ? { value, weight, strength } : undefined;
}

/**
 * Keeps, of the declarations that may apply for a property, the one most sure to hide, at the
 * highest weight any of them has: so one that doesn't hide is never kept, and one that hides is
 * read as winning wherever any of them could. Of colours and sizes, the highest-weighted.
 */
function keep(into: Map<string, Candidate>, property: string, next: Candidate | undefined): void {
  const held = into.get(property);
  if (!next || (held && held.strength >= next.strength && held.weight >= next.weight)) return;
  into.set(property, !held || next.strength > held.strength || next.weight > held.weight
    ? { ...next, weight: Math.max(next.weight, held?.weight ?? -1) } : held);
}

/**
 * The longest value of a rule read as written. A rule's values are read at every element it applies
 * to, so a long one (`color: rgb(255 255 255 …)`, padded) over many elements cost their product. A
 * rule with a longer one hides what it may apply to, unread: no mail writes one so long.
 */
const MAX_RULE_VALUE_CHARS = 256;
/** A property no declaration sets: one too long to read sets it in `pin` ({@link pinStylesheetRules}), and it hides ({@link pinHides}). */
const UNREAD = "unread value";

/** CSS's whitespace, for a pattern: not JavaScript's `\s`, which takes a no-break space that CSS reads as part of a name. */
const CSS_SPACE = String.raw`[\t\n\f\r ]`;

/**
 * A selector list's member as a browser reads it: compounds of a type or `*`, classes, IDs, attribute
 * tests and pseudo-classes, joined by combinators. Linear: each part starts with its own character.
 */
const CSS_NAME = String.raw`[\w\u0080-\uffff-]+`;
const SUBCLASS = String.raw`(?:[.#]${CSS_NAME}|\[[^\]]*\]|::?${CSS_NAME}(?:\([^)]*\))?)`;
const COMPOUND = String.raw`(?:(?:${CSS_NAME}|\*)${SUBCLASS}*|${SUBCLASS}+)`;
const READABLE_SELECTOR = new RegExp(String.raw`^${COMPOUND}(?:${CSS_SPACE}*[>+~]${CSS_SPACE}*${COMPOUND}|${CSS_SPACE}+${COMPOUND})*$`, "i");

/**
 * A selector list's member every browser accepts as read: compounds of a type or `*`, classes, IDs and
 * attribute tests (no pseudo-classes, and names CSS allows), joined by combinators.
 */
const IDENT = String.raw`(?:--|-?[a-z_\u0080-\uffff])[\w\u0080-\uffff-]*`;
const ATTRIBUTE = String.raw`\[${CSS_SPACE}*${IDENT}${CSS_SPACE}*(?:[~|^$*]?=${CSS_SPACE}*(?:${IDENT}|"")${CSS_SPACE}*(?:i${CSS_SPACE}*)?)?\]`;
const PLAIN_COMPOUND = String.raw`(?:(?:${IDENT}|\*)(?:[.#]${IDENT}|${ATTRIBUTE})*|(?:[.#]${IDENT}|${ATTRIBUTE})+)`;
const PLAIN_SELECTOR = new RegExp(String.raw`^${CSS_SPACE}*${PLAIN_COMPOUND}(?:${CSS_SPACE}*[>+~]${CSS_SPACE}*${PLAIN_COMPOUND}|${CSS_SPACE}+${PLAIN_COMPOUND})*${CSS_SPACE}*$`, "i");
/** A plain compound's parts: its type or `*`, a class or ID, an attribute or its exact value, or anything else, which isn't proven. */
const COMPOUND_PART = new RegExp(String.raw`^(${IDENT}|\*)|([.#])(${IDENT})|\[${CSS_SPACE}*(${IDENT})${CSS_SPACE}*(?:=${CSS_SPACE}*(${IDENT})${CSS_SPACE}*)?\]|([^])`, "gi");
/** The most proven rules kept for one key; past that, a rule is read loosely, so the work an element costs is bounded. */
const MAX_PROVEN_RULES = 32;

/** The most classes, IDs and attribute tests a proven compound has; past that (`.x.x.x…`), matching it could cost more than its length. */
const MAX_COMPOUND_TESTS = 16;

/**
 * A plain compound as a proven rule, and the key it is found by, unless it has a part not proven
 * (`[a^=b]`) or too many. Its tests are folded here, once: folded at every element they were tested
 * on, a long class or value cost its length there, so a long rule over many elements cost their
 * product. Of an `html` or `body` rule, only what text inherits is kept.
 */
function provenRule(compound: string, declarations: ReadonlyMap<string, Weighted>): { key: string; rule: Proven } | undefined {
  const tests: Tests = { classes: [], ids: [], attributes: [] };
  let type: string | undefined;
  for (const [, tag, sigil, name, attribute, value, other] of compound.matchAll(COMPOUND_PART)) {
    if (other !== undefined) return undefined;
    if (tag === "*") continue;
    if (tag !== undefined) type = asciiLowerCase(tag);
    else if (sigil === ".") tests.classes.push(name!);
    else if (sigil === "#") tests.ids.push(name!);
    else tests.attributes.push([asciiLowerCase(attribute!), value]);
    if (tests.classes.length + tests.ids.length + tests.attributes.length > MAX_COMPOUND_TESTS) return undefined;
  }
  const folded: Tests = {
    classes: tests.classes.map(asciiLowerCase),
    ids: tests.ids.map(asciiLowerCase),
    attributes: tests.attributes.map(([name, value]) => [name, value === undefined ? undefined : asciiLowerCase(value)]),
  };
  const key = folded.ids[0] !== undefined ? `#${folded.ids[0]}` : folded.classes[0] !== undefined ? `.${folded.classes[0]}` : type ?? "*";
  const kept = isPage(key) ? new Map([...declarations].filter(([property]) => INHERITED_PROPERTIES.has(property))) : declarations;
  const candidates = new Map<string, Candidate>();
  for (const [property, { value, weight }] of kept) keep(candidates, property, candidate(property, value, weight));
  return { key, rule: { tag: type, tests, folded, declarations: kept, candidates } };
}

/**
 * The keys a rule is read under for a compound selector (`loose`, `pin`): its classes and IDs, else,
 * if it tests no attribute, its type or `*`; and the attributes it tests. A value test (`=`, `^=`,
 * `*=`…) is read as "has the attribute", hiding at least as much. `legacy`, its attributes are those
 * the reader before this one read ({@link pinAttributes}).
 */
function keysOf(compound: string, legacy = false): { keys: string[]; attributes: string[] } {
  const keys = [...compound.matchAll(/([.#])([a-z0-9_-]+)/gi)].map(([, sigil, name]) => sigil! + name!.toLowerCase());
  const attributes = (legacy ? pinAttributes(compound) : selectedAttributes(compound)).map(name => name.toLowerCase());
  const tag = /^([a-z][a-z0-9]*|\*)/i.exec(compound)?.[1]?.toLowerCase();
  if (keys.length === 0 && attributes.length === 0 && tag !== undefined) keys.push(tag);
  return { keys, attributes };
}

/**
 * Declarations as the reader before this one read them: split at every semicolon, trimmed and
 * lower-cased as JavaScript does, `!important` dropped wherever it stands, the last of a property
 * winning, and `background` read as its first word that is a colour. Only what the converter reads
 * is kept (READ_PROPERTIES).
 */
function pinDeclarations(css: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const declaration of css.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon <= 0) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    if (!READ_PROPERTIES.has(name) && name !== "background") continue;
    const value = declaration.slice(colon + 1).replace(/!important/i, "").trim().toLowerCase();
    declarations.set(name, name === "background" ? value.split(/\s+/).find(part => parseColor(part, true) !== undefined) ?? "" : value);
  }
  return declarations;
}

/**
 * The attributes the reader before this one read a compound selector as testing, by
 * `/\[\s*([a-z0-9_:-]+)\s*(?:[~|^$*]?=\s*["']?[^"'\]]*["']?\s*)?\]/gi`, in one pass: that searched
 * the rest again from every `[` with a name and `=` after it. The compounds it read held no
 * whitespace, so a test is a name, and either its `]` or an `=` (`|=`, `^=`…) and a value that holds
 * a quote only at either end, to the first `]`. Whether it finds one decides whether a rule is read
 * for the compound's type.
 */
function pinAttributes(compound: string): string[] {
  const names: string[] = [];
  const name = /[a-z0-9_:-]+/iy;
  let close = -1;
  // The last three quotes before `close`: with more, a value holds one inside.
  let quotes: number[] = [];
  for (let open = compound.indexOf("["); open !== -1; open = compound.indexOf("[", open + 1)) {
    if (open > close) {
      close = compound.indexOf("]", open);
      if (close === -1) break;
      quotes = [];
      for (let at = close - 1; at > open && quotes.length < 3; at--) if (compound[at] === "\"" || compound[at] === "'") quotes.unshift(at);
    }
    name.lastIndex = open + 1;
    const read = name.exec(compound)?.[0];
    if (read === undefined) continue;
    let value = name.lastIndex;
    if (value !== close) {
      value += "~|^$*".includes(compound[value]!) ? 1 : 0;
      if (compound[value] !== "=") continue;
      const inside = quotes.filter(at => at > value);
      if (inside.length > 2 || (inside.length === 2 && (inside[0] !== value + 1 || inside[1] !== close - 1))
        || (inside.length === 1 && inside[0] !== value + 1 && inside[0] !== close - 1)) continue;
    }
    names.push(read);
    open = close;
  }
  return names;
}

/** CSS without its comments, as `replace(/\/\*[\s\S]*?\*\//g, "")` left it, in one pass: from an unclosed one on, nothing is removed. */
function withoutComments(css: string): string {
  let kept = "";
  let from = 0;
  for (let open = css.indexOf("/*"); open !== -1; open = css.indexOf("/*", from)) {
    const close = css.indexOf("*/", open + 2);
    if (close === -1) break;
    kept += css.slice(from, open);
    from = close + 2;
  }
  return kept + css.slice(from);
}

/**
 * A stylesheet's rules as the reader before this one found them: each innermost `{…}` block, its
 * selectors whatever follows the last `}` or `@` before it, so a rule in `@media print` is one.
 */
function pinCssRules(css: string): Pick<CssRule, "selectors" | "declarations">[] {
  const rules: Pick<CssRule, "selectors" | "declarations">[] = [];
  let from = 0;
  let close = -1;
  for (let open = css.indexOf("{"); open !== -1;) {
    if (close < open) close = css.indexOf("}", open + 1);
    if (close === -1) break;
    const next = css.indexOf("{", open + 1);
    const before = css.slice(from, open);
    const selectors = before.slice(Math.max(before.lastIndexOf("}"), before.lastIndexOf("@")) + 1);
    if (selectors && (next === -1 || next > close)) {
      rules.push({ selectors, declarations: css.slice(open + 1, close) });
      from = close + 1;
    } else {
      from = open + 1;
    }
    open = next;
  }
  return rules;
}

/**
 * `pin`, and the attributes it hides, as the reader before this one read them from a message's
 * markup: every `<style>…</style>` in it, wherever it stands (a comment, a template, an attribute),
 * without its comments; every rule ({@link pinCssRules}); each selector's compounds split at `\s`,
 * `>`, `+` and `~`, one of more than one read only where the rule hides; and no `*` rule. Found by
 * `/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi`, read here in one pass. Whether a rule hides is its own
 * test ({@link pinHides}). A rule with a value longer than MAX_RULE_VALUE_CHARS is read as hiding,
 * as {@link stylesheetRules} reads one: it sets UNREAD, and none of its values.
 */
function pinStylesheetRules(html: string, rules: StyleRules): void {
  const open = /<style\b/gi;
  const close = /<\/style\s*>/gi;
  for (let start = open.exec(html); start !== null; start = open.exec(html)) {
    const content = html.indexOf(">", start.index) + 1;
    if (content === 0) break;
    close.lastIndex = content;
    const end = close.exec(html);
    if (end === null) break;
    open.lastIndex = close.lastIndex;
    for (const rule of pinCssRules(withoutComments(html.slice(content, end.index)))) {
      const declarations = pinDeclarations(rule.declarations);
      const long = [...declarations.values()].some(value => value.length > MAX_RULE_VALUE_CHARS);
      const hides = long || pinHides(declarations);
      for (const selector of rule.selectors.split(",")) {
        const compounds = selector.trim().split(/[\s>+~]+/);
        if (!hides && compounds.length > 1) continue;
        const { keys, attributes } = keysOf(withoutPseudoClasses(compounds.at(-1) ?? ""), true);
        if (hides) for (const name of attributes) rules.hiddenAttributes.add(name);
        for (const key of keys) {
          if (key === "*") continue;
          let pinned = rules.pin.get(key);
          if (!pinned) rules.pin.set(key, pinned = new Map());
          if (long) pinned.set(UNREAD, "");
          else for (const [property, value] of declarations) if (!isPage(key) || INHERITED_PROPERTIES.has(property) || property === "background") pinned.set(property, value);
        }
      }
    }
  }
}

/**
 * Each rule of a message's stylesheets, kept as {@link StyleRules} says. A rule's weight in the
 * cascade ({@link weigh}) counts its whole selector, more parts than a browser counts, never fewer.
 * Before, every rule was read loosely, so `p.x { display: block }` showed a `div.x` that `.x` hid,
 * and so did a rule in `@media print`. Of a sheet a browser may not apply ({@link Sheet}), only what
 * would hide is read: none of its rules is proven, and its colours and sizes take no other's place.
 * `pin` and what it hides are read from the message's markup as the reader before this one read them
 * ({@link pinStylesheetRules}).
 */
function stylesheetRules(sheets: readonly Sheet[], html: string, quirks: boolean): StyleRules {
  const rules: StyleRules = { proven: new Map(), loose: new Map(), pin: new Map(), hiddenAttributes: new Set(), quirks };
  const entries = <T>(map: Map<string, Map<string, T>>, key: string) => {
    let entry = map.get(key);
    if (!entry) map.set(key, entry = new Map());
    return entry;
  };
  pinStylesheetRules(html, rules);
  let order = 0;
  for (const { css, hidingOnly } of sheets) {
    for (const rule of cssRules(cssSkeleton(css))) {
      order++;
      const { valid, hiding } = parseDeclarations(rule.declarations, quirks);
      // A browser's declarations (`sure`), then those read only because they would hide; each with how surely it hides.
      const declared = [...valid, ...hiding].map(([property, { value, important }], at) =>
        ({ property, value, important, sure: at < valid.size, strength: TEXT_PROPERTIES.has(property) ? 1 : hidingStrength(property, value) }));
      if (declared.length === 0) continue;
      const long = declared.some(({ value }) => value.length > MAX_RULE_VALUE_CHARS);
      const styleFrom = (from: typeof declared) => new Map(from.map(({ property, value }) => [property, value]));
      const hides = long || hidesElement(styleFrom(declared.slice(0, valid.size))) || hidesElement(styleFrom(declared));
      const selectors = rule.selectors.split(",");
      // A rule's colours and sizes are read loosely only where a browser may apply it: one nested in
      // another rule applies only inside that rule's elements, and a browser drops one with a selector
      // it can't read. Read anyway, a hiding rule hides more.
      const readable = hides || (!rule.nested && selectors.every(selector => READABLE_SELECTOR.test(cssTrim(selector))));
      const plain = !long && !hidingOnly && !rule.nested && !rule.conditional && selectors.every(selector => PLAIN_SELECTOR.test(selector));
      for (const selector of selectors) {
        const compounds = compoundsOf(cssTrim(selector));
        // The last compound, without pseudo-classes: `div > p.x:first-child` → `p.x`.
        const last = withoutPseudoClasses(compounds.at(-1) ?? "");
        const weight = specificity(selector);
        let proven = false;
        if (plain && compounds.length === 1) {
          const read = provenRule(last, new Map([...valid].map(([property, { value, important }]) => [property, { value, weight: weigh(important, weight, order) }])));
          const held = read && (rules.proven.get(read.key) ?? []);
          if (read && held && held.length < MAX_PROVEN_RULES) {
            rules.proven.set(read.key, [...held, read.rule]);
            proven = true;
          }
        }
        const { keys, attributes } = keysOf(last);
        if (hides) for (const name of attributes) rules.hiddenAttributes.add(name);
        if (long) {
          for (const key of keys) keep(entries(rules.loose, key), "display", { value: "none", weight: Infinity, strength: 2 });
          continue;
        }
        for (const key of keys) {
          for (const { property, value, important, sure, strength } of declared) {
            if (isPage(key) && !INHERITED_PROPERTIES.has(property)) continue;
            if (TEXT_PROPERTIES.has(property)) {
              if (!readable || (!hides && compounds.length > 1)) continue;
              if (proven && sure) continue;
            }
            // An important one in an at-rule may be in a cascade layer, where it beats every important one outside it but a style attribute's.
            const ranked = important && rule.conditional ? INLINE_SPECIFICITY - 1 : weight;
            if (strength > 0) keep(entries(rules.loose, key), property, { value, weight: weigh(important, ranked, order), strength });
          }
        }
      }
    }
  }
  return rules;
}

// CSS Syntax's code point classes, by code unit: past ASCII, everything is a name code point.
const isCssNewline = (code: number) => code === 10 || code === 13 || code === 12;
const isCssWhitespace = (code: number) => code === 32 || code === 9 || isCssNewline(code);
const isCssHex = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
const isCssNameStart = (code: number) => (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95 || code >= 128;
const isCssName = (code: number) => isCssNameStart(code) || (code >= 48 && code <= 57) || code === 45;
const isCssNonPrintable = (code: number) => (code >= 1 && code <= 8) || code === 11 || (code >= 14 && code <= 31) || code === 127;

/** Whether `css[at]` is a backslash that escapes what follows: one before a newline doesn't. */
const isCssEscape = (css: string, at: number) => css.charCodeAt(at) === 92 && !isCssNewline(css.charCodeAt(at + 1));

/** Where the escape at `at` ends: up to six hex digits and one whitespace after them, or one code unit. */
function cssEscapeEnd(css: string, at: number): number {
  let end = at + 1;
  if (!isCssHex(css.charCodeAt(end))) return Math.min(end + 1, css.length);
  while (end < at + 7 && isCssHex(css.charCodeAt(end))) end++;
  if (css.startsWith("\r\n", end)) return end + 2;
  return isCssWhitespace(css.charCodeAt(end)) ? end + 1 : end;
}

/**
 * What the escape from `at` to `end` stands for in a name: its code point, or U+FFFD for one a name
 * can't hold unescaped (`\{`, `\;`, `\"`), so it can't be read as a brace, a semicolon or a quote.
 * U+FFFD is also what CSS makes of a null, a surrogate or a code point past U+10FFFF.
 */
function cssEscapeText(css: string, at: number, end: number): string {
  if (!isCssHex(css.charCodeAt(at + 1))) return isCssName(css.charCodeAt(at + 1)) ? css[at + 1]! : "\uFFFD";
  const code = Number.parseInt(css.slice(at + 1, Math.min(end, at + 7)), 16);
  return isCssName(code) && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\uFFFD";
}

/** Where the string opening at `at` ends: its closing quote, or before a newline it doesn't escape. */
function cssStringEnd(css: string, at: number): number {
  const quote = css.charCodeAt(at);
  for (let end = at + 1; end < css.length;) {
    const code = css.charCodeAt(end);
    if (code === quote) return end + 1;
    if (isCssNewline(code)) return end;
    if (code !== 92) end++;
    else if (isCssNewline(css.charCodeAt(end + 1))) end += css.startsWith("\r\n", end + 1) ? 3 : 2;
    else end = cssEscapeEnd(css, end);
  }
  return css.length;
}

/** Where the unquoted `url(` argument starting at `at` ends, a malformed one included: at its `)`, or the end of the sheet. */
function cssUrlEnd(css: string, at: number): number {
  let bad = false;
  for (let end = at; end < css.length;) {
    const code = css.charCodeAt(end);
    if (code === 41) return end;
    if (isCssEscape(css, end)) {
      end = cssEscapeEnd(css, end);
    } else if (bad) {
      end++;
    } else if (isCssWhitespace(code)) {
      while (isCssWhitespace(css.charCodeAt(end))) end++;
      bad = end < css.length && css.charCodeAt(end) !== 41;
    } else {
      bad = code === 34 || code === 39 || code === 40 || code === 92 || isCssNonPrintable(code);
      end++;
    }
  }
  return css.length;
}

/**
 * A stylesheet as the rule reader reads it, tokenized as CSS Syntax does, in one pass: comments
 * dropped, each string emptied to `""`, each unquoted `url(…)` argument emptied, and each escape
 * written as {@link cssEscapeText} gives it. So a brace, semicolon, colon, quote or `@` is left only
 * where the CSS has one: one inside a string, an argument or an escape can't open or close a rule or
 * a declaration, and a `/*` inside one doesn't open a comment. A comment left open runs to the end
 * of the sheet. The regex `/\/\*[\s\S]*?\*\//g` took a `/*` inside a string for a comment and left
 * an open one in place, so CSS a browser ignores could undo the rules before it, and it searched the
 * rest of the sheet again from every `/*`; strings and escapes were read as if they were structure.
 */
function cssSkeleton(css: string): string {
  let out = "";
  let from = 0;
  const replace = (start: number, end: number, text: string) => {
    out += css.slice(from, start) + text;
    from = end;
  };
  // Whether a `#` or `@` comes just before, making a name that follows a hash or an at-rule, not a `url(`.
  let sigil = false;
  for (let at = 0; at < css.length;) {
    const code = css.charCodeAt(at);
    if (code === 47 && css.charCodeAt(at + 1) === 42) {
      // A comment separates what is either side of it: `1/**/6px` is two values, not `16px`.
      const close = css.indexOf("*/", at + 2);
      replace(at, close === -1 ? css.length : close + 2, " ");
      at = from;
      sigil = false;
    } else if (code === 34 || code === 39) {
      replace(at, cssStringEnd(css, at), "\"\"");
      at = from;
      sigil = false;
    } else if (isCssName(code) || isCssEscape(css, at)) {
      // A name, read whole; if it spells `url` and a `(` follows, the unquoted argument is emptied.
      const next = css.charCodeAt(at + 1);
      const ident = !sigil && (isCssNameStart(code) || code === 92 || (code === 45 && (isCssNameStart(next) || next === 45 || isCssEscape(css, at + 1))));
      let name = "";
      while (at < css.length && (isCssName(css.charCodeAt(at)) || isCssEscape(css, at))) {
        let char = css[at]!;
        if (isCssEscape(css, at)) {
          const end = cssEscapeEnd(css, at);
          replace(at, end, char = cssEscapeText(css, at, end));
          at = end;
        } else {
          at++;
        }
        if (name.length < 4) name += char.charCodeAt(0) < 128 ? char.toLowerCase() : "\u0080";
      }
      sigil = false;
      if (ident && name === "url" && css.charCodeAt(at) === 40) {
        at++;
        while (isCssWhitespace(css.charCodeAt(at))) at++;
        if (css.charCodeAt(at) !== 34 && css.charCodeAt(at) !== 39) {
          replace(at, cssUrlEnd(css, at), "");
          at = from;
        }
      }
    } else if (code === 60 && css.startsWith("!--", at + 1)) {
      // `<!--` is one token, so its dashes don't start a name.
      at += 4;
      sigil = false;
    } else {
      sigil = (code === 35 || code === 64) && (isCssName(css.charCodeAt(at + 1)) || isCssEscape(css, at + 1));
      at++;
    }
  }
  return out + css.slice(from);
}

/**
 * A compound selector without its pseudo-classes and pseudo-elements: `p.x:first-child` → `p.x`.
 * `/::?[a-z-]+(\([^)]*\))?/gi` searched the rest of the compound for a `)` from every `:x(` that
 * has none. Past the compound's last `)` no argument can close, so that part is read without one.
 */
function withoutPseudoClasses(compound: string): string {
  const end = compound.lastIndexOf(")") + 1;
  return compound.slice(0, end).replace(/::?[a-z-]+(\([^)]*\))?/gi, "") + compound.slice(end).replace(/::?[a-z-]+/gi, "");
}

/**
 * A selector's compounds, split as `split(/[\t\n\f\r >+~]+/)` splits it, but not inside an attribute
 * test's brackets, which may hold whitespace (`[a=b i]`): split there, `i]` was the last compound,
 * and the test was read as none.
 */
function compoundsOf(selector: string): string[] {
  const masked = selector.replace(/\[[^\]]*\]?/g, test => test.replace(/[\t\n\f\r >+~]/g, "_"));
  const compounds: string[] = [];
  let from = 0;
  for (const { index, 0: run } of masked.matchAll(/[\t\n\f\r >+~]+/g)) {
    compounds.push(selector.slice(from, index));
    from = index + run.length;
  }
  compounds.push(selector.slice(from));
  return compounds;
}

/**
 * The attributes a compound selector tests (`[data-x]`, `td[data-y='1']`, `[ data-z = a i ]`), in
 * one pass: the pattern `/\[\s*([a-z0-9_:-]+)\s*(?:[~|^$*]?=\s*["']?[^"'\]]*["']?\s*)?\]/gi`
 * searched the rest of the compound again from every `[` it could not close. A test ends at the
 * first `]` after its `[`. Whatever its value and flag, it is read as testing that the attribute is
 * there, which hides at least as much.
 */
function selectedAttributes(compound: string): string[] {
  const names: string[] = [];
  let close = -1;
  for (let open = compound.indexOf("["); open !== -1; open = compound.indexOf("[", open + 1)) {
    if (open > close && (close = compound.indexOf("]", open)) === -1) break;
    let start = open + 1;
    while (start < close && isCssWhitespace(compound.charCodeAt(start))) start++;
    let end = start;
    while (end < close && /[a-z0-9_:-]/i.test(compound[end]!)) end++;
    let after = end;
    while (after < close && isCssWhitespace(compound.charCodeAt(after))) after++;
    if (end > start && (after === close || compound[after] === "=" || ("~|^$*".includes(compound[after]!) && compound[after + 1] === "="))) {
      names.push(compound.slice(start, end));
      open = close;
    }
  }
  return names;
}

/** A property's winning value in one reading of an element's style ({@link styleOf}). */
type Style = ReadonlyMap<string, string>;

/** An element's classes, ID and attribute values as a rule's tests are compared with them: as written, or folded to lower case in ASCII. */
type Values = { classes: ReadonlySet<string>; id: string; value: (name: string) => string };

/** Whether a proven rule's compound matches an element, by its tests as written or folded, against its values read the same way. */
function matches(rule: Proven, tests: Tests, element: Element, values: Values): boolean {
  return (rule.tag === undefined || rule.tag === element.tag)
    && tests.classes.every(name => values.classes.has(name))
    && tests.ids.every(id => id === values.id)
    && tests.attributes.every(([name, value]) => Object.hasOwn(element.attrs, name) && (value === undefined || value === values.value(name)));
}

/** The style of an element with no `style`, class or ID, whose type no rule names. */
const NO_STYLE: [Style, Style, Style] = [new Map(), new Map(), new Map()];

/**
 * An element's style, read three ways. `proven`: of the rules certainly applied to it and its own
 * `style` attribute (read as a stylesheet is, {@link cssSkeleton}), the declaration for each property
 * that wins in the cascade ({@link weigh}). `loose`: that, with what the rules that may apply set and
 * what its own style sets only because it would hide ({@link keep}), where it weighs at least as
 * much, so it can hide and never show what `proven` hides. `pin`: the last values of its type's,
 * classes' and ID's rules, then its own, as the reader before this one took them, by its attributes as
 * it read them ({@link Element}), its names folded to lower case as JavaScript folds them. What hides
 * in any reading is hidden ({@link elementOut}, {@link textOut}), `pin` as that reader judged it
 * ({@link pinHides}, {@link pinInherited}). Its values are each folded once, however many rules test them.
 */
function styleOf(element: Element, rules: StyleRules): [proven: Style, loose: Style, pin: Style] {
  const { attrs, tag } = element;
  // Most elements: nothing names them, so there is nothing to read.
  if (attrs.style === undefined && attrs.class === undefined && attrs.id === undefined && element.legacy === undefined
    && !rules.proven.has(tag) && !rules.loose.has(tag) && !rules.pin.has(tag) && !rules.proven.has("*") && !rules.loose.has("*")) return NO_STYLE;
  const classes = (attrs.class ?? "").split(/[\t\n\f\r ]+/).filter(name => name !== "");
  const exact: Values = { classes: new Set(classes), id: attrs.id ?? "", value: name => attrs[name]! };
  const foldedValues = new Map<string, string>();
  const folded: Values = {
    classes: new Set(classes.map(asciiLowerCase)),
    id: asciiLowerCase(attrs.id ?? ""),
    value: name => {
      let value = foldedValues.get(name);
      if (value === undefined) foldedValues.set(name, value = asciiLowerCase(attrs[name]!));
      return value;
    },
  };
  const keys = new Set([tag, "*", ...[...folded.classes].map(name => `.${name}`)]);
  if (attrs.id) keys.add(`#${folded.id}`);
  const winners = new Map<string, Weighted>();
  const apply = (declarations: Iterable<[string, Weighted]>) => {
    for (const [property, declared] of declarations) if (declared.weight > (winners.get(property)?.weight ?? -1)) winners.set(property, declared);
  };
  const candidates = new Map<string, Candidate>();
  for (const key of keys) {
    for (const rule of rules.proven.get(key) ?? []) {
      if (matches(rule, rule.tests, element, exact)) apply(rule.declarations);
      // One that matches only ignoring case does in quirks mode, which a doctype can leave a browser in.
      else if (matches(rule, rule.folded, element, folded)) for (const [property, held] of rule.candidates) keep(candidates, property, held);
    }
  }
  const { valid, hiding } = parseDeclarations(cssSkeleton(attrs.style ?? ""), rules.quirks);
  // In a style attribute, `revert-layer` rolls the cascade back to the stylesheets' declarations.
  const own = [...valid].filter(([, { value }]) => value !== "revert-layer");
  apply(own.map(([property, { value, important }]) => [property, { value, weight: weigh(important, INLINE_SPECIFICITY, 0) }]));
  for (const [property, { value, important }] of hiding) keep(candidates, property, candidate(property, value, weigh(important, INLINE_SPECIFICITY, 0)));
  const proven = new Map([...winners].map(([property, { value }]) => [property, value]));
  const loose = new Map(proven);
  for (const key of keys) for (const [property, held] of rules.loose.get(key) ?? []) keep(candidates, property, held);
  for (const [property, { value, weight }] of candidates) if (weight >= (winners.get(property)?.weight ?? -1)) loose.set(property, value);
  const pin = new Map<string, string>();
  const old = element.legacy ?? attrs;
  const pinKeys = [tag, ...(old.class ?? "").toLowerCase().split(/\s+/).map(name => `.${name}`), `#${old.id?.toLowerCase() ?? ""}`];
  for (const key of pinKeys) for (const [property, value] of rules.pin.get(key) ?? []) pin.set(property, value);
  for (const [property, value] of pinDeclarations(old.style ?? "")) pin.set(property, value);
  return [proven, loose, pin];
}

/** Text no larger than this, in pixels, can't be read: it counts as hidden. */
const MAX_HIDDEN_FONT_PX = 3;
/** Positioned this far off the page, an element is out of sight. */
const OFF_SCREEN_PX = -500;
/** A clipped box this small (a preheader's usual shape) shows nothing readable. */
const MAX_CLIPPED_PX = 2;
/** Letters drawn this far back over one another can't be read: an em at the default size. */
const COLLAPSED_SPACING_PX = -16;

/** Whether declarations hide an element and all it holds. */
function hidesElement(style: ReadonlyMap<string, string>, options: { sized?: boolean } = {}): boolean {
  if (style.size === 0) return false;
  if (style.get("display") === "none" || style.get("visibility") === "hidden" || style.get("visibility") === "collapse"
    || style.get("mso-hide") === "all" || style.get("content-visibility") === "hidden") return true;
  const opacity = style.get("opacity");
  if (opacity !== undefined && (opacity.endsWith("%") ? Number.parseFloat(opacity) / 100 : Number.parseFloat(opacity)) <= 0.05) return true;
  // A zero box hides what overflows it in mail clients, which clip regardless of `overflow`; a box
  // of a pixel or two does so when it clips. (An image's own size is read as a tracking pixel instead.)
  const clips = ["overflow", "overflow-x", "overflow-y"].some(property => (style.get(property) ?? "").split(/\s+/).some(word => word === "hidden" || word === "clip"));
  for (const property of options.sized === false ? [] : ["max-height", "height", "max-width", "width"]) {
    const size = cssLength(style.get(property) ?? "");
    if (size !== undefined && (size === 0 || (clips && size <= MAX_CLIPPED_PX))) return true;
  }
  const position = style.get("position");
  for (const side of position === "absolute" || position === "fixed" ? ["left", "top", "right", "bottom", "margin-left", "margin-top"] : ["margin-left", "margin-top"]) {
    const offset = cssLength(style.get(side) ?? "");
    if (offset !== undefined && offset <= OFF_SCREEN_PX) return true;
  }
  // With `hanging` or `each-line`, a text indent moves text as far where a browser reads it.
  const indent = cssLength((style.get("text-indent") ?? "").replace(/\b(?:hanging|each-line)\b/g, ""));
  if (indent !== undefined && indent <= OFF_SCREEN_PX) return true;
  // A percentage in letter spacing is of the type size, as an `em` is, where a browser reads one.
  const letterSpacing = style.get("letter-spacing") ?? "";
  const spacing = letterSpacing.endsWith("%") ? Number.parseFloat(letterSpacing) * 16 / 100 : cssLength(letterSpacing);
  if (spacing !== undefined && spacing <= COLLAPSED_SPACING_PX) return true;
  const clip = style.get("clip")?.replace(/\s+/g, "");
  if (clip !== undefined && /^rect\((0(px)?,?){3}0(px)?\)$/.test(clip)) return true;
  const clipPath = style.get("clip-path");
  if (clipPath !== undefined && /inset\(\s*50%|circle\(\s*0|polygon\(\s*0(px)?\s+0(px)?\s*\)/.test(clipPath)) return true;
  const transform = style.get("transform");
  if (transform !== undefined) {
    // Each call's arguments, where no bracket opens inside them: so each is read once, and a call
    // beside others (`scale(0) rotate(calc(1deg))`) is read as well as one alone.
    for (const [, name, args] of transform.matchAll(/(scale[xy]?|translate(?:3d|x|y)?)\(([^()]*)\)/g)) {
      const parts = args!.split(",");
      if (name!.startsWith("scale") ? parts.some(part => ZERO.test(part)) : parts.some(part => (cssLength(part) ?? 0) <= OFF_SCREEN_PX)) return true;
    }
  }
  // The `scale` property, and a filter's `opacity()`, hide as `transform: scale()` and `opacity` do.
  // Neither is ever read as showing ({@link validValue}): each only hides. Only a zero width or height
  // (`scale: 1 0`) flattens text; a zero depth (`scale: 1 1 0`) leaves it as it was.
  const scale = style.get("scale");
  if (scale !== undefined && scale.trim().split(/[\t\n\f\r ]+/).slice(0, 2).some(part => ZERO.test(part))) return true;
  const filter = style.get("filter");
  if (filter !== undefined) {
    for (const [, amount] of filter.matchAll(/opacity\(([^()]*)\)/g)) {
      const value = amount!.trim();
      if (value !== "" && (value.endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value)) <= 0.05) return true;
    }
  }
  return false;
}

/** Zero, as a number or a percentage (`scale(0%)`). */
const ZERO = new RegExp(String.raw`^\s*[+-]?(?:0+(?:\.0+)?|\.0+)(?:e[+-]?[0-9]+)?%?\s*$`);

/**
 * A CSS length in pixels, roughly (absolute units converted, and font-relative ones at the default
 * 16px); undefined when it isn't one. A number is read as CSS writes one: a sign, a leading `.`, an
 * exponent (`.5e-1px`).
 */
function cssLength(value: string): number | undefined {
  const match = DIMENSION.exec(value.trim());
  if (!match) return undefined;
  const number = Number(match[1]);
  switch (match[2]) {
    case undefined: case "px": return number;
    case "pt": return number * 4 / 3;
    case "pc": return number * 16;
    case "in": return number * 96;
    case "cm": return number * 96 / 2.54;
    case "mm": return number * 96 / 25.4;
    case "q": return number * 96 / 101.6;
    case "em": case "rem": case "ic": case "ric": return number * 16;
    case "ch": case "ex": case "rch": case "rex": case "cap": case "rcap": return number * 8;
    case "lh": case "rlh": return number * 19.2;
    // Relative to something unknown (a percentage, the viewport, a container): only zero is certain.
    default: return number === 0 ? 0 : undefined;
  }
}

/**
 * Whether declarations hide an element, as the reader before this one judged it, for its reading
 * (`pin`, {@link styleOf}) and the rules it read ({@link pinStylesheetRules}): its own test, with its
 * lengths ({@link pinLength}), and its first translation's arguments found in one pass, where
 * `/translate(?:3d|x|y)?\(([^)]*)\)/i` searched the rest again from every `translate(` with no `)`
 * after it. A rule's value too long to read (UNREAD) hides.
 */
function pinHides(style: Style, options: { sized?: boolean } = {}): boolean {
  if (style.has(UNREAD)) return true;
  if (style.get("display") === "none" || style.get("visibility") === "hidden" || style.get("visibility") === "collapse"
    || style.get("mso-hide") === "all" || style.get("content-visibility") === "hidden") return true;
  const opacity = style.get("opacity");
  if (opacity !== undefined && (opacity.endsWith("%") ? Number.parseFloat(opacity) / 100 : Number.parseFloat(opacity)) <= 0.05) return true;
  const clips = ["overflow", "overflow-x", "overflow-y"].some(property => /^(hidden|clip)$/.test(style.get(property) ?? ""));
  for (const property of options.sized === false ? [] : ["max-height", "height", "max-width", "width"]) {
    const size = pinLength(style.get(property) ?? "");
    if (size !== undefined && (size === 0 || (clips && size <= MAX_CLIPPED_PX))) return true;
  }
  const position = style.get("position");
  for (const side of position === "absolute" || position === "fixed" ? ["left", "top", "right", "bottom", "margin-left", "margin-top"] : ["margin-left", "margin-top"]) {
    const offset = pinLength(style.get(side) ?? "");
    if (offset !== undefined && offset <= OFF_SCREEN_PX) return true;
  }
  const indent = pinLength(style.get("text-indent") ?? "");
  if (indent !== undefined && indent <= OFF_SCREEN_PX) return true;
  const spacing = pinLength(style.get("letter-spacing") ?? "");
  if (spacing !== undefined && spacing <= COLLAPSED_SPACING_PX) return true;
  const clip = style.get("clip")?.replace(/\s+/g, "");
  if (clip !== undefined && /^rect\((0(px)?,?){3}0(px)?\)$/.test(clip)) return true;
  const clipPath = style.get("clip-path");
  if (clipPath !== undefined && /inset\(\s*50%|circle\(\s*0|polygon\(\s*0(px)?\s+0(px)?\s*\)/.test(clipPath)) return true;
  const transform = style.get("transform");
  if (transform !== undefined) {
    if (/scale[xy]?\(\s*0(\.0+)?\s*[,)]/.test(transform)) return true;
    const translate = /translate(?:3d|x|y)?\(/i.exec(transform);
    const from = translate ? translate.index + translate[0].length : 0;
    const to = translate ? transform.indexOf(")", from) : -1;
    if (to !== -1 && transform.slice(from, to).split(",").some(part => (pinLength(part) ?? 0) <= OFF_SCREEN_PX)) return true;
  }
  return false;
}

/** A length as the reader before this one read one: `!important` dropped again, and only its number forms and units. */
function pinLength(value: string): number | undefined {
  const length = value.replace(/!important/i, "").trim();
  return /^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:px|pt|em|rem|%|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pc)?$/.test(length) ? cssLength(length) : undefined;
}

/** `font-size`'s keywords in pixels, at a browser's default 16px. */
const FONT_SIZE_PIXELS: ReadonlyMap<string, number> = new Map([
  ["xx-small", 9], ["x-small", 10], ["small", 13], ["medium", 16], ["large", 18], ["x-large", 24], ["xx-large", 32], ["xxx-large", 48], ["initial", 16],
]);

/** What a size in pixels makes of the size its element inherits; undefined to inherit it. */
type FontSize = (inherited: number) => number | undefined;

/** A `font-size` in pixels, a relative one (`%`, `em`, `smaller`) from the size its element inherits. Read once for each attribute set ({@link Gives}). */
function fontPixels(value: string): FontSize {
  const keyword = FONT_SIZE_PIXELS.get(value);
  if (keyword !== undefined) return () => keyword;
  if (value === "smaller") return inherited => inherited / 1.2;
  if (value === "larger") return inherited => inherited * 1.2;
  const match = DIMENSION.exec(value);
  if (!match) return () => undefined;
  const number = Number(match[1]);
  switch (match[2]) {
    case "%": return inherited => inherited * number / 100;
    case "em": return inherited => inherited * number;
    case "ch": case "ex": return inherited => inherited * number / 2;
    default: {
      const pixels = cssLength(value);
      return () => pixels;
    }
  }
}

/** CSS's named colours, so text named as the colour of its background is seen for what it is. */
const NAMED_COLORS: ReadonlyMap<string, string> = new Map(("aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff " +
  "beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 " +
  "cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff " +
  "darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b " +
  "darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f " +
  "darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 " +
  "deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 " +
  "fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f " +
  "grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa " +
  "lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff " +
  "lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a " +
  "lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 " +
  "lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd " +
  "mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a " +
  "mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 " +
  "navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 " +
  "palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f " +
  "pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 " +
  "saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb " +
  "slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 " +
  "thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 " +
  "yellowgreen:9acd32").split(" ").map(entry => entry.split(":") as [string, string]));

type Rgba = [number, number, number, number];

/**
 * A CSS or HTML colour as RGB and alpha (`transparent` is alpha 0); undefined for anything else.
 * `legacy`, as the reader before this one read one: lower-cased as JavaScript lower-cases it, and a
 * function's arguments read as it read them ({@link pinFunctionColor}).
 */
function parseColor(value: string | undefined, legacy = false): Rgba | undefined {
  if (!value) return undefined;
  const bare = value.replace(/!important/i, "").trim();
  let text = legacy ? bare.toLowerCase() : asciiLowerCase(bare);
  if (text === "transparent") return [0, 0, 0, 0];
  text = NAMED_COLORS.get(text) ?? text;
  const hex = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    const short = hex[1]!.length <= 4;
    const digits = short ? [...hex[1]!].map(digit => digit + digit).join("") : hex[1]!;
    const [red, green, blue, alpha] = [0, 2, 4, 6].map(at => Number.parseInt(digits.slice(at, at + 2) || "ff", 16));
    return [red!, green!, blue!, alpha! / 255];
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(text);
  if (!fn) return undefined;
  if (legacy) return pinFunctionColor(fn[1]!, fn[2]!);
  // Three values and an alpha, all with commas between or none, with a `/` before the alpha.
  const args = fn[2]!.trim();
  const [main = "", alphaPart, ...extra] = args.includes(",") ? [args] : args.split(/\s*\/\s*/);
  const parts = args.includes(",") ? main.split(/\s*,\s*/) : main.split(/\s+/);
  if (extra.length > 0 || parts.length < 3 || parts.length > (alphaPart === undefined && args.includes(",") ? 4 : 3)) return undefined;
  const alpha = fraction(parts[3] ?? alphaPart ?? "1", 1);
  if (alpha === undefined) return undefined;
  if (fn[1]!.startsWith("rgb")) {
    // All numbers or all percentages, in range.
    const unit = PERCENTAGE.test(parts[0]!) ? PERCENTAGE : NUMBER;
    if (!parts.slice(0, 3).every(part => unit.test(part))) return undefined;
    const [red, green, blue] = parts.map(part => fraction(part, 255)!);
    return [red!, green!, blue!, alpha];
  }
  const hueMatch = HUE.exec(parts[0]!);
  const saturation = PERCENTAGE.test(parts[1]!) ? fraction(parts[1]!, 1) : undefined;
  const lightness = PERCENTAGE.test(parts[2]!) ? fraction(parts[2]!, 1) : undefined;
  if (!hueMatch || saturation === undefined || lightness === undefined) return undefined;
  const turn = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 }[hueMatch[2] ?? "deg"]!;
  return [...hslRgb(((Number(hueMatch[1]) * turn) % 360 + 360) % 360, saturation, lightness), alpha];
}

/** A hue in degrees, and a saturation and lightness as fractions, as RGB. */
function hslRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    return 255 * (lightness - chroma / 2 * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [channel(0), channel(8), channel(4)];
}

/**
 * A colour function's arguments as the reader before this one read them: split at commas, slashes
 * and whitespace, any number past three, each read as far as it is a number, the alpha clamped but
 * no channel, and a hue in degrees whatever its unit.
 */
function pinFunctionColor(name: string, args: string): Rgba | undefined {
  const parts = args.trim().split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3) return undefined;
  const alphaPart = parts[3];
  const alpha = alphaPart === undefined ? 1 : alphaPart.endsWith("%") ? Number.parseFloat(alphaPart) / 100 : Number.parseFloat(alphaPart);
  if (!Number.isFinite(alpha)) return undefined;
  const [first, second, third] = name.startsWith("rgb")
    ? parts.slice(0, 3).map(part => part.endsWith("%") ? Number.parseFloat(part) * 2.55 : Number.parseFloat(part))
    : [Number.parseFloat(parts[0]!), Number.parseFloat(parts[1]!) / 100, Number.parseFloat(parts[2]!) / 100];
  if (![first, second, third].every(Number.isFinite)) return undefined;
  return [...(name.startsWith("rgb") ? [first!, second!, third!] : hslRgb(first!, second!, third!)), Math.max(0, Math.min(1, alpha))] as Rgba;
}

const PERCENTAGE = new RegExp(`^${CSS_NUMBER}%$`);
const HUE = new RegExp(`^(${CSS_NUMBER})(deg|grad|rad|turn)?$`);

/** A number or percentage as a fraction of `whole`, clamped to it; undefined if it is neither. */
function fraction(value: string, whole: number): number | undefined {
  const percent = PERCENTAGE.test(value);
  if (!percent && !NUMBER.test(value)) return undefined;
  const number = percent ? Number(value.slice(0, -1)) / 100 * whole : Number(value);
  return Math.max(0, Math.min(whole, number));
}

/** The background colour a style (`background` read as the colour it sets, {@link parseDeclarations}) or a `bgcolor` gives an element, if any, before it is blended over what is behind it. */
function backgroundColor(element: Element, style: Style): Rgba | undefined {
  return parseColor(style.get("background-color")) ?? parseColor(style.get("background")) ?? parseColor(element.attrs.bgcolor);
}

/** A colour as it shows over an opaque one. */
function blend(color: Rgba, behind: Rgba): Rgba {
  const alpha = color[3];
  return [0, 1, 2].map(at => color[at]! * alpha + behind[at]! * (1 - alpha)).concat(1) as Rgba;
}

/**
 * What text inherits from the elements around it, by one of their styles ({@link styleOf}; `style`,
 * its place there), where tables are read in quirks mode or not (`quirks`, {@link quirkTable}).
 */
type Inherited = { color: Rgba; background: Rgba; fontSize: number; style: 0 | 1 | 2; quirks: boolean };
/** What text inherits by each reading of the styles around it: hidden by any, it is hidden. */
type Readings = readonly Inherited[];

/** Text this close in RGB distance to its background can't be read: it counts as hidden. */
const INVISIBLE_DISTANCE = 24;

function colorDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

/** Known open-tracking image hosts and paths. */
const TRACKER = /(?:\/wf\/open|\/track\/open|\/trk\/|\/open\.gif|\/pixel\.(?:gif|png)|\/beacon|list-manage\.com\/track|mandrillapp\.com\/track|sendgrid\.net\/wf|mailchimp\.com\/track|hubspotemail\.net|t\.hubspotemail|\/e2t\/o\/|google-analytics\.com\/collect|mailtrack|mixmax\.com\/api\/track|yesware|bananatag|\/o\.gif|cmail\d+\.com\/t\/|exct\.net\/open)/i;

/**
 * Mailgun-style open tracking: `/o/` after a path segment holding `email.mg.` or `links.` and more,
 * as `/(?:email\.mg\.|links\.)[^/]+\/o\//i` matches it. Read back from each `/o/`, since the pattern
 * searched for the next `/` again from every `links.`.
 */
function mailgunOpen(src: string): boolean {
  const open = /\/o\//gi;
  for (let match = open.exec(src); match; match = open.exec(src)) {
    if (/(?:email\.mg\.|links\.)[^/]/i.test(src.slice(src.lastIndexOf("/", match.index - 1) + 1, match.index))) return true;
    open.lastIndex = match.index + 1;
  }
  return false;
}

type Counters = {
  hiddenRegions: number;
  invisibleChars: number;
  trackingImages: number;
  dataImages: number;
  unsafeLinks: number;
  unwrapped: number;
  /** Places text was left out past MAX_REOPENED ({@link CUT}). */
  cut: number;
  /** Links written as their text alone past MAX_LINK_CHARS. */
  unlinked: number;
};

/**
 * The most characters of link addresses written for one message. A link reopened as a copy is
 * written again with each copy, and an address can grow as it is written (`漢` is `%E6%BC%A2`, and
 * `&` `&amp;`): 200 copies of a 20,000-character one wrote 20 to 36 million characters and held some
 * 400 MB in Node. Past this, a link is written as its text alone, and the reader told so.
 */
const MAX_LINK_CHARS = 1_000_000;

/** A message body as safe Markdown, with its links and what was taken out. */
export function mailToMarkdown(
  body: { contentType: "html" | "text"; content: string },
  options: { maxChars: number; inlineImages?: ReadonlyMap<string, string> },
): MailMarkdown {
  if (body.contentType === "html" && body.content.length > MAX_MAIL_HTML_CHARS) {
    return { markdown: truncate(TOO_LONG, options.maxChars).text, links: [], removed: [], truncated: true, hidesText: false };
  }
  const counters: Counters = { hiddenRegions: 0, invisibleChars: 0, trackingImages: 0, dataImages: 0, unsafeLinks: 0, unwrapped: 0, cut: 0, unlinked: 0 };
  const links = new LinkCollector();
  let markdown: string;
  if (body.contentType === "text") {
    markdown = textToMarkdown(body.content, counters, links);
  } else {
    const { root, base, styles } = buildTree(body.content);
    if (styles.unreadable) return { markdown: truncate(UNREADABLE, options.maxChars).text, links: [], removed: [], truncated: false, hidesText: true };
    // With no doctype a browser reads HTML in quirks mode. One anywhere is taken as a doctype, which
    // reads less as a length ({@link lengthValue}), so hides more, never less.
    const rules = stylesheetRules(styles.sheets, body.content, !/<!doctype/i.test(body.content));
    const baseUrl = base !== undefined ? httpUrl(base) : undefined;
    // Each style read with tables as a browser reads them in no-quirks mode, and, unless its doctype
    // certainly reads the message so or in limited-quirks mode ({@link documentMode}), in quirks mode
    // too ({@link quirkTable}).
    const mode = documentMode(body.content);
    const modes = mode === "no-quirks" || mode === "limited-quirks" ? [false] : [false, true];
    const page = modes.flatMap(quirks => ([0, 1, 2] as const).map((style): Inherited => ({
      color: [0, 0, 0, 1], background: [255, 255, 255, 1], fontSize: 16, style, quirks,
    })));
    const html = serialize(root, {
      rules, counters, links, baseUrl, inlineImages: options.inlineImages ?? new Map(), read: new WeakMap(), linkChars: 0,
      outside: new WeakMap(),
    }, page);
    markdown = htmlToMarkdown(html);
  }
  const { text, truncated } = truncate(markdown, options.maxChars);
  // What a limit left out is said to be: the message read here is incomplete, not hiding it.
  return {
    markdown: text, links: links.list(), removed: removedNotes(counters), truncated: truncated || counters.cut > 0 || counters.unlinked > 0,
    hidesText: counters.hiddenRegions > 0 || counters.invisibleChars > 0,
  };
}

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;

function removedNotes(counters: Counters): string[] {
  const notes: string[] = [];
  if (counters.hiddenRegions > 0) notes.push(counters.hiddenRegions === 1 ? "hidden text" : `hidden text (${counters.hiddenRegions} places)`);
  if (counters.invisibleChars > 0) notes.push(plural(counters.invisibleChars, "invisible character"));
  if (counters.trackingImages > 0) notes.push(plural(counters.trackingImages, "tracking image"));
  if (counters.dataImages > 0) notes.push(plural(counters.dataImages, "embedded image"));
  if (counters.unsafeLinks > 0) {
    notes.push(counters.unsafeLinks === 1 ? "1 link that wasn't a web or email link" : `${counters.unsafeLinks} links that weren't web or email links`);
  }
  if (counters.unwrapped > 0) notes.push(`unwrapped ${plural(counters.unwrapped, "Safe Link")}`);
  if (counters.unlinked > 0) {
    notes.push(counters.unlinked === 1 ? "the address of 1 link, past the most shown here" : `the addresses of ${counters.unlinked} links, past the most shown here`);
  }
  return notes;
}

type SerializeContext = {
  rules: StyleRules;
  counters: Counters;
  links: LinkCollector;
  baseUrl?: string;
  inlineImages: ReadonlyMap<string, string>;
  /** What each attribute set says of its elements ({@link readOf}). */
  read: WeakMap<Record<string, string>, Read>;
  /** The characters of link addresses written so far ({@link MAX_LINK_CHARS}). */
  linkChars: number;
  /** What the <body>'s contents inherit, which a table takes its colour from in quirks mode ({@link quirkTable}). */
  body?: Readings;
  /** What each table inherits from where it is, which what a browser moves out of it inherits too ({@link fostered}). */
  outside: WeakMap<Element, Readings>;
};

/**
 * An element's style, read three ways ({@link styleOf}); whether its tag, attributes or style hide
 * it; what it gives the text inside it by each reading ({@link Gives}); and, once a link is written
 * with them, where it goes ({@link linkOut}).
 */
type Read = {
  tag: string; legacy: Record<string, string> | undefined; styles: [Style, Style, Style]; hides: boolean; gives: [Gives, Gives, Gives]; target?: LinkTarget;
};

/**
 * What an element's tag and attributes say of it, read once for each attribute set: a reopened copy
 * has its original's tag and attributes, so it is read as the original was, not again. Read again,
 * a long `style` or class list on a formatting element left open took seconds over its copies, and
 * a long font colour 3.4 seconds.
 */
function readOf(element: Element, context: SerializeContext): Read {
  const { tag, attrs, legacy } = element;
  const known = context.read.get(attrs);
  if (known?.tag === tag && known.legacy === legacy) return known;
  const styles = styleOf(element, context.rules);
  const sized = tag !== "img";
  // A browser's own stylesheet hides a popover until a script opens it, as no mail's does; and
  // <rp>, <datalist> and a <dialog> that isn't open. All are hidden here whatever else styles them.
  const named = (names: Record<string, string>) => "hidden" in names || "popover" in names || Object.keys(names).some(name => context.rules.hiddenAttributes.has(name));
  const hides = hidesElement(styles[0], { sized }) || hidesElement(styles[1], { sized }) || pinHides(styles[2], { sized })
    || named(attrs) || (legacy !== undefined && named(legacy))
    || tag === "rp" || tag === "datalist" || (tag === "dialog" && closed(element));
  const gives: [Gives, Gives, Gives] = [givesFrom(element, styles[0]), givesFrom(element, styles[1]), pinGives(element, styles[2])];
  const read: Read = { tag, legacy, styles, hides, gives };
  context.read.set(attrs, read);
  return read;
}

/**
 * Writes the cleaned tree back as the plain HTML `htmlToMarkdown` reads. Iterative, so depth costs no
 * stack. What a Word list marker or a link holds is read as text from what was written of it, so
 * nothing hidden in it is read: the outermost marker's is written in its place, and a link is named by it.
 */
function serialize(root: Element, context: SerializeContext, inherited: Readings): string {
  const out: string[] = [];
  type Frame = { node: Node; inherited: Readings } | { close: string; from: number; marker: boolean; link?: (text: string) => void };
  // From the root, around the <html> and <body> built however the message is written ({@link buildTree}): a `*` rule applies to it too.
  const stack: Frame[] = [{ node: root, inherited }];
  let inMarker = false;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if ("close" in frame) {
      if (frame.marker || frame.link) {
        const text = out.slice(frame.from).join("").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
        frame.link?.(decodeEntities(text));
        if (frame.marker) {
          out.length = frame.from;
          out.push(WORD_BULLETS.test(text) ? "• " : `${text} `);
          inMarker = false;
        }
      }
      out.push(frame.close);
      continue;
    }
    const { node } = frame;
    if (!isElement(node)) {
      out.push(textOut(node.text, frame.inherited, context.counters));
      continue;
    }
    const written = elementOut(node, frame.inherited, context);
    if (written === null) continue;
    out.push(written.open);
    const marker = written.marker === true && !inMarker;
    if (marker) inMarker = true;
    stack.push({ close: written.close, from: out.length, marker, link: written.link });
    if (written.leaf) continue;
    const children = written.children ?? node.children;
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index]!;
      stack.push({ node: child, inherited: written.fostered && fostered(child) ? written.fostered : written.inherited });
    }
  }
  return out.join("");
}

/** A text node as escaped HTML, or nothing when it is zero-size or background-coloured by any reading. */
function textOut(raw: string, inherited: Readings, counters: Counters): string {
  const decoded = decodeEntities(raw);
  let invisible = 0;
  const visible = decoded.replace(INVISIBLE, char => {
    if (!PRESENTATION_SELECTORS.test(char)) invisible++;
    return "";
  });
  if (visible.trim() === "") {
    counters.invisibleChars += invisible;
    return escapeHtml(visible);
  }
  if (inherited.some(({ color, background, fontSize }) => fontSize <= MAX_HIDDEN_FONT_PX || colorDistance(blend(color, background), background) < INVISIBLE_DISTANCE)) {
    counters.hiddenRegions++;
    return " ";
  }
  counters.invisibleChars += invisible;
  return escapeHtml(visible);
}

/** Whether an element (with what it holds), or a list of nodes, has any text a person could read, ignoring whitespace. */
function hasText(element: { readonly children: readonly Node[] }): boolean {
  const stack: Node[] = [...element.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!isElement(node)) {
      if (decodeEntities(node.text).replace(INVISIBLE, "").trim() !== "") return true;
    } else if (!DROPPED.has(node.tag)) {
      // One at a time: spreading more than about 120,000 children into a call overflows the stack.
      for (const child of node.children) stack.push(child);
    }
  }
  return false;
}

/** Bullets Word writes as text before a list paragraph's content, which read better as a bullet. */
const WORD_BULLETS = /^[·•o§▪■–-]$/;

/**
 * How an element is written: its replacement tags, what its contents inherit (those a browser moves
 * out of a table, `fostered`), whether they are written at all, which of them are when not all are,
 * whether they are a Word list marker, and what names a link by them ({@link serialize}).
 */
type Written = {
  open: string; close: string; inherited: Readings; fostered?: Readings; leaf?: true; children?: readonly Node[]; marker?: true;
  link?: (text: string) => void;
};

/**
 * Whether a browser moves a node written straight in a table, row group or row out of it, to just
 * before the table ("foster parenting"): text that isn't white space, and any element but a table's
 * parts. It is kept where it is written here, read with what the table inherits as well as what it
 * holds inherits: hidden by either, it is hidden. Read as the table's alone, white text written so
 * on a black table showed, where a browser shows it on the white page around it.
 */
const fostered = (node: Node): boolean => (isElement(node) ? !TABLE_PARTS.has(node.tag) : /[^\t\n\f\r ]/.test(node.text));

/** `readings`, with those of `more` that aren't among them. */
const withReadings = (readings: Readings, more: Readings): Readings => [
  ...readings,
  ...more.filter(reading => !readings.some(other => other.style === reading.style && other.quirks === reading.quirks
    && other.fontSize === reading.fontSize && other.color.every((value, at) => value === reading.color[at])
    && other.background.every((value, at) => value === reading.background[at]))),
];

/** Whether an element a browser shows only with `open` (a <dialog>, a <details>) lacks it, by either reading of its attributes. */
const closed = (element: Element) => !("open" in element.attrs) || (element.legacy !== undefined && !("open" in element.legacy));

/** What an <rp> holds for a reader without ruby: a bracket, or nothing. Hidden, it isn't counted as hidden text. */
const RUBY_BRACKET = /^[\t\n\f\r ]*[()[\]（）［］【】「」〔〕]?[\t\n\f\r ]*$/u;
const rubyBracket = (element: Element) => element.tag === "rp"
  && RUBY_BRACKET.test(element.children.map(child => (isElement(child) ? "\u0000" : child.text)).join(""));

/**
 * What an element gives the text inside it by one reading of its style: a colour, a background to
 * blend over what is behind it, and a size from the one it inherits. Read once for each attribute
 * set ({@link readOf}), so a copy costs the same however long its colour or size is.
 */
type Gives = { color?: Rgba; background?: Rgba; fontSize?: FontSize };

/** What an element gives its contents, by one reading of its style. */
function givesFrom(element: Element, style: Style): Gives {
  // `initial` is a browser's default text colour, black; the other CSS-wide keywords keep the inherited one.
  const color = style.get("color") === "initial" ? [0, 0, 0, 1] as Rgba : parseColor(style.get("color")) ?? (element.tag === "font" ? parseColor(element.attrs.color) : undefined);
  const background = backgroundColor(element, style);
  const fontSize = style.get("font-size");
  const size = fontSize !== undefined ? fontPixels(fontSize) : element.tag === "font" && element.attrs.size === "0" ? () => 0 : undefined;
  return { ...(color ? { color } : {}), ...(background ? { background } : {}), ...(size ? { fontSize: size } : {}) };
}

/**
 * What an element gives its contents by the reader before this one's reading of its style (`pin`,
 * {@link styleOf}), as it read them: by its attributes as it read them, `color: initial` inherited,
 * colours as it read them ({@link parseColor}), and a size a percentage or a {@link pinLength}.
 */
function pinGives(element: Element, style: Style): Gives {
  const attrs = element.legacy ?? element.attrs;
  const color = parseColor(style.get("color"), true) ?? (element.tag === "font" ? parseColor(attrs.color, true) : undefined);
  const background = parseColor(style.get("background-color"), true) ?? parseColor(style.get("background"), true) ?? parseColor(attrs.bgcolor, true);
  const fontSize = style.get("font-size");
  let size: FontSize | undefined;
  if (fontSize !== undefined) {
    const percent = /^([0-9.]+)%$/.exec(fontSize.trim());
    const number = percent ? Number(percent[1]) : undefined;
    const pixels = percent ? undefined : pinLength(fontSize);
    size = number !== undefined ? inherited => inherited * number / 100 : () => pixels;
  } else if (element.tag === "font" && attrs.size === "0") {
    size = () => 0;
  }
  return { ...(color ? { color } : {}), ...(background ? { background } : {}), ...(size ? { fontSize: size } : {}) };
}

/** What an element's contents inherit, by one reading, from what it gives them and what it inherits. */
function inherit(gives: Gives, inherited: Inherited): Inherited {
  const next: Inherited = { ...inherited };
  if (gives.color) next.color = gives.color;
  if (gives.background) next.background = blend(gives.background, inherited.background);
  if (gives.fontSize) {
    const pixels = gives.fontSize(inherited.fontSize);
    if (pixels !== undefined) next.fontSize = pixels;
  }
  return next;
}

type DocumentMode = "no-quirks" | "limited-quirks" | "quirks";

/** The white space a browser's tokenizer skips before a doctype and inside one. */
const isHtmlSpace = (char: string | undefined) => char === " " || char === "\n" || char === "\t" || char === "\r" || char === "\f";

/**
 * The mode a browser reads a message in, as the HTML spec's "initial" insertion mode sets it from a
 * doctype, or undefined where none comes first, which leaves a browser in quirks mode. Before one may
 * come only white space, comments (a conditional comment is one), and what a browser's tokenizer reads
 * as a comment (`<?xml …?>`, `<!…>`, `</…>` but an end tag) or as nothing (`</>`); a comment left open
 * runs past any doctype to the end. A byte order mark is text here: a browser decoding the message's
 * bytes drops it, but one handed the message as text (`document.write`) reads it, so in quirks mode.
 * Before, only white space was skipped, so `<!--x--><!doctype html>` was read in quirks mode too,
 * which hid text Edge shows.
 */
function documentMode(html: string): DocumentMode | undefined {
  for (let at = 0; ;) {
    while (isHtmlSpace(html[at])) at++;
    if (html[at] !== "<") return undefined;
    const next = html[at + 1];
    if (next === "!" && html.startsWith("--", at + 2)) {
      at = commentEnd(html, at);
    } else if (next === "!" && asciiLowerCase(html.slice(at + 2, at + 9)) === "doctype") {
      return doctypeMode(html, at + 9);
    } else if (next === "!" || next === "?" || (next === "/" && html[at + 2] !== undefined && !/[a-z]/i.test(html[at + 2]!))) {
      const gt = html.indexOf(">", at + 2);
      at = gt === -1 ? html.length : gt + 1;
    } else {
      // A tag, or a `<` read as text.
      return undefined;
    }
  }
}

/**
 * The mode a doctype sets, read from just past its `<!doctype` as a browser's tokenizer reads it:
 * quirks where the tokenizer forces it (no name, a keyword but `PUBLIC` or `SYSTEM`, an identifier
 * missing its quotes or cut short by a `>`, or the message ending inside the doctype), else by its
 * name and identifiers ({@link modeOf}).
 */
function doctypeMode(html: string, at: number): DocumentMode {
  const space = () => {
    while (isHtmlSpace(html[at])) at++;
  };
  // A quoted identifier and the space after it; undefined where there is none or a `>` comes first.
  const identifier = () => {
    const quote = html[at];
    const close = quote === "\"" || quote === "'" ? html.indexOf(quote, at + 1) : -1;
    if (close === -1) return undefined;
    const id = html.slice(at + 1, close);
    at = close + 1;
    space();
    return id.includes(">") ? undefined : id;
  };
  space();
  const start = at;
  while (html[at] !== undefined && html[at] !== ">" && !isHtmlSpace(html[at])) at++;
  const name = asciiLowerCase(html.slice(start, at));
  space();
  if (name === "" || html[at] === undefined) return "quirks";
  if (html[at] === ">") return modeOf(name);
  const keyword = asciiLowerCase(html.slice(at, at + 6));
  if (keyword !== "public" && keyword !== "system") return "quirks";
  at += 6;
  space();
  const publicId = keyword === "public" ? identifier() : undefined;
  if (keyword === "public" && publicId === undefined) return "quirks";
  if (keyword === "public" && html[at] === ">") return modeOf(name, publicId);
  const systemId = identifier();
  // What follows a system identifier, up to `>`, is ignored.
  return systemId === undefined || !html.includes(">", at) ? "quirks" : modeOf(name, publicId, systemId);
}

/** The public identifiers, and their beginnings, for which the HTML spec reads a document in quirks mode. */
const QUIRKS_PUBLIC_IDS = new Set(["-//w3o//dtd w3 html strict 3.0//en//", "-/w3c/dtd html 4.0 transitional/en", "html"]);
const QUIRKS_PUBLIC_PREFIXES = [
  "+//silmaril//dtd html pro v0r11 19970101//", "-//as//dtd html 3.0 aswedit + extensions//",
  "-//advasoft ltd//dtd html 3.0 aswedit + extensions//", "-//ietf//dtd html 2.0 level 1//", "-//ietf//dtd html 2.0 level 2//",
  "-//ietf//dtd html 2.0 strict level 1//", "-//ietf//dtd html 2.0 strict level 2//", "-//ietf//dtd html 2.0 strict//",
  "-//ietf//dtd html 2.0//", "-//ietf//dtd html 2.1e//", "-//ietf//dtd html 3.0//", "-//ietf//dtd html 3.2 final//",
  "-//ietf//dtd html 3.2//", "-//ietf//dtd html 3//", "-//ietf//dtd html level 0//", "-//ietf//dtd html level 1//",
  "-//ietf//dtd html level 2//", "-//ietf//dtd html level 3//", "-//ietf//dtd html strict level 0//",
  "-//ietf//dtd html strict level 1//", "-//ietf//dtd html strict level 2//", "-//ietf//dtd html strict level 3//",
  "-//ietf//dtd html strict//", "-//ietf//dtd html//", "-//metrius//dtd metrius presentational//",
  "-//microsoft//dtd internet explorer 2.0 html strict//", "-//microsoft//dtd internet explorer 2.0 html//",
  "-//microsoft//dtd internet explorer 2.0 tables//", "-//microsoft//dtd internet explorer 3.0 html strict//",
  "-//microsoft//dtd internet explorer 3.0 html//", "-//microsoft//dtd internet explorer 3.0 tables//",
  "-//netscape comm. corp.//dtd html//", "-//netscape comm. corp.//dtd strict html//", "-//o'reilly and associates//dtd html 2.0//",
  "-//o'reilly and associates//dtd html extended 1.0//", "-//o'reilly and associates//dtd html extended relaxed 1.0//",
  "-//sq//dtd html 2.0 hotmetal + extensions//", "-//softquad software//dtd hotmetal pro 6.0::19990601::extensions to html 4.0//",
  "-//softquad//dtd hotmetal pro 4.0::19971010::extensions to html 4.0//", "-//spyglass//dtd html 2.0 extended//",
  "-//sun microsystems corp.//dtd hotjava html//", "-//sun microsystems corp.//dtd hotjava strict html//",
  "-//w3c//dtd html 3 1995-03-24//", "-//w3c//dtd html 3.2 draft//", "-//w3c//dtd html 3.2 final//", "-//w3c//dtd html 3.2//",
  "-//w3c//dtd html 3.2s draft//", "-//w3c//dtd html 4.0 frameset//", "-//w3c//dtd html 4.0 transitional//",
  "-//w3c//dtd html experimental 19960712//", "-//w3c//dtd html experimental 970421//", "-//w3c//dtd w3 html//",
  "-//w3o//dtd w3 html 3.0//", "-//webtechs//dtd mozilla html 2.0//", "-//webtechs//dtd mozilla html//",
];
const HTML_401_PREFIXES = ["-//w3c//dtd html 4.01 frameset//", "-//w3c//dtd html 4.01 transitional//"];
const XHTML_10_PREFIXES = ["-//w3c//dtd xhtml 1.0 frameset//", "-//w3c//dtd xhtml 1.0 transitional//"];

/**
 * The mode a doctype's name and identifiers set, by the HTML spec's "initial" insertion mode: quirks for
 * a name but `html`, IBM's XHTML system identifier, a public identifier QUIRKS_PUBLIC_IDS holds or
 * QUIRKS_PUBLIC_PREFIXES begins, or HTML 4.01 Transitional's or Frameset's without a system identifier;
 * limited quirks for those with one and for XHTML 1.0 Transitional's or Frameset's; else no quirks.
 * Chromium takes an empty system identifier for none, where the spec doesn't, so it is here.
 */
function modeOf(name: string, publicId?: string, systemId?: string): DocumentMode {
  const publicLower = publicId === undefined ? undefined : asciiLowerCase(publicId);
  const systemLower = systemId === undefined ? "" : asciiLowerCase(systemId);
  if (name !== "html" || systemLower === "http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd") return "quirks";
  if (publicLower === undefined) return "no-quirks";
  if (QUIRKS_PUBLIC_IDS.has(publicLower) || QUIRKS_PUBLIC_PREFIXES.some(prefix => publicLower.startsWith(prefix))) return "quirks";
  if (HTML_401_PREFIXES.some(prefix => publicLower.startsWith(prefix))) return systemLower === "" ? "quirks" : "limited-quirks";
  return XHTML_10_PREFIXES.some(prefix => publicLower.startsWith(prefix)) ? "limited-quirks" : "no-quirks";
}

/** Colour values that keep a table's parent's colour in quirks mode, as CSS's `inherit` does. */
const INHERITS_COLOR = new Set(["inherit", "unset", "currentcolor"]);

/**
 * The colour a browser's own stylesheet gives a link (Chromium's `a:-webkit-any-link { color:
 * -webkit-link }`), unvisited. It is given in the quirks reading to an `<a href>` that sets no colour, or
 * reverts to the browser's, so a link in a table there isn't read in the <body>'s colour
 * ({@link quirkTable}), which hid a link Edge draws blue in a black section. One that sets a colour this
 * reader doesn't read (`var()`, `initial`) keeps what it inherits there, as such a value only hides. The
 * no-quirks reading keeps the colour a link inherits, as before.
 */
const LINK_COLOR: Rgba = [0, 0, 238, 1];

/** Colour values that leave a link the colour a browser's own stylesheet gives it: none, or `revert`. */
const LINK_KEEPS_UA = new Set([undefined, "revert", "revert-layer"]);

/**
 * What a table's contents inherit in quirks mode, by one reading: a browser's own stylesheet there
 * gives a <table> the <body>'s colour, not its parent's, and a medium size (Chromium's `color:
 * -internal-quirk-inherit; font-size: medium`), unless the table's own style sets them; `inherit`,
 * `unset` and `currentcolor` keep its parent's, and `revert` the <body>'s. So white text set on the
 * page shows white in a table inside `<font color=black>`. Read as no-quirks alone, that showed what
 * Edge hides.
 */
function quirkTable(inside: Inherited, inherited: Inherited, style: Style, gives: Gives, body: Inherited | undefined): Inherited {
  const color = gives.color || INHERITS_COLOR.has(style.get("color") ?? "") ? inside.color : body?.color ?? inside.color;
  const sized = gives.fontSize?.(inherited.fontSize) !== undefined || style.get("font-size") === "inherit" || style.get("font-size") === "unset";
  return { ...inside, color, fontSize: sized ? inside.fontSize : 16 };
}

/**
 * How an element is written, or null when it is dropped or hidden: hidden by any reading of its style
 * ({@link styleOf}), as the reader before this one read it or as a browser may.
 */
function elementOut(element: Element, inherited: Readings, context: SerializeContext): Written | null {
  const { tag } = element;
  if (DROPPED.has(tag)) return null;
  // What is left out past MAX_REOPENED: not hidden, so not counted as hidden, but said to be left out,
  // where the first of it was, as a limit of this reader's, if it holds text or an element (an image).
  if (element.attrs === CUT) {
    if ((!hasText(element) && !element.children.some(isElement)) || context.counters.cut++ > 0) return null;
    return { open: `<p>${escapeHtml(TOO_COMPLEX)}</p>`, close: "", inherited, leaf: true };
  }
  const read = readOf(element, context);
  const { styles, hides } = read;
  if (hides) {
    if (hasText(element) && !rubyBracket(element)) context.counters.hiddenRegions++;
    return null;
  }
  const next = inherited.map(reading => {
    const gives = read.gives[reading.style]!;
    const inside = inherit(gives, reading);
    if (reading.quirks && tag === "a" && "href" in element.attrs && !gives.color && LINK_KEEPS_UA.has(styles[reading.style].get("color"))) {
      inside.color = LINK_COLOR;
    }
    return tag === "table" && reading.quirks ? quirkTable(inside, reading, styles[reading.style], gives, context.body?.[reading.style]) : inside;
  });
  if (tag === "body") context.body = next;
  if (tag === "table") context.outside.set(element, inherited);
  // A <details> that isn't open shows only its first <summary>: a browser hides the rest, whatever styles it.
  if (tag === "details" && closed(element)) {
    const summary = element.children.find((child): child is Element => isElement(child) && child.tag === "summary");
    const rest = element.children.filter(child => child !== summary);
    if (hasText({ children: rest })) context.counters.hiddenRegions++;
    return { open: "", close: "", inherited: next, children: summary ? [summary] : [] };
  }
  // Word's list bullets, written as text in a span Outlook marks `mso-list:Ignore`, where it certainly applies.
  if (styles[0].get("mso-list") === "ignore") return { open: "", close: "", inherited: next, marker: true };
  switch (tag) {
    case "img": return { open: imageOut(element, styles, context), close: "", inherited: next, leaf: true };
    case "a": return linkOut(element, read, next, context);
    case "table": {
      const fosters = withReadings(next, inherited);
      if (tableKind(element).data) return { open: "<table>", close: "</table>", inherited: next, fostered: fosters };
      return { open: "<div>", close: "</div>", inherited: next, fostered: fosters };
    }
    case "tr": case "td": case "th": case "thead": case "tbody": case "tfoot": {
      const table = enclosingTable(element);
      const kind = table ? tableKind(table) : undefined;
      // A row or row group's contents but its cells are moved out of the table, as the table's are.
      const rest = tag === "td" || tag === "th" ? {} : { fostered: withReadings(next, (table && context.outside.get(table)) ?? []) };
      if (kind?.data) {
        if (["thead", "tbody", "tfoot"].includes(tag)) return { open: "", close: "", inherited: next, ...rest };
        // A data table with no header cells reads its first row as the header.
        const cell = tag === "td" && element.parent === kind.headerRow ? "th" : tag;
        return { open: `<${cell}>`, close: `</${cell}>`, inherited: next, ...rest };
      }
      return { open: "<div>", close: "</div>", inherited: next, ...rest };
    }
    case "br": case "hr": return { open: `<${tag}>`, close: "", inherited: next };
    case "p": case "div": case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": case "blockquote": case "pre":
    case "ul": case "ol": case "li": case "strong": case "b": case "em": case "i": case "s": case "strike": case "del": case "code":
    case "section": case "article": case "header": case "footer": case "figure":
      return { open: `<${tag}>`, close: `</${tag}>`, inherited: next };
    case "center": case "address": case "main": case "aside": case "nav": case "dl": case "dt": case "dd": case "caption":
      return { open: "<div>", close: "</div>", inherited: next };
    default:
      return { open: "", close: "", inherited: next };
  }
}

function enclosingTable(element: Element): Element | null {
  for (let node = element.parent; node; node = node.parent) if (node.tag === "table") return node;
  return null;
}

/** Whether a table holds data, and the row to read as its header when it has no header cells. */
type TableKind = { data: false } | { data: true; headerRow?: Element };

const tableKinds = new WeakMap<Element, TableKind>();

function tableKind(table: Element): TableKind {
  let kind = tableKinds.get(table);
  if (kind === undefined) {
    kind = classifyTable(table);
    tableKinds.set(table, kind);
  }
  return kind;
}

/**
 * Whether a table holds data (shown as a table) or lays out a page (flattened to text). A data
 * table has header cells, or two or more rows of the same two or more short cells, and no table
 * inside it or role="presentation".
 */
function classifyTable(table: Element): TableKind {
  if (table.attrs.role === "presentation" || table.attrs.role === "none") return { data: false };
  const rows: { row: Element; cells: Element[] }[] = [];
  let nested = false;
  const walk = (element: Element) => {
    for (const child of element.children) {
      if (!isElement(child)) continue;
      if (child.tag === "table") nested = true;
      else if (child.tag === "tr") rows.push({ row: child, cells: child.children.filter((cell): cell is Element => isElement(cell) && (cell.tag === "td" || cell.tag === "th")) });
      else if (["thead", "tbody", "tfoot"].includes(child.tag)) walk(child);
    }
  };
  walk(table);
  if (nested || rows.length === 0 || rows.some(({ cells }) => cells.some(cell => containsTag(cell, "table")))) return { data: false };
  if (rows.some(({ cells }) => cells.some(cell => cell.tag === "th"))) return { data: true };
  const width = rows[0]!.cells.length;
  if (rows.length < 2 || width < 2 || rows.some(({ cells }) => cells.length !== width)) return { data: false };
  const texts = rows.flatMap(({ cells }) => cells.map(cell => plainTextOf(cell).trim()));
  if (texts.some(text => text.length > 200)) return { data: false };
  const filled = texts.filter(text => text !== "");
  const short = filled.length >= texts.length / 2 && filled.reduce((sum, text) => sum + text.length, 0) / Math.max(1, filled.length) <= 60;
  return short ? { data: true, headerRow: rows[0]!.row } : { data: false };
}

function containsTag(element: Element, tag: string): boolean {
  const stack: Node[] = [...element.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isElement(node)) {
      if (node.tag === tag) return true;
      // One at a time: spreading more than about 120,000 children into a call overflows the stack.
      for (const child of node.children) stack.push(child);
    }
  }
  return false;
}

function plainTextOf(element: Element): string {
  const parts: string[] = [];
  const stack: Node[] = [element];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isElement(node)) {
      if (!DROPPED.has(node.tag)) for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]!);
    } else {
      parts.push(decodeEntities(node.text));
    }
  }
  return parts.join("");
}

/** The most of an image's alt text shown: the sender's to write, at any length. */
const MAX_ALT_CHARS = 200;

/** An image as the placeholder text `htmlToMarkdown` writes, or nothing for a data image or one tracking, at a pixel or two by any reading of its style. */
function imageOut(element: Element, styles: readonly Style[], context: SerializeContext): string {
  const src = (element.attrs.src ?? "").trim();
  const tiny = styles.some(style => ["width", "height"].some(side => (cssLength(element.attrs[side] ?? style.get(side) ?? "") ?? Infinity) <= 2));
  if (/^data:/i.test(src)) {
    context.counters.dataImages++;
    return "";
  }
  if (tiny || (/^https?:/i.test(src) && (TRACKER.test(src) || mailgunOpen(src)))) {
    context.counters.trackingImages++;
    return "";
  }
  if (/^cid:/i.test(src)) {
    const name = context.inlineImages.get(src.slice(4).replace(/^<|>$/g, "")) ?? element.attrs.alt?.trim().slice(0, MAX_ALT_CHARS);
    return `<img alt="${escapeHtml(name || "inline image")}">`;
  }
  const alt = element.attrs.alt?.replace(INVISIBLE, "").trim().slice(0, MAX_ALT_CHARS);
  return alt ? `<img alt="${escapeHtml(alt)}">` : "<img>";
}

/** Where a link goes: nowhere (no href, or one on the page), somewhere not a web or email link, or a target, as it is written. */
type LinkTarget = "none" | "unsafe" | { url: string; unwrapped: boolean; written: string };

function linkTarget(href: string | undefined, baseUrl: string | undefined): LinkTarget {
  const raw = href?.trim();
  if (raw === undefined || raw === "" || raw.startsWith("#")) return "none";
  const resolved = resolveHref(raw, baseUrl);
  if (resolved === undefined) return "unsafe";
  const { url, unwrapped } = unwrapLink(resolved);
  return { url, unwrapped, written: escapeHtml(url) };
}

/**
 * A link with its real target, or just its text when the target isn't a web or email link, or when
 * the message's links have written MAX_LINK_CHARS. Its target is read once for each attribute set,
 * so a copy of it costs only what it writes.
 */
function linkOut(element: Element, read: Read, inherited: Readings, context: SerializeContext): Written {
  const target = read.target ??= linkTarget(element.attrs.href, context.baseUrl);
  if (target === "none") return { open: "", close: "", inherited };
  if (target === "unsafe") {
    context.counters.unsafeLinks++;
    return { open: "", close: "", inherited };
  }
  if (context.linkChars + target.written.length > MAX_LINK_CHARS) {
    context.counters.unlinked++;
    return { open: "", close: "", inherited };
  }
  context.linkChars += target.written.length;
  if (target.unwrapped) context.counters.unwrapped++;
  return { open: `<a href="${target.written}">`, close: "</a>", inherited, link: context.links.open(target.url) };
}

/** An absolute http(s) or mailto URL for an href, resolved against the message's <base>; else undefined. */
function resolveHref(href: string, baseUrl: string | undefined): string | undefined {
  // oxlint-disable-next-line no-control-regex -- browsers ignore control characters and whitespace in schemes
  const cleaned = href.replace(/[\u0000- ]/g, char => char === " " ? "%20" : "");
  // An invisible or format character in an address can reorder or hide part of it as shown.
  if (/^mailto:/i.test(cleaned)) return /^mailto:[^\s<>"]+$/i.test(cleaned) && cleaned.search(INVISIBLE) === -1 && !/\p{Cf}/u.test(cleaned) ? cleaned : undefined;
  if (/^https?:/i.test(cleaned)) return httpUrl(cleaned);
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return undefined;
  return baseUrl ? httpUrl(cleaned, baseUrl) : undefined;
}

function httpUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The real target of a link wrapped by Microsoft Defender Safe Links or Proofpoint URL Defense, which
 * rewrite every link in a message to go through them; anything else as it is.
 */
export function unwrapLink(url: string): { url: string; unwrapped: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, unwrapped: false };
  }
  const host = parsed.hostname.toLowerCase();
  if (host.endsWith(".safelinks.protection.outlook.com") || host === "safelinks.protection.outlook.com") {
    const target = parsed.searchParams.get("url");
    const inner = target ? resolveHref(target, undefined) : undefined;
    if (inner && /^https?:|^mailto:/i.test(inner)) return { url: unwrapLink(inner).url, unwrapped: true };
  }
  if (host === "urldefense.com" || host === "urldefense.proofpoint.com") {
    const v3 = /^\/v3\/__(.+?)__;/.exec(parsed.pathname + parsed.search);
    if (v3) {
      const inner = httpUrl(v3[1]!);
      if (inner) return { url: inner, unwrapped: true };
    }
    const u = parsed.searchParams.get("u");
    if (parsed.pathname.startsWith("/v2/url") && u) {
      const decoded = httpUrl(u.replace(/_/g, "/").replace(/-([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))));
      if (decoded) return { url: decoded, unwrapped: true };
    }
  }
  return { url, unwrapped: false };
}

/** Collects links in order, once per target, flagging a target whose text names another site. */
class LinkCollector {
  readonly #links = new Map<string, MessageLink>();

  /** Takes a link's place in order as it opens, and returns what names it by its text (or else its target) once that is read. */
  open(url: string): (text: string) => void {
    let link = this.#links.get(url);
    const first = link === undefined && this.#links.size < MAX_LINKS;
    if (first) this.#links.set(url, link = { text: "", url });
    return text => {
      const shown = text || url;
      if (first) link!.text = shown.slice(0, 500);
      if (link && linkMismatch(shown, url)) link.mismatch = true;
    };
  }

  add(text: string, url: string): void {
    this.open(url)(text);
  }

  list(): MessageLink[] {
    return [...this.#links.values()];
  }
}

/** Suffixes under which a registrable domain has three labels, not two. */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk", "net.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "ac.jp", "co.in", "net.in", "org.in", "com.br", "com.cn", "net.cn", "org.cn",
  "com.mx", "co.za", "com.sg", "com.hk", "co.kr", "com.tr", "com.tw", "co.il", "com.ar", "co.id", "com.my", "com.ph",
]);

/** The registrable part of a host name ("mail.contoso.co.uk" → "contoso.co.uk"), in punycode. */
export function registrableDomain(host: string): string {
  let ascii: string;
  try {
    ascii = new URL(`http://${host}`).hostname;
  } catch {
    return host.toLowerCase();
  }
  if (/^[0-9.]+$/.test(ascii) || ascii.startsWith("[")) return ascii;
  const labels = ascii.replace(/\.$/, "").split(".");
  const take = labels.length >= 3 && MULTI_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-take).join(".");
}

const URLISH = /^(?:https?:\/\/)?((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,})(?::\d+)?(?:[/?#]\S*)?$/u;
const EMAILISH = /^[^\s@]+@((?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,})$/u;

/** Whether a link's visible text names a different site (or email domain) than it goes to. */
export function linkMismatch(text: string, url: string): boolean {
  const shown = text.trim().replace(/^<|>$/g, "");
  const textHost = URLISH.exec(shown)?.[1] ?? (url.startsWith("mailto:") ? EMAILISH.exec(shown)?.[1] : undefined);
  if (textHost === undefined) return false;
  let targetHost: string;
  if (url.toLowerCase().startsWith("mailto:")) {
    let address: string;
    try {
      address = decodeURIComponent(url.slice(7).split("?")[0] ?? "");
    } catch {
      return true;
    }
    targetHost = address.slice(address.lastIndexOf("@") + 1);
  } else {
    try {
      targetHost = new URL(url).hostname;
    } catch {
      return true;
    }
  }
  return registrableDomain(textHost) !== registrableDomain(targetHost);
}

/** A text body as Markdown-ish text: line endings normalized, invisible characters and Safe Links undone. */
function textToMarkdown(content: string, counters: Counters, links: LinkCollector): string {
  let text = content.replace(/\r\n?/g, "\n").replace(INVISIBLE, char => {
    if (char === "\n" || char === "\t") return char;
    counters.invisibleChars++;
    return "";
  });
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, match => {
    const trailing = /[.,;:!?)\]]+$/.exec(match)?.[0] ?? "";
    const bare = trailing ? match.slice(0, -trailing.length) : match;
    const valid = httpUrl(bare);
    if (!valid) return match;
    const { url, unwrapped } = unwrapLink(valid);
    if (unwrapped) counters.unwrapped++;
    links.add(url, url);
    return (unwrapped ? url : bare) + trailing;
  });
  return text.split("\n").map(trimTrailingBlanks).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Cuts Markdown to `maxChars` at a paragraph, line or word boundary near the limit. */
function truncate(markdown: string, maxChars: number): { text: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { text: markdown, truncated: false };
  const window = markdown.slice(0, maxChars);
  const floor = Math.floor(maxChars * 0.6);
  let cut = window.lastIndexOf("\n\n");
  if (cut < floor) cut = window.lastIndexOf("\n");
  if (cut < floor) cut = window.lastIndexOf(" ");
  if (cut < floor) cut = maxChars;
  // Never split a surrogate pair.
  if (cut > 0 && /[\ud800-\udbff]/.test(markdown[cut - 1]!)) cut--;
  return { text: markdown.slice(0, cut).trimEnd(), truncated: true };
}

// -- writing ------------------------------------------------------------------------------------

const FONT = "font-family:Aptos,Calibri,Arial,Helvetica,sans-serif;font-size:11pt";
const MONO = "font-family:Consolas,'Courier New',monospace;font-size:10pt";

/** Markdown as the HTML body of a new message: inline-styled, every character escaped, links checked. */
export function markdownToMailHtml(markdown: string): string {
  const blocks = parseMarkdown(markdown);
  return `<div style="${FONT}">${blocksHtml(blocks)}</div>`;
}

function blocksHtml(blocks: readonly MdBlock[]): string {
  return blocks.map(blockHtml).join("");
}

function blockHtml(block: MdBlock): string {
  switch (block.kind) {
    case "heading": {
      const size = [0, 18, 15, 13, 12, 11, 11][block.level];
      return `<h${block.level} style="margin:12pt 0 6pt;font-size:${size}pt;font-weight:600">${inlinesHtml(block.inlines)}</h${block.level}>`;
    }
    case "paragraph": return `<p style="margin:0 0 8pt">${inlinesHtml(block.inlines)}</p>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
      const items = block.items.map(item => {
        const box = item.checked === undefined ? "" : item.checked ? "☒ " : "☐ ";
        const [first, ...rest] = item.blocks;
        const lead = first?.kind === "paragraph" ? box + inlinesHtml(first.inlines) : box + (first ? blockHtml(first) : "");
        return `<li style="margin:0 0 2pt">${lead}${blocksHtml(rest)}</li>`;
      }).join("");
      return `<${tag}${start} style="margin:0 0 8pt;padding-left:24pt">${items}</${tag}>`;
    }
    case "quote":
      return `<blockquote style="margin:0 0 8pt;padding-left:10pt;border-left:3px solid #c8c8c8;color:#555555">${blocksHtml(block.blocks)}</blockquote>`;
    case "code":
      return `<pre style="margin:0 0 8pt;padding:6pt;background:#f4f4f4;${MONO};white-space:pre-wrap">${escapeHtml(block.text)}</pre>`;
    case "table": {
      const cell = (tag: "th" | "td", inlines: readonly MdInline[], index: number) => {
        const align = block.align[index];
        return `<${tag} style="border:1px solid #c8c8c8;padding:4pt 6pt;text-align:${align ?? "left"}${tag === "th" ? ";background:#f2f2f2;font-weight:600" : ""}">${inlinesHtml(inlines)}</${tag}>`;
      };
      const head = `<tr>${block.header.map((inlines, index) => cell("th", inlines, index)).join("")}</tr>`;
      const body = block.rows.map(row => `<tr>${row.map((inlines, index) => cell("td", inlines, index)).join("")}</tr>`).join("");
      return `<table style="border-collapse:collapse;margin:0 0 8pt;${FONT}"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }
    case "rule": return `<hr style="border:none;border-top:1px solid #c8c8c8;margin:8pt 0">`;
  }
}

function inlinesHtml(inlines: readonly MdInline[]): string {
  return inlines.map(inline => {
    if (inline.kind === "break") return "<br>";
    if (inline.kind === "link") {
      const href = safeMarkdownHref(inline.href);
      const inner = inlinesHtml(inline.children);
      return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
    }
    let html = escapeHtml(inline.text);
    if (inline.style.code) html = `<code style="${MONO};background:#f4f4f4">${html}</code>`;
    if (inline.style.strike) html = `<s>${html}</s>`;
    if (inline.style.italic) html = `<em>${html}</em>`;
    if (inline.style.bold) html = `<strong>${html}</strong>`;
    return html;
  }).join("");
}

// -- validating what an agent passes --------------------------------------------------------------

/** The longest address Exchange accepts. */
const MAX_ADDRESS_CHARS = 320;
/** The longest subject accepted. */
export const MAX_SUBJECT_CHARS = 255;
/** The longest Markdown body accepted. */
export const MAX_BODY_CHARS = 1_000_000;
/** Graph's limit for an attachment added in one request; larger ones need an upload session. */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** The longest attachment name accepted. */
const MAX_ATTACHMENT_NAME_CHARS = 255;

const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** A recipient: a bare address, or `Name <address>`. Throws, saying what is wrong, for anything else. */
export function parseRecipient(text: string): EmailAddress {
  if (typeof text !== "string") throw new Error("A recipient must be text, like \"ada@contoso.com\" or \"Ada Lovelace <ada@contoso.com>\".");
  // oxlint-disable-next-line no-control-regex -- refusing control characters, line breaks included, is the point
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`The recipient "${printable(text)}" contains a line break or control character.`);
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("A recipient can't be empty.");
  // A group ("Team: a@x.com, b@x.com;") names its members before the colon.
  if (/^[^<>"@]*:.*;$/.test(trimmed)) throw new Error(`"${printable(text)}" is a group, which can't be a recipient. Pass each member separately.`);
  let name: string | undefined;
  let address: string;
  const named = /^(.*?)\s*<([^<>]*)>$/.exec(trimmed);
  if (named) {
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(named[1]!.trim());
    name = quoted ? quoted[1]!.replace(/\\(.)/g, "$1").trim() : named[1]!.trim();
    address = named[2]!.trim();
    if (/[<>]/.test(name) || (!quoted && /[",;]/.test(name))) throw new Error(`"${printable(text)}" isn't one recipient. Pass each recipient separately.`);
    if (!quoted && /[()]/.test(name)) throw new Error(`"${printable(text)}" has a comment in it. Quote the name ("Ada (CEO)" <ada@contoso.com>) or leave it out.`);
  } else {
    address = trimmed;
  }
  if (/[,;]/.test(address) || /\s/.test(address) || /@.*@/.test(address)) {
    throw new Error(`"${printable(text)}" looks like more than one recipient. Pass each recipient separately.`);
  }
  if (/[()]/.test(address)) throw new Error(`"${printable(text)}" has a comment in it. Pass just the address.`);
  if (address.length > MAX_ADDRESS_CHARS) throw new Error(`An address can be at most ${MAX_ADDRESS_CHARS} characters.`);
  if (!ADDRESS.test(address)) throw new Error(`"${printable(address)}" isn't an email address.`);
  const at = address.lastIndexOf("@");
  const result: EmailAddress = { address: address.slice(0, at) + address.slice(at).toLowerCase() };
  if (name) {
    if (name.length > 256) throw new Error("A recipient's name can be at most 256 characters.");
    result.name = name;
  }
  return result;
}

/** A recipient list, deduplicated by address (ignoring case). */
export function parseRecipients(list: unknown, field: string, max = 100): EmailAddress[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${field} must be a list of recipients.`);
  if (list.length > max) throw new Error(`${field} can have at most ${max} recipients.`);
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  list.forEach((entry, index) => {
    let parsed: EmailAddress;
    try {
      parsed = parseRecipient(entry as string);
    } catch (error) {
      throw new Error(`${field}[${index}]: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const key = parsed.address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(parsed);
  });
  return out;
}

/** Who wrote a message, relative to the mailbox: its owner, someone in one of the organization's domains, or someone else. */
export function senderKind(address: string | undefined, me: string, orgDomains: readonly string[]): SenderKind {
  if (!address) return "external";
  const lower = address.toLowerCase();
  if (lower === me.toLowerCase()) return "you";
  const domain = lower.slice(lower.lastIndexOf("@") + 1);
  return orgDomains.some(org => org.toLowerCase() === domain) ? "internal" : "external";
}

/** Checks a subject: one line, at most 255 characters. */
export function checkSubject(subject: string): string {
  if (typeof subject !== "string") throw new Error("A subject must be text.");
  // oxlint-disable-next-line no-control-regex -- a subject is one line of text
  if (/[\u0000-\u001f\u007f]/.test(subject)) throw new Error("A subject can't contain line breaks or control characters.");
  if (subject.length > MAX_SUBJECT_CHARS) throw new Error(`A subject can be at most ${MAX_SUBJECT_CHARS} characters.`);
  return subject;
}

/** Checks a body's size. */
export function checkBody(markdown: string): string {
  if (typeof markdown !== "string") throw new Error("A body must be text (Markdown).");
  if (markdown.length > MAX_BODY_CHARS) throw new Error(`A body can be at most ${MAX_BODY_CHARS.toLocaleString("en-US")} characters.`);
  return markdown;
}

const CONTENT_TYPES: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", xml: "application/xml",
  html: "text/html", htm: "text/html", ics: "text/calendar", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
  eml: "message/rfc822",
};

/** An attachment as name, media type and bytes, checked against Graph's per-request limit. */
export function attachmentBytes(input: AttachmentInput): { name: string; contentType: string; bytes: Uint8Array } {
  if (input === null || typeof input !== "object") throw new Error("An attachment is { name, content }.");
  const { name } = input;
  if (typeof name !== "string" || name.trim() === "") throw new Error("An attachment needs a name.");
  // oxlint-disable-next-line no-control-regex -- a file name has no control characters or path separators
  if (/[\u0000-\u001f\u007f/\\]/.test(name)) throw new Error(`The attachment name "${printable(name)}" can't contain slashes or control characters.`);
  if (name.length > MAX_ATTACHMENT_NAME_CHARS) throw new Error(`An attachment name can be at most ${MAX_ATTACHMENT_NAME_CHARS} characters.`);
  if (name === "." || name === "..") throw new Error(`"${name}" isn't a file name.`);
  const bytes = typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content;
  if (!(bytes instanceof Uint8Array)) throw new Error(`The content of "${name}" must be text or a Uint8Array.`);
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`"${name}" is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB; an attachment can be at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB. Share a link to a SharePoint or OneDrive file instead.`);
  }
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const given = typeof input.contentType === "string" ? input.contentType.trim().toLowerCase() : "";
  if (given !== "" && !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(given)) {
    throw new Error(`"${printable(input.contentType ?? "")}" isn't a media type, like "application/pdf".`);
  }
  const contentType = given || CONTENT_TYPES[extension] || (typeof input.content === "string" ? "text/plain" : "application/octet-stream");
  return { name, contentType, bytes };
}

/** Text with control characters shown as escapes, for an error message. */
function printable(text: string): string {
  // oxlint-disable-next-line no-control-regex -- showing control characters visibly
  return text.slice(0, 120).replace(/[\u0000-\u001f\u007f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
