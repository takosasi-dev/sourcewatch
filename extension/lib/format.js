// SourceStamp の出典行の書式 v2(仕様書 §9.1。v2 は (b) 4 だけ違う)を作る・読む純関数。chrome.*・現在時刻・console を使わず、ほかのファイルを import しない。
// ResearchTabs・PostClip・TimeNote・SourceWatch はこのファイルを改変せずに写し、ハッシュの一致で確かめる。
// 書式を変えるときは FORMAT_VERSION を上げ、兄弟の仕様書に知らせる。

export const FORMAT_VERSION = 2; // 2: (b) 4 の代わりの題の決め方を広げた(Chrome が URL を題にした形・空白だけの題。2026-10-06)

// §8.6 の値(2026-10-06 の仮決め。根拠は NOTES.md)。ここを変えたら FORMAT_VERSION と兄弟の写しも見直す。
export const DEFAULT_STRIP_PARAMS = ["utm_*"]; // {{STRIP_PARAMS_EXTRA}} = 無し
const ESCAPE_EXTRA = ""; // {{ESCAPE_EXTRA}} = 無し。\ [ ] のほかに前へ \ を付ける文字を並べる
const dateSuffix = (date) => `（${date} 確認）`; // {{SUFFIX_STYLE}}。`)` の直後に空白なしで付ける

// §9.4 の stripParams の 1 項目の形。合わない項目は normalizeUrl でも無視する(`*` だけで全部消さないため)。
export const STRIP_PARAM_RE = /^[A-Za-z0-9_.-]+\*?$/;

const ESCAPE_CHARS = "\\[]" + ESCAPE_EXTRA;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const asciiLower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

// (b) 2〜3: 改行・タブ・U+00A0 は空白、ほかの制御文字は消し、続いた半角空白を 1 つにして前後を削る。全角空白は変えない。
function cleanText(s) {
	return s
		.replace(/[\t\n\r ]/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/ {2,}/g, " ")
		.replace(/^ | $/g, "");
}

// (b) 5: 1 文字ずつ見るので `\` を二重に逃がさない
function escapeTitle(s) {
	let out = "";
	for (const c of s) out += ESCAPE_CHARS.includes(c) ? "\\" + c : c;
	return out;
}

// (c): ホスト名+パス。パスは戻す(戻せない・戻すと制御文字が出るなら元のまま)。末尾の / は除く
function fallbackTitle(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return cleanText(url); // http(s) の URL では来ない。写した先で壊れた URL を渡されたときだけ
	}
	let path = parsed.pathname;
	try {
		const decoded = decodeURIComponent(path);
		if (!CONTROL_RE.test(decoded)) path = decoded;
	} catch {
		// 戻せなければ元のまま
	}
	return parsed.hostname + path.replace(/\/+$/, "");
}

// (b) 4: 題が URL と同じか。Chrome は題の無いページの title に、URL を表示用に整えた物(http:// を省く・ホストだけなら
// 末尾の / を省く・%20 や UTF-8 の % を戻す)を入れるので、スキームと末尾の / を外し、% を戻した URL とも比べる
function sameAsUrl(t, u) {
	const bare = (s) => s.replace(/^https?:\/\//i, "").replace(/\/$/, "");
	let shown = u;
	try {
		shown = decodeURI(u);
	} catch {
		// 戻せなければ元のまま
	}
	return bare(t) === bare(u) || bare(t) === bare(shown);
}

function titleOf(rawTitle, url) {
	const t = cleanText(String(rawTitle ?? ""));
	const u = String(url ?? "");
	// 空白(全角を含む)だけの題も、題が無いと同じに扱う
	if (t.trim() !== "" && !sameAsUrl(t, u)) return { text: escapeTitle(t), fallback: false };
	return { text: escapeTitle(fallbackTitle(u)), fallback: true };
}

// (d) 2: 当たる組が 1 つも無ければ 1 文字も変えない(INV-8)
function stripTracking(url, stripParams) {
	const patterns = (Array.isArray(stripParams) ? stripParams : [])
		.filter((p) => typeof p === "string" && STRIP_PARAM_RE.test(p))
		.map(asciiLower);
	const hash = url.indexOf("#");
	const head = hash < 0 ? url : url.slice(0, hash);
	const frag = hash < 0 ? "" : url.slice(hash);
	const q = head.indexOf("?");
	if (q < 0 || patterns.length === 0) return url;
	const hit = (pair) => {
		const name = asciiLower(pair.split("=", 1)[0]);
		return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
	};
	const pairs = head.slice(q + 1).split("&");
	if (!pairs.some(hit)) return url;
	const kept = pairs.filter((p) => p !== "" && !hit(p));
	return head.slice(0, q) + (kept.length ? "?" + kept.join("&") : "") + frag;
}

function parensBalanced(s) {
	let depth = 0;
	for (const c of s) {
		if (c === "(") depth++;
		else if (c === ")" && --depth < 0) return false;
	}
	return depth === 0;
}

// (d) → { ok: true, url } | { ok: false, error: "unsupported-scheme" | "invalid-url" }
export function normalizeUrl(url, stripParams = DEFAULT_STRIP_PARAMS) {
	if (typeof url !== "string") return { ok: false, error: "invalid-url" };
	let protocol;
	try {
		protocol = new URL(url).protocol;
	} catch {
		return { ok: false, error: "invalid-url" };
	}
	if (protocol !== "http:" && protocol !== "https:") return { ok: false, error: "unsupported-scheme" };
	let out = stripTracking(url, stripParams).replace(/ /g, "%20").replace(/</g, "%3C").replace(/>/g, "%3E");
	if (!parensBalanced(out)) out = out.replace(/\(/g, "%28").replace(/\)/g, "%29");
	return { ok: true, url: out };
}

// (b)(c)。逃がした後の文字を返す。url は手を加える前のタブの URL
export function buildTitle(rawTitle, url) {
	return titleOf(rawTitle, url).text;
}

// (a) → { ok: true, line, usedFallbackTitle } | { ok: false, error }。date は呼び出し側がローカルの YYYY-MM-DD で渡す
export function formatSourceLine(
	{ title, url, date } = {},
	{ bullet = true, includeDate = false, stripParams = DEFAULT_STRIP_PARAMS } = {},
) {
	const n = normalizeUrl(url, stripParams);
	if (!n.ok) return n;
	if (includeDate && !DATE_RE.test(String(date ?? ""))) {
		throw new TypeError("formatSourceLine: includeDate が true のとき date は YYYY-MM-DD で渡す");
	}
	const t = titleOf(title, url);
	const line = (bullet ? "- " : "") + "[" + t.text + "](" + n.url + ")" + (includeDate ? dateSuffix(date) : "");
	return { ok: true, line, usedFallbackTitle: t.fallback };
}

// (e) の行の整え: CRLF・CR を LF に、U+00A0 を空白に、行末の空白を削り、先頭と末尾の空行を除いて続いた空行を 1 つにする
function tidyLines(s) {
	const out = [];
	for (const line of s.replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n")) {
		const l = line.trimEnd();
		if (l !== "" || (out.length && out[out.length - 1] !== "")) out.push(l);
	}
	if (out.length && out[out.length - 1] === "") out.pop();
	return out;
}

// (e) → { lines: string[], truncated }。空なら lines は []。
// 上限の文字数は、整えた後の行を LF でつないだ文字列のコードポイントで数える(LF も 1 文字)。切った後も (e) の整えをもう一度当てる
export function formatQuote(text, { quoteMaxChars = 0 } = {}) {
	let lines = tidyLines(String(text ?? ""));
	let truncated = false;
	if (quoteMaxChars > 0) {
		const chars = [...lines.join("\n")];
		if (chars.length > quoteMaxChars) {
			lines = tidyLines(chars.slice(0, quoteMaxChars).join(""));
			truncated = true;
		}
	}
	if (lines.length === 0) return { lines: [], truncated: false };
	const out = lines.map((l) => (l === "" ? "  >" : "  > " + l));
	if (truncated) out.push("  > …(以下略)");
	return { lines: out, truncated };
}

// (g) → { title, url, rest } | null。title は `\` を戻した文字。空のタイトルも読む。URL は括弧の深さを数えて切る
export function parseSourceLine(line) {
	if (typeof line !== "string") return null;
	const s = line.replace(/\r?\n?$/, "");
	const head = /^[ \t]*(?:[-*+][ \t]+)?\[/.exec(s);
	if (!head) return null;
	let i = head[0].length;
	let title = "";
	for (; i < s.length && s[i] !== "]"; i++) {
		if (s[i] === "\\" && i + 1 < s.length) i++;
		title += s[i];
	}
	if (s.slice(i, i + 2) !== "](") return null;
	const start = i + 2;
	let depth = 0;
	for (let j = start; j < s.length; j++) {
		if (s[j] === "(") depth++;
		else if (s[j] === ")" && depth-- === 0) return { title, url: s.slice(start, j), rest: s.slice(j + 1) };
	}
	return null;
}
