// Inputs shaped to make a regex over raw XML or text backtrack for seconds (unclosed tags repeated,
// a tag that never reaches `=`, a run of 100,000 spaces), or to make output grow faster than input.
// Every reader here is now a linear parser with bounds, so each must fail or finish in well under a
// second even when the input is hostile.

import { readFileSync } from "node:fs";
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
import { mailToMarkdown } from "../../src/outlook-content";
import { pageMarkdown } from "../../src/sharepoint-content";
import { buildDocx, buildPptx, paragraph, run, shape, slideParagraph } from "./test-fixtures";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const DECK = fixture("python-pptx-deck.pptx");
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** Runs `work`, asserting it took less than `ms` of wall-clock time whether it resolved or threw. */
async function timed<T>(work: () => Promise<T> | T, ms = 200): Promise<{ result?: T; error?: unknown }> {
  const started = performance.now();
  let outcome: { result?: T; error?: unknown };
  try {
    outcome = { result: await work() };
  } catch (error) {
    outcome = { error };
  }
  expect(performance.now() - started, "wall-clock time").toBeLessThan(ms);
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
