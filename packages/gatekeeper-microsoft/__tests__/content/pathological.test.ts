// Inputs shaped to make a regex over raw XML or text backtrack for seconds (unclosed tags repeated,
// a tag that never reaches `=`, a run of 100,000 spaces), or to make output grow faster than input.
// Every reader here is now a linear parser with bounds, so each must fail or finish in well under a
// second even when the input is hostile.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { docxToMarkdown } from "../../src/content/docx";
import { docxFeatures } from "../../src/content/docx-features";
import { checkOfficePackage } from "../../src/content/package-check";
import { editPptx, PresentationEditError } from "../../src/content/pptx-edit";
import { pptxFeatures } from "../../src/content/pptx-features";
import { pptxToMarkdown } from "../../src/content/pptx";
import { describePptx } from "../../src/content/pptx-describe";
import { OpcPackage } from "../../src/content/pptx-package";
import { parseRaw, RawXmlError } from "../../src/content/raw-xml";
import { parseXml, XmlError } from "../../src/content/xml";
import { writeZip } from "../../src/content/zip-write";
import { htmlToMarkdown } from "../../src/html-markdown";
import { featuresLost } from "../../src/office-write";
import { MAX_MAIL_HTML_CHARS, mailToMarkdown } from "../../src/outlook-content";
import { pageMarkdown } from "../../src/sharepoint-content";
import { buildDocx, buildPptx, paragraph, run, shape, slideParagraph } from "./test-fixtures";

const fixture = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url).href)));
const DECK = fixture("python-pptx-deck.pptx");
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/**
 * Runs `work`, asserting it used less than `ms` of this thread's CPU time whether it resolved or threw.
 * CPU time rather than wall-clock, because a CI runner busy with other suites can stretch the wall
 * clock tenfold, while backtracking or a rescan is CPU work on this thread and still blows the budget.
 */
async function timed<T>(work: () => Promise<T> | T, ms = 200): Promise<{ result?: T; error?: unknown }> {
  const started = process.threadCpuUsage();
  let outcome: { result?: T; error?: unknown };
  try {
    outcome = { result: await work() };
  } catch (error) {
    outcome = { error };
  }
  const { user, system } = process.threadCpuUsage(started);
  expect((user + system) / 1000, "CPU time").toBeLessThan(ms);
  return outcome;
}

/** The deck with one part's text replaced. */
async function withPart(name: string, text: string): Promise<Uint8Array> {
  const pkg = await OpcPackage.open(DECK);
  pkg.set(name, text);
  return pkg.toBytes();
}

describe("pathological XML", () => {
  it("parseRaw refuses a tag that never reaches = without scanning it again for every character", async () => {
    const tag = `<a ${"x".repeat(1_000_000)}/>`;
    const { error } = await timed(() => parseRaw(tag));
    expect(error).toBeInstanceOf(RawXmlError);
    const spaced = `<a ${"x ".repeat(500_000)}/>`;
    expect((await timed(() => parseRaw(spaced))).error).toBeInstanceOf(RawXmlError);
    expect((await timed(() => parseXml(tag, { namespaces: {} }))).error).toBeInstanceOf(XmlError);
  });

  it("both parsers bound an element's attributes", async () => {
    const attributes = Array.from({ length: 1025 }, (_, index) => `k${index}="v"`).join(" ");
    expect(() => parseRaw(`<a ${attributes}/>`)).toThrow(/more than 1024 attributes/);
    expect(() => parseXml(`<a ${attributes}/>`, { namespaces: {} })).toThrow(expect.objectContaining({ code: "limit" }) as XmlError);
    expect(parseRaw(`<a ${attributes.slice(0, attributes.lastIndexOf(" k1024"))}/>`).attributes.size).toBe(1024);
  });

  it("parseRaw bounds the elements in a part", () => {
    expect(() => parseRaw(`<a>${"<b/>".repeat(250_001)}</a>`)).toThrow(/more than 250000 elements/);
  });

  it("docxFeatures gives up on 20,000 unclosed table cells at once", async () => {
    const hostile = await buildDocx({ body: "<w:tc>".repeat(20_000) });
    expect((await timed(() => docxFeatures(hostile))).error).toBeInstanceOf(XmlError);
    expect((await timed(() => featuresLost("x.docx", hostile))).result).toEqual([]);
    const fallbacks = await buildDocx({ body: `<w:p>${"<mc:Fallback>".repeat(20_000)}` });
    expect((await timed(() => featuresLost("x.docx", fallbacks))).result).toEqual([]);
  });

  it("checkOfficePackage reads a hostile part once", async () => {
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const bytes = await writeZip([
      { name: "[Content_Types].xml", data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>' },
      { name: "word/document.xml", data: `<w:document xmlns:w="${W}"><w:body>${"<w:instrText>".repeat(50_000)}` },
      { name: "xl/sheet.xml", data: `<x xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${"<f>".repeat(50_000)}` },
    ]);
    const { error } = await timed(() => checkOfficePackage("docx", bytes));
    expect(error).toMatchObject({ message: expect.stringMatching(/too deeply nested to check/) as string });
  });

  it("pptxFeatures gives up on a notes page of unclosed shapes at once", async () => {
    const notes = (await OpcPackage.open(DECK)).names().find(name => name.startsWith("ppt/notesSlides/") && name.endsWith(".xml"))!;
    const hostile = await withPart(notes, `<p:notes ${P}><p:cSld><p:spTree>${"<p:sp>".repeat(20_000)}`);
    expect((await timed(() => pptxFeatures(hostile))).error).toBeInstanceOf(XmlError);
    expect((await timed(() => featuresLost("x.pptx", hostile))).result).toEqual([]);
  });

  it("editPptx refuses a slide of unclosed paragraphs and shapes at once", async () => {
    const paragraphs = await withPart("ppt/slides/slide2.xml", `<p:sld ${P}><p:cSld><p:spTree>${"<a:p>".repeat(20_000)}`);
    const { error } = await timed(() => editPptx(paragraphs, [{ find: "Revenue", replace: "Sales", all: true }]));
    expect(error).toBeInstanceOf(PresentationEditError);
    expect((error as Error).message).toMatch(/XML can't be edited/);
    const shapes = await withPart("ppt/slides/slide2.xml", `<p:sld ${P}><p:cSld><p:spTree>${"<p:sp>".repeat(20_000)}`);
    expect((await timed(() => editPptx(shapes, [{ setText: { slide: 2, placeholder: "title", markdown: "x" } }]))).error).toBeInstanceOf(PresentationEditError);
  });

  it("editPptx refuses a presentation part of unclosed slide lists at once", async () => {
    const hostile = await withPart("ppt/presentation.xml", `<p:presentation ${P}>${"<p:sldIdLst>".repeat(20_000)}`);
    const { error } = await timed(() => editPptx(hostile, [{ deleteSlide: 1 }]));
    expect(error).toBeInstanceOf(PresentationEditError);
    expect((error as Error).message).toMatch(/presentation's XML can't be edited/);
  });
});

describe("pathological text", () => {
  const spaces = " ".repeat(100_000);

  it("docxToMarkdown trims a heading of 100,000 spaces in one pass", async () => {
    const bytes = await buildDocx({ body: paragraph(run(`Title${spaces}end`), '<w:outlineLvl w:val="0"/>') });
    const { result } = await timed(() => docxToMarkdown(bytes));
    expect(result?.markdown).toBe(`# Title${spaces}end`);
  });

  it("pptxToMarkdown and describePptx trim a title of 100,000 spaces in one pass", async () => {
    const bytes = await buildPptx([{ shapes: shape('<p:ph type="title"/>', slideParagraph(`Title${spaces}end`)) }]);
    const { result } = await timed(() => pptxToMarkdown(bytes));
    expect(result?.markdown).toBe(`## Slide 1: Title${spaces}end`);
    const deck = await OpcPackage.open(DECK);
    deck.set("ppt/slides/slide1.xml", deck.text("ppt/slides/slide1.xml")!.replace("<a:t>Northwind Quarterly Review</a:t>", `<a:t>Title${spaces}end</a:t>`));
    const retitled = await deck.toBytes();
    const described = await timed(() => describePptx(retitled));
    expect(described.result?.[0]?.placeholders.find(placeholder => placeholder.type === "title")?.markdown).toBe(`Title${spaces}end`);
  });

  it("htmlToMarkdown trims preformatted text in one pass and bounds list and quote nesting", async () => {
    const pre = await timed(() => htmlToMarkdown(`<pre>x${spaces}y${spaces}</pre>`));
    expect(pre.result).toBe(`\`\`\`\nx${spaces}y\n\`\`\``);
    const lists = await timed(() => htmlToMarkdown(`${"<ul><li>".repeat(4000)}deep${"</li></ul>".repeat(4000)}`));
    expect(lists.result!.length).toBeLessThan(300_000);
    expect(lists.result!.endsWith(`\n${"  ".repeat(31)}- deep`)).toBe(true);
    const quotes = await timed(() => htmlToMarkdown(`${"<blockquote>".repeat(4000)}deep${"</blockquote>".repeat(4000)}`));
    expect(quotes.result).toBe(`${"> ".repeat(32)}deep`);
  });

  it("mailToMarkdown reads a brace-less 200 KB stylesheet and a text body of 200,000 spaces in one pass", async () => {
    const styled = { contentType: "html" as const, content: `<style>${"a".repeat(200_000)}</style><p>Hi</p>` };
    expect((await timed(() => mailToMarkdown(styled, { maxChars: 50_000 }))).result?.markdown).toBe("Hi");
    const text = { contentType: "text" as const, content: `x${spaces}${spaces}y` };
    expect((await timed(() => mailToMarkdown(text, { maxChars: 500_000 }))).result?.markdown).toBe(`x${spaces}${spaces}y`);
  });

  const mail = (content: string) => mailToMarkdown({ contentType: "html", content }, { maxChars: 50_000 });

  it("mailToMarkdown finds style elements in one pass when they are never closed or never reach >", async () => {
    expect((await timed(() => mail(`<p>Hi</p>${"<style>".repeat(30_000)}`))).result?.markdown).toBe("Hi");
    expect((await timed(() => mail(`${"<style ".repeat(30_000)}`))).result?.removed).toEqual([]);
  });

  it("mailToMarkdown finds a doctype after many comments, or a long or unclosed one, in one pass", async () => {
    expect((await timed(() => mail(`${"<!--x-->".repeat(35_000)}<!doctype html><p>Hi</p>`))).result?.markdown).toBe("Hi");
    expect((await timed(() => mail(`${"<?x></ x><!x>".repeat(20_000)}<!doctype html><p>Hi</p>`))).result?.markdown).toBe("Hi");
    expect((await timed(() => mail(`<!doctype html public "${"-//".repeat(90_000)}" "x"><p>Hi</p>`))).result?.markdown).toBe("Hi");
    expect((await timed(() => mail(`<!doctype html public "${"x".repeat(270_000)}<p>Hi</p>`))).result?.removed).toEqual([]);
    expect((await timed(() => mail(`${"<!".repeat(140_000)}<p>Hi</p>`))).result?.removed).toEqual([]);
  });

  it("mailToMarkdown strips a stylesheet's comments in one pass when none is closed", async () => {
    expect((await timed(() => mail(`<style>${"/*a".repeat(50_000)}</style><p>Hi</p>`))).result?.markdown).toBe("Hi");
  });

  it("mailToMarkdown reads selectors in one pass when their pseudo-classes and attribute tests never close", async () => {
    expect((await timed(() => mail(`<style>${":a(".repeat(50_000)}{display:none}</style><p>Hi</p>`))).result?.markdown).toBe("Hi");
    // Only the last `[` is closed, so to a browser the `{` falls inside the others and opens no rule;
    // the reader before this one read the last test, and what it hid is hidden.
    expect((await timed(() => mail(`<style>${"[a=''".repeat(30_000)}]{display:none}</style><p a>A</p><p>B</p>`))).result?.markdown).toBe("B");
    expect((await timed(() => mail(`<style>${"[a='']".repeat(30_000)}{display:none}</style><p a>A</p><p>B</p>`))).result?.markdown).toBe("B");
  });

  it("mailToMarkdown reads a stylesheet of blocks, brackets and strings never closed in one pass", async () => {
    for (const piece of ["{", "(", "a{", ".x{display:none;", "}", "\"/*\n", "@a;"]) {
      // At most 290,000 characters: past 300,000, mail isn't converted. 18,000 declarations take about
      // 70 ms alone and passed 200 ms once in a full parallel run, so that piece gets more room.
      const ms = piece === ".x{display:none;" ? 1_000 : undefined;
      expect((await timed(() => mail(`<style>${piece.repeat(50_000).slice(0, 290_000)}</style><p>Hi</p>`), ms)).result?.markdown).toBe("Hi");
    }
  });

  it("mailToMarkdown reads a long number as a CSS length in one pass", async () => {
    expect((await timed(() => mail(`<p style="width:${"1".repeat(30_000)}x">Hi</p>`))).result?.markdown).toBe("Hi");
    expect((await timed(() => mail(`<p style="font-size:${"1".repeat(30_000)}x%">Hi</p>`))).result?.markdown).toBe("Hi");
  });

  it("mailToMarkdown reads a transform of unclosed translate() calls in one pass", async () => {
    expect((await timed(() => mail(`<p style="transform:${"translate(".repeat(29_000)}">Hi</p>`))).result?.markdown).toBe("Hi");
  });

  // Each of the next five took quadratic time on a long run of white space, read by a regex that
  // backtracked over it from every place in it: 0.7 to 1.4 seconds here at these sizes.
  it("mailToMarkdown trims a colour attribute holding a long run of white space in one pass", async () => {
    expect((await timed(() => mail(`<body text="x${" ".repeat(50_000)}x"><p>Hi</p>`))).result?.markdown).toBe("Hi");
  });

  it("mailToMarkdown tests an <rp> holding a long run of white space in one pass", async () => {
    expect((await timed(() => mail(`<ruby>x<rp>${" ".repeat(60_000)}x</rp></ruby><p>Hi</p>`))).result)
      .toMatchObject({ markdown: "x\n\nHi", removed: ["hidden text"] });
  });

  it("mailToMarkdown reads a url() with a long run of white space before a string in one pass", async () => {
    expect((await timed(() => mail(`<p style="background:url(${" ".repeat(60_000)}'a'x)">Hi</p>`))).result?.markdown).toBe("Hi");
  });

  it("mailToMarkdown splits an rgb()'s arguments without commas at a long run of white space in one pass", async () => {
    expect((await timed(() => mail(`<p style="color:rgb(1${" ".repeat(50_000)}2 3)">Hi</p>`))).result?.markdown).toBe("Hi");
  });

  it("mailToMarkdown splits an rgb()'s arguments with commas past a long run of white space in one pass", async () => {
    expect((await timed(() => mail(`<p style="color:rgb(1,2${" ".repeat(60_000)}x,3)">Hi</p>`))).result?.markdown).toBe("Hi");
  });

  it("mailToMarkdown tests a selector of attribute tests whose values end in i in linear time", async () => {
    // `[a=ai]` read two ways, as a value `ai` or a value `a` and the `i` flag, so a selector that
    // failed at its end was tried every way: 24 tests took 0.9 seconds, each one more twice as long.
    for (const count of [24, 20_000]) {
      expect((await timed(() => mail(`<style>*~-${"-~[A=AI\t]~-".repeat(count)}={color:red}</style><p>Hi</p>`))).result?.markdown).toBe("Hi");
    }
  });

  it("mailToMarkdown reads what nested copies of formatting elements hold no slower than the same outside them", async () => {
    // A copy's readings were kept where the block's own colour had made them the same as others, so
    // three nested copies held four times the readings: the cells inside them took 1.8 times as long
    // as outside them here, and 2.4 times as long as f628d947 at 300,000 characters (Opus's B1).
    const rules = "<style>tbody{background:#fff}tr{color:#000}</style>";
    const cells = `<table>${"<td>x".repeat(20_000)}</table>`;
    const ladder = [0, 1, 2].map(i => `<font color="#0${i}0${i}0${i}"><div style="color:#${i}${i}${i}">`).join("");
    const contents = [rules + cells, `${rules}${ladder}${cells}</font></font></font>`];
    // The fastest of three runs of each, in turn, so a busy machine slows both alike.
    const fastest = [Infinity, Infinity];
    const markdown: string[] = [];
    for (let round = 0; round < 3; round++) {
      contents.forEach((content, at) => {
        const started = performance.now();
        markdown[at] = mail(content).markdown;
        fastest[at] = Math.min(fastest[at]!, performance.now() - started);
      });
    }
    expect(markdown[1]).toBe(markdown[0]);
    expect(fastest[1], "nested copies' wall-clock time").toBeLessThan(fastest[0]! * 1.3 + 10);
  });

  it("mailToMarkdown checks an image against tracking hosts in one pass", async () => {
    expect((await timed(() => mail(`<img src="http://${"links.".repeat(30_000)}" alt="x">`))).result?.markdown).toBe("[image: x]");
    expect((await timed(() => mail(`<img src="http://${"email.mg.".repeat(20_000)}" alt="x">`))).result?.markdown).toBe("[image: x]");
  });

  it("mailToMarkdown applies long rules and many hiding attributes to many elements without multiplying them", async () => {
    const declarations = Array.from({ length: 3_000 }, (_, index) => `p${index}:1;`).join("");
    const paragraphs = (open: string) => `${open}x</p>`.repeat(3_000);
    const shown = Array<string>(3_000).fill("x").join("\n\n");
    expect((await timed(() => mail(`<style>.x{${declarations}}</style>${paragraphs("<p class=x>")}`))).result?.markdown).toBe(shown);
    expect((await timed(() => mail(`<style>p{${declarations}}</style>${paragraphs("<p>")}`))).result?.markdown).toBe(shown);
    expect((await timed(() => mail(`<style>${Array<string>(3_000).fill(".x").join(",")}{display:none;${declarations}}</style><p>x</p>`))).result?.markdown).toBe("x");
    const attributes = Array.from({ length: 3_000 }, (_, index) => `[a${index}]`).join(",");
    expect((await timed(() => mail(`<style>${attributes}{display:none}</style>${paragraphs("<p>")}`))).result?.markdown).toBe(shown);
  });

  it("mailToMarkdown matches a selector of one class repeated or spelled in many cases against many elements, and an SVG of unclosed comments, in one pass", async () => {
    const shown = Array<string>(3_000).fill("X").join("\n\n");
    expect((await timed(() => mail(`<style>${".x".repeat(100_000)}{color:#123}</style>${"<p class=x>X</p>".repeat(3_000)}`))).result?.markdown).toBe(shown);
    // Each spelling matches the element where case is ignored, as it is in quirks mode.
    const name = "abcdefghijklmnop";
    const cases = Array.from({ length: 8_000 }, (_, at) => `.${[...name].map((letter, bit) => ((at >> bit) & 1 ? letter.toUpperCase() : letter)).join("")}`).join("");
    expect((await timed(() => mail(`<style>${cases}{color:#123}</style>${`<p class=${name}>X</p>`.repeat(3_000)}`))).result?.markdown).toBe(shown);
    // A long class or attribute value, folded once, not at every element it is tested on.
    const long = "A".repeat(150_000);
    expect((await timed(() => mail(`<style>[x=${long}]{color:#123}</style>${"<p x=x>X</p>".repeat(3_000)}`))).result?.markdown).toBe(shown);
    expect((await timed(() => mail(`<style>.x.${long}{color:#123}</style>${"<p class=x>X</p>".repeat(3_000)}`))).result?.markdown).toBe(shown);
    // A long value, which would be read at every element it applies to, hides them unread.
    expect((await timed(() => mail(`<style>.x{color:rgb(1 2 3${" ".repeat(150_000)})}</style>${"<p class=x>X</p>".repeat(3_000)}`))).result?.markdown).toBe("");
    const comments = `<svg>${"<style><!--</style>".repeat(15_000)}</svg>`;
    expect((await timed(() => mail(comments))).result?.markdown).toMatch(/^This message is written in a way that can't be read safely here/);
  });

  it("mailToMarkdown reads links opened inside links without reading each one's text once per link around it", async () => {
    const link = "<a href=\"https://a.com/\">";
    expect((await timed(() => mail(`${link.repeat(200)}${"x ".repeat(145_000)}`))).result?.markdown).toMatch(/^(\[\]\(https:\/\/a\.com\/\)){199}\[x x x /);
  });

  it("mailToMarkdown keeps what it reopens bounded once its copies run out, so end tags and links don't read it all", async () => {
    // Once the copies a browser reopens ran out, the list kept to reopen grew with every paragraph
    // that left a <b> open, each copying it, and every end tag or link with nothing to close read it
    // all: these took 2 to 9 seconds each.
    const spend = `<p>${"<b>".repeat(199)}</p>${"<p><b></p>".repeat(110)}`;
    const room = MAX_MAIL_HTML_CHARS - spend.length - 1_000;
    const grow = `<p>${"<b>".repeat(198)}</p>`.repeat(Math.floor(room / 2 / 601));
    mail(spend); // warm up
    // Each takes about 400 ms here; the bound is loose so a loaded CI machine doesn't flake.
    for (const tail of ["</i>".repeat(Math.floor(room / 2 / 4)), "<a>".repeat(Math.floor(room / 2 / 3))]) {
      expect((await timed(() => mail(spend + grow + tail), 2_000)).result).toMatchObject({ markdown: expect.stringMatching(/^\*\*\*\*/), truncated: true });
    }
    const content = "<p><b>x".repeat(Math.floor((MAX_MAIL_HTML_CHARS - 200) / 7));
    const paragraphs = (await timed(() => mailToMarkdown({ contentType: "html", content }, { maxChars: 1_000_000 }), 2_000)).result;
    expect(paragraphs?.markdown).toMatch(/^\*\*x\*\*\n\n\*\*\*\*x\*\*\*\*\n\n/);
    // What follows is left out as a limit of this reader's, which a browser shows: not as hidden text.
    expect(paragraphs).toMatchObject({ removed: [], truncated: true, hidesText: false });
    expect(paragraphs?.markdown).toMatch(/\*\*\n\nSome of what follows is too complex to read here\. Open the original to read all of it\.$/);
    // So is what holds only images: 100 of these 300 figures were left out without a word.
    const figures = mailToMarkdown({ contentType: "html", content: Array.from({ length: 300 }, (_, n) => `<p><font id=f${n}><img alt="Figure ${n}"></p>`).join("") }, { maxChars: 1_000_000 });
    expect(figures).toMatchObject({ truncated: true, hidesText: false });
    expect(figures.markdown).toMatch(/Figure 199[^]*Some of what follows is too complex to read here\./);
  });

  it("mailToMarkdown holds no more elements open than a browser nests, so no end tag walks more", async () => {
    // Each <html> or <body> once opened an element in the one before, not counted as deeper, and each
    // </b> walked them all to the cell: 3.6 to 6.5 seconds in workerd. Now about 30 ms.
    for (const page of ["<html>", "<body>"]) {
      const crafted = `<b><table><td>${page.repeat(29_900)}${"</b>".repeat(29_900)}`;
      expect((await timed(() => mail(crafted), 1_000)).result).toMatchObject({ markdown: "**\n\n**", hidesText: false });
      // Each adds the attributes it hasn't to the page's, in place, costing only its own: copied
      // whole at each, 16,000 of one attribute each took 23.5 seconds in workerd. Neither when each
      // adds one nor when, past 8,000, each adds nothing.
      const name = page.slice(1, -1);
      const distinct = Array.from({ length: 16_000 }, (_, i) => `<${name} x${i}>`).join("");
      const half = Array.from({ length: 8_000 }, (_, i) => `<${name} x${i}>`).join("");
      const same = half + `<${name} x0>`.repeat(Math.floor((MAX_MAIL_HTML_CHARS - half.length - 100) / (name.length + 5)));
      for (const tags of [distinct, same]) {
        expect((await timed(() => mail(`${tags}VISIBLE`), 1_000)).result).toMatchObject({ markdown: "VISIBLE", removed: [], truncated: false, hidesText: false });
      }
    }
    // At the most a browser nests, an end tag walks no more than that, and a ruby's part none: each
    // takes 100 to 300 ms here, and the bound is loose so a loaded CI machine doesn't flake.
    const deep = `<table><td>${"<span>".repeat(505)}`;
    for (const [head, tail] of [[`<b>${deep}`, "</b>"], [`<div>${deep}`, "</div>"], [`<ruby>${"<span>".repeat(505)}`, "<rt>"]] as const) {
      const crafted = head + tail.repeat(Math.floor((MAX_MAIL_HTML_CHARS - head.length - 100) / tail.length));
      expect((await timed(() => mail(crafted), 2_000)).result?.truncated).toBe(false);
    }
  });

  it("mailToMarkdown reads a reopened element's attributes once, however many copies it reopens", async () => {
    // Each copy of a formatting element left open read its style, class list and colour again: a
    // 2,000-character style over the paragraphs after it took 3.1 seconds here and 3.4 in workerd,
    // and a 20,000-character one 30 seconds in workerd. Read once, a copy costs the same however
    // long they are, so every paragraph shows, as in a browser.
    const heads = [
      `<p><b style="${"color:red;".repeat(200)}">x`,
      `<style>.c1{color:red}</style><p><b class="${Array.from({ length: 600 }, (_, i) => `c${i}`).join(" ")}">x`,
      `<p><font color="${"a".repeat(60_000)}">x`,
      `<p><b style="${`font-family:Arial;font-size:11pt;color:#222222;${"mso-ansi-language:EN-US;".repeat(40)}`}">x`,
    ];
    for (const head of heads) {
      const crafted = head + "<p>x".repeat(Math.floor((MAX_MAIL_HTML_CHARS - head.length - 100) / 4));
      expect((await timed(() => mail(crafted), 2_000)).result?.markdown).toMatch(/^(\*\*)?x(\*\*)?\n\n/);
      // 6,000 paragraphs, as many copies, under what is reopened for one message: once each copy
      // was charged by its attributes, a 1,007-character style left the last 2,083 out as hidden text.
      const converted = mailToMarkdown({ contentType: "html", content: head + "<p>x".repeat(6_000) }, { maxChars: 1_000_000 });
      expect(converted.markdown.match(/x/g)).toHaveLength(6_001);
      expect(converted).toMatchObject({ removed: [], truncated: false, hidesText: false });
    }
  });

  it("mailToMarkdown writes no more of the addresses of links reopened as copies than it can hold", async () => {
    // A link is written again with each copy, and its address can grow as it is written: 200 copies
    // of a 20,000-character one wrote 20 to 36 million characters and held some 400 MB in Node.
    // Past MAX_LINK_CHARS, a link is written as its text alone, saying so.
    for (const address of ["漢".repeat(20_000), `?${"&".repeat(20_000)}`, "a".repeat(2_000)]) {
      const head = `<p><a href="https://e.test/${address}">x`;
      const converted = (await timed(() => mailToMarkdown({ contentType: "html", content: head + "<p>x".repeat(15_000) }, { maxChars: 10_000_000 }), 2_000)).result;
      expect(converted?.markdown.match(/x/g)).toHaveLength(15_001);
      expect(converted?.removed).toEqual([expect.stringMatching(/^the addresses of \d+ links, past the most shown here$/)]);
      expect(converted).toMatchObject({ truncated: true, hidesText: false });
    }
  });

  it("htmlToMarkdown writes a long line of short pieces in one pass, in a paragraph or a table cell", async () => {
    expect((await timed(() => htmlToMarkdown("x<b></b>".repeat(50_000)))).result).toBe("x****".repeat(50_000));
    expect((await timed(() => htmlToMarkdown(`<table><tr><td>${"x<b></b>".repeat(50_000)}</td></tr></table>`))).result)
      .toBe(`|  |\n| --- |\n| ${"x****".repeat(50_000)} |`);
  });

  it("pageMarkdown converts no more of a page's HTML than readFile converts of a file's, saying so", () => {
    const part = { kind: "text" as const, html: `<p>${"a ".repeat(600_000)}</p>` };
    const page = pageMarkdown("T", [part, part, { kind: "text", html: "<p>last</p>" }]);
    expect(page.markdown).not.toContain("last");
    expect(page.note).toBe("Truncated: the page's text is longer than 2,000,000 characters of HTML.");
    expect(pageMarkdown("T", [{ kind: "text", html: "<p>last</p>" }])).toEqual({ markdown: "# T\n\nlast" });
  });
});
