// 純関数(仕様書 §9.6): URL の正規化と照合の鍵、テキストの正規化 N1/N2、指紋 F1〜F5、記録の作り方と判定。
// URL は照合の前に SourceStamp §9.1 (g) のとおり format.js の normalizeUrl で utm_* を外す(両側に同じ処理)。
// chrome.* を使わない。fp だけは crypto.subtle を使うので async。
import { normalizeUrl } from "./format.js";

export const FP_IDS = ["F1", "F2", "F3", "F4", "F5"];
// 指紋ごとの範囲(§5 比較3)。判定に使う指紋の範囲が空なら「判定できない」(INV-7)
export const FP_SCOPE = { F1: "body", F2: "body", F3: "main", F4: "main", F5: "headings" };
export const FP_LABEL = {
	F1: "F1 本文全体・N1",
	F2: "F2 本文全体・N2(数字を 0 に)",
	F3: "F3 主な部分・N1",
	F4: "F4 主な部分・N2(数字を 0 に)",
	F5: "F5 見出し・N1",
};
const EXCERPT_CHARS = 160; // D-15
const TITLE_CHARS = 120; // D-15

// `new URL(u)` の href からフラグメントを外す。http・https・file 以外は null(file は試験用: AC-14)
export function canonicalUrl(u) {
	let x;
	try {
		x = new URL(u);
	} catch {
		return null;
	}
	if (x.protocol !== "http:" && x.protocol !== "https:" && x.protocol !== "file:") return null;
	x.hash = "";
	return x.href;
}

// c と、パスが / 以外なら末尾の / を付け外しした物(D-12)
export function urlVariants(c) {
	const x = new URL(c);
	if (x.pathname === "/") return [c];
	x.pathname = x.pathname.endsWith("/") ? x.pathname.slice(0, -1) : x.pathname + "/";
	return [c, x.href];
}

// 一覧の URL とタブの URL の照合に使う鍵: canonicalUrl の後に (g) の utm_* の除去。file はそのまま
export function urlKey(u) {
	const c = canonicalUrl(u);
	if (c === null || c.startsWith("file:")) return c;
	const r = normalizeUrl(c);
	return r.ok ? r.url : null;
}

// NFC → 空白(\s は全角空白も含む)の並びを半角空白 1 つに → 前後を削る
export function n1(s) {
	return String(s ?? "")
		.normalize("NFC")
		.replace(/[\s　]+/g, " ")
		.trim();
}

// n1 の後、半角・全角の数字の並びを 0 に
export function n2(s) {
	return n1(s).replace(/[0-9０-９]+/g, "0");
}

// UTF-8 の SHA-256 の 16 進の先頭 16 桁
export async function fp(s) {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return Array.from(new Uint8Array(buf, 0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

const chars = (s) => Array.from(s).length;
const head = (s, n) => Array.from(s).slice(0, n).join("");

// ローカル時刻の "YYYY-MM-DD HH:mm"
export function stamp(d) {
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// extract.js の戻り値から Snap(§9.4)を作る。本文は残さない(INV-10)
export async function snapshot({ title = "", body = "", main = "", headings = "" } = {}, now = new Date()) {
	const b = n1(body);
	const m = n1(main);
	const h = n1(headings);
	return {
		at: stamp(now),
		f: { F1: await fp(b), F2: await fp(n2(b)), F3: await fp(m), F4: await fp(n2(m)), F5: await fp(h) },
		len: { body: chars(b), main: chars(m), headings: chars(h) },
		title: head(n1(title), TITLE_CHARS),
		excerpt: head(m, EXCERPT_CHARS),
	};
}

// → { kind: "first" | "same" | "changed" | "unknown", eq?: { F1..F5: boolean } }
// "same" は基準があり、本文を読めて、選んだ指紋が一致したときだけ(INV-7)
export function judge(base, snap, fpId) {
	if (!snap || snap.len.body === 0) return { kind: "unknown" };
	if (!base) return { kind: "first" };
	if (snap.len[FP_SCOPE[fpId]] === 0) return { kind: "unknown" };
	const eq = Object.fromEntries(FP_IDS.map((k) => [k, base.f[k] === snap.f[k]]));
	return { kind: eq[fpId] ? "same" : "changed", eq };
}
