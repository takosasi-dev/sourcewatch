// lib の純関数と extract.js の試験(FR-20・AC-10)。結果を #summary と body の data-summary に「PASS n / FAIL m」で出す。
// fixtures は同じ拡張の中の iframe で開いて extractPage に渡す(通信の API は使わない: AC-7)。
// AC-14・AC-15 の中身(1 文を変えると変わる・見出しは同じ・入力欄を読まない)もここで確かめる。
import { extractPage } from "../extract.js";
import { FP_IDS, canonicalUrl, fp, judge, n1, n2, snapshot, stamp, urlKey, urlVariants } from "../lib/normalize.js";
import { diffKeys, listFromJson, lookup, normStats, orphanKeys, recordsFromJson, reportRows, ruleUrls } from "../lib/store.js";

const results = [];
async function test(name, fn) {
	try {
		await fn();
		results.push([name, null]);
	} catch (e) {
		results.push([name, e.message]);
	}
}
function eq(actual, expected) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${a} !== ${b}`);
}
function ok(cond, msg = "偽") {
	if (!cond) throw new Error(msg);
}
function loadFixture(name) {
	return new Promise((resolve) => {
		const f = document.createElement("iframe");
		f.addEventListener("load", () => resolve(f.contentDocument), { once: true });
		f.src = `fixtures/${name}`;
		document.body.append(f);
	});
}

// --- canonicalUrl ---
await test("canonicalUrl: フラグメントを外す", () => eq(canonicalUrl("https://example.com/a#top"), "https://example.com/a"));
await test("canonicalUrl: 既定のポートを外す", () => eq(canonicalUrl("https://example.com:443/a?b=1"), "https://example.com/a?b=1"));
await test("canonicalUrl: chrome:// は null", () => eq(canonicalUrl("chrome://extensions/"), null));
await test("canonicalUrl: URL でなければ null", () => eq(canonicalUrl("not a url"), null));
await test("canonicalUrl: file は通す(AC-14)", () => eq(canonicalUrl("file:///C:/x/a.html#y"), "file:///C:/x/a.html"));
await test("canonicalUrl: 日本語のパスはブラウザと同じく % に", () =>
	eq(canonicalUrl("https://ja.wikipedia.org/wiki/日本"), "https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC"));
await test("canonicalUrl: 括弧はそのまま", () =>
	eq(canonicalUrl("https://en.wikipedia.org/wiki/Rust_(programming_language)"), "https://en.wikipedia.org/wiki/Rust_(programming_language)"));
await test("canonicalUrl: スキームとホストは小文字", () => eq(canonicalUrl("HTTPS://Example.COM/A"), "https://example.com/A"));

// --- urlVariants ---
await test("urlVariants: / だけなら 1 つ", () => eq(urlVariants("https://example.com/"), ["https://example.com/"]));
await test("urlVariants: 末尾の / を足す", () => eq(urlVariants("https://example.com/a"), ["https://example.com/a", "https://example.com/a/"]));
await test("urlVariants: 末尾の / を外す", () => eq(urlVariants("https://example.com/a/"), ["https://example.com/a/", "https://example.com/a"]));
await test("urlVariants: クエリは残す", () => eq(urlVariants("https://example.com/a?x=1"), ["https://example.com/a?x=1", "https://example.com/a/?x=1"]));

// --- urlKey(SourceStamp §9.1 (g) の utm_* の除去)---
await test("urlKey: utm_* とフラグメントを外す", () => eq(urlKey("https://example.com/a?utm_source=x&id=3#f"), "https://example.com/a?id=3"));
await test("urlKey: utm_* だけなら ? も消す", () => eq(urlKey("https://example.com/a?utm_source=chatgpt.com"), "https://example.com/a"));
await test("urlKey: file はそのまま", () => eq(urlKey("file:///C:/x/a.html?utm_source=x"), "file:///C:/x/a.html?utm_source=x"));
await test("urlKey: javascript: は null", () => eq(urlKey("javascript:alert(1)"), null));

// --- n1・n2 ---
await test("n1: 空白・改行・全角空白をまとめて前後を削る", () => eq(n1("  a\n\tb\u3000\u3000c  "), "a b c"));
await test("n1: NFC にする", () => eq(n1("か\u3099"), "が"));
await test("n1: 空と null", () => eq([n1(""), n1(null)], ["", ""]));
await test("n1: U+00A0 も空白", () => eq(n1("a\u00a0b"), "a b"));
await test("n2: 半角の数字の並びを 0 に", () => eq(n2("2026年10月6日"), "0年0月0日"));
await test("n2: 全角の数字も 0 に", () => eq(n2("２０２６年"), "0年"));
await test("n2: 版番号も消える(§5 の性質)", () => eq(n2("v1.2.3 閲覧 1,234"), "v0.0.0 閲覧 0,0"));
await test("n2: n1 の後に当てる", () => eq(n2("  12 \n 34 "), "0 0"));

// --- fp ---
await test("fp: 空文字", async () => eq(await fp(""), "e3b0c44298fc1c14"));
await test("fp: abc", async () => eq(await fp("abc"), "ba7816bf8f01cfea"));
await test("fp: UTF-8 で数える", async () => eq([await fp("\u3042"), await fp("\u304c")], ["dc5a4d3d82f7e157", "e3b21956ce958d25"]));
await test("fp: 16 桁の 16 進", async () => ok(/^[0-9a-f]{16}$/.test(await fp("x".repeat(100000)))));

// --- stamp・snapshot・judge ---
await test("stamp: ローカルの YYYY-MM-DD HH:mm", () => eq(stamp(new Date(2026, 9, 6, 9, 5)), "2026-10-06 09:05"));
await test("snapshot: 抜粋 160 字・タイトル 120 字で切る(INV-10)", async () => {
	const s = await snapshot({ title: "題".repeat(200), body: "x", main: "あ".repeat(500), headings: "" }, new Date(2026, 9, 6, 9, 5));
	eq([Array.from(s.excerpt).length, Array.from(s.title).length, s.at, s.len], [160, 120, "2026-10-06 09:05", { body: 1, main: 500, headings: 0 }]);
	eq(Object.keys(s.f), FP_IDS);
});
const snapOf = (body, main = body, headings = "見出し") => snapshot({ title: "t", body, main, headings });
await test("judge: 読めない・空は判定できない(INV-7)", async () => {
	eq(judge(null, null, "F1").kind, "unknown");
	eq(judge(await snapOf("a"), await snapOf(""), "F1").kind, "unknown");
});
await test("judge: 基準が無ければ初めて", async () => eq(judge(null, await snapOf("a"), "F3").kind, "first"));
await test("judge: 選んだ指紋で同じ・変わった", async () => {
	const base = await snapOf("本文 2026年", "主 1");
	eq(judge(base, await snapOf("本文 2026年", "主 1"), "F1").kind, "same");
	eq(judge(base, await snapOf("本文 2027年", "主 1"), "F1").kind, "changed");
	eq(judge(base, await snapOf("本文 2027年", "主 1"), "F2").kind, "same");
	eq(judge(base, await snapOf("本文 2027年", "主 2"), "F3").kind, "changed");
});
await test("judge: 選んだ範囲が空なら判定できない", async () => eq(judge(await snapOf("a", "a", ""), await snapOf("a", "a", ""), "F5").kind, "unknown"));

// --- 一覧(FR-6・FR-8・D-12)---
const LIST = {
	schema: "sourcewatch-list/1",
	generated_at: "2026-10-06T12:00:00+09:00",
	reports_dir: "レポート/調査レポート",
	reports: [
		{ path: "レポート/調査レポート/b/日付なし.md", date: null, date_source: null },
		{ path: "レポート/調査レポート/a/2026-08-17_x.md", date: "2026-08-17", date_source: "ファイル名" },
		{ path: "レポート/調査レポート/c/y.md", date: "2026-09-01", date_source: "作成日" },
	],
	links: [
		{ url: "https://example.com/docs", report: 0, line: 1, text: "" },
		{ url: "https://example.com/docs#part", report: 1, line: 2, text: "d" },
		{ url: "https://example.com/docs", report: 1, line: 5, text: "d" },
		{ url: "https://example.com/docs", report: 2, line: 7, text: "d" },
		{ url: "https://example.com/?utm_source=chatgpt.com", report: 2, line: 8, text: "top" },
		{ url: "mailto:a@example.com", report: 2, line: 9, text: "m" },
	],
	stats: { files_scanned: 3, files_with_links: 3, links: 6, urls: 4, hosts: 1 },
};
await test("listFromJson: 件数とフラグメントのまとめ", () => {
	const r = listFromJson(LIST, "list.json", new Date("2026-10-06T03:00:00Z"));
	eq([r.ok, r.info.links, r.info.urls, r.info.keys, r.info.skipped], [true, 6, 4, 2, 1]);
	eq(r.list.urls["https://example.com/docs"].length, 4);
	eq([r.list.importedAt, r.list.fileName, r.list.reportsDir], ["2026-10-06T03:00:00.000Z", "list.json", "レポート/調査レポート"]);
});
await test("listFromJson: schema が違えば読まない(AC-12)", () => {
	const r = listFromJson({ ...LIST, schema: "sourcewatch-list/2" });
	eq(r.ok, false);
	ok(r.error.includes("schema"));
});
await test("listFromJson: report の添字が範囲外", () => eq(listFromJson({ ...LIST, links: [{ url: "https://a.example/", report: 9, line: 1, text: "" }] }).ok, false));
await test("listFromJson: 配列でない・オブジェクトでない", () => eq([listFromJson([]).ok, listFromJson({ ...LIST, links: {} }).ok], [false, false]));
const list = listFromJson(LIST).list;
await test("lookup: 末尾の / ・フラグメント・utm_* の違いを引き当てる", () => {
	eq(lookup(list, "https://example.com/docs/").key, "https://example.com/docs");
	eq(lookup(list, "https://example.com/docs#x").key, "https://example.com/docs");
	eq(lookup(list, "https://example.com/docs?utm_medium=y").key, "https://example.com/docs");
	eq(lookup(list, "https://example.com/").key, "https://example.com/");
});
await test("lookup: 一覧に無い・chrome://", () => eq([lookup(list, "https://example.com/other"), lookup(list, "chrome://newtab/"), lookup(null, "https://example.com/")], [null, null, null]));
await test("ruleUrls: 末尾の / の 2 通り", () => eq(ruleUrls(list).sort(), ["https://example.com/", "https://example.com/docs", "https://example.com/docs/"]));
await test("reportRows: 日付の古い順・日付不明は最後・か所を数える(FR-8)", () =>
	eq(
		reportRows(list, list.urls["https://example.com/docs"]).map((r) => [r.shortPath, r.date, r.count]),
		[
			["a/2026-08-17_x.md", "2026-08-17", 2],
			["c/y.md", "2026-09-01", 1],
			["b/日付なし.md", null, 1],
		],
	));
await test("diffKeys: 増えた・消えた", () => {
	const next = listFromJson({ ...LIST, links: [{ url: "https://example.com/new", report: 0, line: 1, text: "" }] }).list;
	eq(diffKeys(list, next), { added: 1, removed: 2 });
	eq(diffKeys(null, next), { added: 1, removed: 0 });
});

// --- 記録の読み戻し(FR-19)---
const snapA = await snapOf("a");
await test("recordsFromJson: 記録・設定・数えを戻す", () => {
	const r = recordsFromJson({
		schema: "sourcewatch-records/1",
		records: { "https://example.com/docs": { base: snapA, last: snapA } },
		settings: { fp: "F2" },
		stats: { popup: 3, judged: 2, changed: 1, byHost: { "example.com": 3 } },
	});
	eq([r.ok, r.records, Object.keys(r.items)], [true, 1, ["sw:rec:https://example.com/docs", "sw:settings", "sw:stats"]]);
});
await test("recordsFromJson: 形が違えば何も入れない", () => {
	eq(recordsFromJson({ schema: "x", records: {} }).ok, false);
	eq(recordsFromJson({ schema: "sourcewatch-records/1", records: { "https://example.com/a": { base: snapA } } }).ok, false);
	eq(recordsFromJson({ schema: "sourcewatch-records/1", records: { "https://example.com/a#x": { base: snapA, last: snapA } } }).ok, false);
	const long = { ...snapA, excerpt: "x".repeat(161) };
	eq(recordsFromJson({ schema: "sourcewatch-records/1", records: { "https://example.com/a": { base: long, last: snapA } } }).ok, false);
});
await test("orphanKeys: 一覧に無い記録", () =>
	eq(orphanKeys({ "sw:rec:https://example.com/docs": 1, "sw:rec:https://gone.example/": 1, "sw:list": 1 }, list), ["sw:rec:https://gone.example/"]));
await test("normStats: 壊れた値は 0", () => eq(normStats({ popup: -1, judged: "x", byHost: { a: 2, b: "y" } }), { popup: 0, judged: 0, changed: 0, byHost: { a: 2, b: 0 } }));

// --- extract.js(D-8・INV-3・AC-14・AC-15)---
const docA = await loadFixture("a.html");
const docB = await loadFixture("b.html");
await test("extractPage: 主な部分は main、見出しは h1〜h3", () => {
	const t = extractPage(docA);
	eq(n1(t.headings), "試験ページ A 一つ目の節 小見出し");
	ok(n1(t.body).includes("ナビ") && !n1(t.main).includes("ナビ") && !n1(t.main).includes("おすすめ"), "main に周りが入った");
	eq(t.title, "SourceWatch 試験ページ A");
});
await test("extractPage: 1 文を変えると F1・F3 が変わり、見出し F5 は同じ(AC-14)", async () => {
	const before = await snapshot(extractPage(docA));
	const p = docA.getElementById("change");
	const old = p.textContent;
	p.textContent = "書き換えた文。";
	const after = await snapshot(extractPage(docA));
	p.textContent = old;
	eq(judge(before, after, "F3").eq, { F1: false, F2: false, F3: false, F4: false, F5: true });
	eq(judge(before, await snapshot(extractPage(docA)), "F3").kind, "same");
});
await test("extractPage: N2 は数字の揺れを消す", async () => {
	const nav = docA.querySelector("nav");
	const old = nav.textContent;
	const before = await snapshot(extractPage(docA));
	nav.textContent = "ナビ: ホーム / 一覧 / 閲覧数 1299";
	const v = judge(before, await snapshot(extractPage(docA)), "F2");
	nav.textContent = old;
	eq([v.kind, v.eq.F1, v.eq.F3], ["same", false, true]);
});
await test("extractPage: 入力欄・contenteditable・script を読まない(AC-15・INV-3)", async () => {
	const t = extractPage(docB);
	const s = await snapshot(t);
	ok(!JSON.stringify(t).includes("秘密"), JSON.stringify(t));
	ok(!JSON.stringify({ base: s, last: s }).includes("秘密"));
	ok(n1(t.main).includes("入力欄のあるページです"), "本文が取れていない");
});
await test("extractPage: textarea・input の中身だけ変えても F1〜F5 は同じ(AC-15)", async () => {
	const before = await snapshot(extractPage(docB));
	const ta = docB.querySelector("textarea");
	ta.value = "秘密を書き換えた";
	ta.textContent = "秘密を書き換えた2";
	docB.querySelector("input").value = "別の秘密";
	docB.querySelector("[contenteditable]").textContent = "秘密3を変えた";
	eq((await snapshot(extractPage(docB))).f, before.f);
});
await test("extractPage: 見出しの中の入力欄・contenteditable・script・style も読まない(INV-3)", () => {
	eq(n1(extractPage(docB).headings), "試験ページ B 見出しの語");
});
await test("extractPage: body が無い文書は空", () => {
	const doc = document.implementation.createDocument(null, "x");
	eq(extractPage(doc), { title: "", body: "", main: "", headings: "" });
});

// --- 結果 ---
const fails = results.filter(([, e]) => e);
const summary = `PASS ${results.length - fails.length} / FAIL ${fails.length}`;
document.getElementById("summary").textContent = summary;
const ol = document.getElementById("list");
for (const [name, e] of results) {
	const li = document.createElement("li");
	li.textContent = e ? `${name}: ${e}` : name;
	if (e) li.className = "fail";
	ol.append(li);
}
document.body.dataset.summary = summary;
document.body.dataset.failures = JSON.stringify(fails);
document.body.dataset.done = "1";
