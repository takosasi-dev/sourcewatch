// chrome.storage.local の読み書き(§9.4 のキー)と、一覧 JSON(§9.2)・記録 JSON(FR-19)の検証と変換。
// 一覧の引き当て(lookup)と、declarativeContent に渡す URL(ruleUrls)もここで作る。
// chrome.* は関数の中でだけ触るので、tests.html から純関数として読み込める。
import { FP_IDS, canonicalUrl, urlKey, urlVariants } from "./normalize.js";

export const LIST_SCHEMA = "sourcewatch-list/1";
export const RECORDS_SCHEMA = "sourcewatch-records/1";
export const KEY_LIST = "sw:list";
export const KEY_SETTINGS = "sw:settings";
export const KEY_STATS = "sw:stats";
export const REC_PREFIX = "sw:rec:";
export const DEFAULT_FP = "F4"; // §8.5 {{DEFAULT_FP}} の仮決め(NOTES.md の仮決め一覧)。実測で決まったらここだけ変える

const local = () => chrome.storage.local;
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStrOrNull = (x) => x === null || typeof x === "string";
const count = (x) => (Number.isInteger(x) && x >= 0 ? x : 0);
const fail = (error) => ({ ok: false, error });

export async function getList() {
	return (await local().get(KEY_LIST))[KEY_LIST] ?? null;
}

export async function getSettings() {
	const s = (await local().get(KEY_SETTINGS))[KEY_SETTINGS];
	return { fp: FP_IDS.includes(s?.fp) ? s.fp : DEFAULT_FP };
}

export function normStats(s) {
	const byHost = {};
	if (isObj(s?.byHost)) for (const [h, n] of Object.entries(s.byHost)) byHost[h] = count(n);
	return { popup: count(s?.popup), judged: count(s?.judged), changed: count(s?.changed), byHost };
}

export async function getStats() {
	return normStats((await local().get(KEY_STATS))[KEY_STATS]);
}

export async function getRecord(key) {
	return (await local().get(REC_PREFIX + key))[REC_PREFIX + key] ?? null;
}

// 一覧 JSON(§9.2)→ sw:list の形。形が違えば { ok: false, error }(FR-6)。URL として読めないリンクは数えて飛ばす
export function listFromJson(obj, fileName = "", now = new Date()) {
	if (!isObj(obj)) return fail("JSON のいちばん外がオブジェクトではありません");
	if (obj.schema !== LIST_SCHEMA) return fail(`schema が ${LIST_SCHEMA} ではありません(${JSON.stringify(obj.schema) ?? "無し"})`);
	if (!Array.isArray(obj.reports) || !Array.isArray(obj.links)) return fail("reports か links が配列ではありません");
	const reports = [];
	for (const [i, r] of obj.reports.entries()) {
		if (!isObj(r) || typeof r.path !== "string" || !isStrOrNull(r.date) || !isStrOrNull(r.date_source)) {
			return fail(`reports[${i}] の形が違います`);
		}
		reports.push([r.path, r.date, r.date_source]);
	}
	const urls = {};
	const raw = new Set();
	let skipped = 0;
	for (const [i, l] of obj.links.entries()) {
		const okReport = Number.isInteger(l?.report) && l.report >= 0 && l.report < reports.length;
		if (!isObj(l) || typeof l.url !== "string" || !okReport || !Number.isInteger(l.line) || typeof l.text !== "string") {
			return fail(`links[${i}] の形が違います`);
		}
		raw.add(l.url);
		const k = urlKey(l.url);
		if (k === null) {
			skipped++;
			continue;
		}
		(urls[k] ??= []).push([l.report, l.line, l.text]);
	}
	const list = {
		schema: LIST_SCHEMA,
		importedAt: now.toISOString(),
		fileName,
		generatedAt: typeof obj.generated_at === "string" ? obj.generated_at : null,
		reportsDir: typeof obj.reports_dir === "string" ? obj.reports_dir : "",
		reports,
		urls,
	};
	return { ok: true, list, info: { links: obj.links.length, urls: raw.size, keys: Object.keys(urls).length, skipped, stats: obj.stats } };
}

// 前の一覧からの差(FR-6)
export function diffKeys(prev, next) {
	const a = new Set(Object.keys(prev?.urls ?? {}));
	const b = Object.keys(next.urls);
	return { added: b.filter((k) => !a.has(k)).length, removed: [...a].filter((k) => !Object.hasOwn(next.urls, k)).length };
}

// タブの URL を一覧で引き当てる。末尾の / の有無の 2 通りを見る(D-12)。→ { key, entries } | null
export function lookup(list, url) {
	const c = canonicalUrl(url);
	if (!list || c === null) return null;
	for (const v of urlVariants(c)) {
		const k = urlKey(v);
		if (k !== null && Object.hasOwn(list.urls, k)) return { key: k, entries: list.urls[k] };
	}
	return null;
}

// declarativeContent の urlEquals に渡す URL(D-12: 末尾の / の有無の 2 通り)
// ponytail: 一覧の URL に utm_* が付いていると、外した形だけを登録するので、付いたまま開いたページには色が付かない(2026-10-06 の実 vault で 0 件)
export function ruleUrls(list) {
	return [...new Set(Object.keys(list?.urls ?? {}).flatMap(urlVariants))];
}

// popup に出すレポートの行(FR-8)。日付の古い順、日付不明は最後
export function reportRows(list, entries) {
	const byReport = new Map();
	for (const [idx] of entries) byReport.set(idx, (byReport.get(idx) ?? 0) + 1);
	const prefix = list.reportsDir ? list.reportsDir.replace(/\/?$/, "/") : "";
	return [...byReport]
		.map(([idx, n]) => {
			const [path, date, dateSource] = list.reports[idx];
			return { path, shortPath: path.startsWith(prefix) ? path.slice(prefix.length) : path, date, dateSource, count: n };
		})
		.sort((x, y) => (x.date ?? "9999").localeCompare(y.date ?? "9999") || x.path.localeCompare(y.path));
}

// 記録の書き出し(FR-19)。記録・設定・数えを 1 つの JSON にする。一覧は書き出さない(書き出しスクリプトで作り直せる)
export async function exportRecords(now = new Date()) {
	const all = await local().get(null);
	const records = {};
	for (const [k, v] of Object.entries(all)) if (k.startsWith(REC_PREFIX)) records[k.slice(REC_PREFIX.length)] = v;
	return { schema: RECORDS_SCHEMA, exportedAt: now.toISOString(), records, settings: all[KEY_SETTINGS] ?? null, stats: all[KEY_STATS] ?? null };
}

const within = (s, n) => typeof s === "string" && Array.from(s).length <= n;
const isSnap = (s) =>
	isObj(s) &&
	typeof s.at === "string" &&
	isObj(s.f) &&
	FP_IDS.every((k) => typeof s.f[k] === "string") &&
	isObj(s.len) &&
	["body", "main", "headings"].every((k) => Number.isInteger(s.len[k])) &&
	within(s.title, 120) &&
	within(s.excerpt, 160);
const isRecord = (r) => isObj(r) && isSnap(r.base) && isSnap(r.last) && (r.sel === undefined || within(r.sel, 300));

// 書き出した JSON → storage に set する項目。形が違えば何も入れずに { ok: false }(INV-10 の長さも見る)
export function recordsFromJson(obj) {
	if (!isObj(obj) || obj.schema !== RECORDS_SCHEMA || !isObj(obj.records)) return fail(`schema が ${RECORDS_SCHEMA} の記録ではありません`);
	const items = {};
	for (const [url, rec] of Object.entries(obj.records)) {
		if (urlKey(url) !== url || !isRecord(rec)) return fail(`記録 ${url} の形が違います`);
		items[REC_PREFIX + url] = rec;
	}
	const records = Object.keys(items).length;
	if (obj.settings != null) {
		if (!FP_IDS.includes(obj.settings?.fp)) return fail("settings の形が違います");
		items[KEY_SETTINGS] = { fp: obj.settings.fp };
	}
	if (obj.stats != null) items[KEY_STATS] = normStats(obj.stats);
	return { ok: true, items, records };
}

// 一覧に無い記録の storage のキー(§10)
export function orphanKeys(all, list) {
	return Object.keys(all).filter((k) => k.startsWith(REC_PREFIX) && !Object.hasOwn(list?.urls ?? {}, k.slice(REC_PREFIX.length)));
}
