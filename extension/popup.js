// popup: 押したタブの URL を一覧で引き当てて引いているレポートを出し、本文を読んで基準と比べ、表示・保存・バッジを付ける(FR-8〜FR-13・FR-16)。
// 一覧に無いページでは本文を読まず、何も保存しない(INV-2)。基準は「確認した」でしか上書きしない(INV-6)。
// DOM には textContent だけで入れる。ページから読んだ文字は信頼しないデータとして扱う(INV-4)。
import { extractPage } from "./extract.js";
import { FP_IDS, FP_SCOPE, judge, snapshot } from "./lib/normalize.js";
import { KEY_STATS, REC_PREFIX, getList, getRecord, getSettings, getStats, lookup, reportRows } from "./lib/store.js";

const $ = (id) => document.getElementById(id);
function el(tag, text, cls) {
	const e = document.createElement(tag);
	if (text != null) e.textContent = text;
	if (cls) e.className = cls;
	return e;
}
const day = (at) => (at ? at.slice(0, 10) : "?");
const SCOPE_NAME = { body: "本文全体", main: "主な部分", headings: "見出し" };
const WORD = { changed: "変わった", same: "変わっていない" };
// §9.5 のバッジ: 変わった ! 赤系 / 変わっていない = 灰 / 初めて + 青系 / 判定できない ? 灰
const BADGE = { changed: ["!", "#c0392b"], same: ["=", "#7f8c8d"], first: ["+", "#2471a3"], unknown: ["?", "#7f8c8d"] };

function badge(tabId, kind) {
	const [text, color] = BADGE[kind];
	chrome.action.setBadgeText({ tabId, text }).catch(() => {});
	chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

async function save(items) {
	try {
		await chrome.storage.local.set(items);
		return true;
	} catch (e) {
		$("msg").append(el("div", `保存できなかった(${e.message})。表示は続ける`, "warn")); // §10
		return false;
	}
}

function hostOf(url) {
	try {
		return new URL(url).hostname || "(file)";
	} catch {
		return "(読めない)";
	}
}

function renderReports(rows) {
	const box = $("reports");
	box.append(el("h1", `このページは調査レポート ${rows.length} 本で引いている`));
	const table = el("table");
	for (const r of rows) {
		const tr = el("tr");
		tr.append(el("td", r.shortPath, "path"), el("td", r.date ? `${r.date}(${r.dateSource})` : "日付不明", "date"), el("td", `${r.count} か所`, "count"));
		table.append(tr);
	}
	box.append(table);
}

function renderDetail(base, snap, v) {
	const dl = $("detailBody");
	dl.replaceChildren();
	const row = (k, val) => dl.append(el("dt", k), el("dd", val));
	if (v.eq) row("指紋", FP_IDS.map((k) => `${k} ${v.eq[k] ? "=" : "≠"}`).join("  "));
	for (const s of ["body", "main", "headings"]) row(`${SCOPE_NAME[s]}の文字数`, base ? `${base.len[s]} → ${snap.len[s]}` : String(snap.len[s]));
	if (base) row("基準の抜粋", base.excerpt || "(空)");
	row("今の抜粋", snap.excerpt || "(空)");
	$("detail").hidden = false;
}

// 判定の表示。state = { tabId, key, rec, prevLast, snap, fp, rows, v }
function render(state) {
	const { rec, prevLast, snap, fp, rows, v } = state;
	const box = $("verdict");
	box.replaceChildren();
	if (v.kind === "unknown") {
		const why = snap && snap.len.body > 0 ? `${SCOPE_NAME[FP_SCOPE[fp]]}が空` : "本文を読めない・空・PDF などのページ";
		box.append(el("div", `判定(${fp}): 判定できない(${why})`, "verdict"));
		return;
	}
	if (v.kind === "first") {
		const oldest = rows[0];
		box.append(el("div", `判定: 前回の記録なし。今(${day(snap.at)})を基準にする`, "verdict first"));
		const written = oldest?.date ? `${oldest.date}・${oldest.dateSource}` : "日付不明";
		box.append(el("div", `レポートを書いた日(${written})のページの中身は分からない`, "sub"));
		renderDetail(null, snap, v);
		return;
	}
	const line = el("div", "", "verdict");
	const h = snap.len.headings === 0 ? "見出しなし" : v.eq.F5 ? "同じ" : "変わった";
	line.append(el("span", `判定(${fp}): ${WORD[v.kind]}`, v.kind), el("span", `    見出し(F5): ${h}`));
	box.append(line);
	box.append(el("div", `基準 ${day(rec.base.at)} / 最後に見た日 ${day(prevLast?.at)}`, "sub"));
	const btn = el("button", "確認した(今を新しい基準にする)");
	btn.addEventListener("click", async () => {
		const next = { ...rec, base: snap, last: snap };
		if (await save({ [REC_PREFIX + state.key]: next })) {
			state.rec = next;
			state.v = judge(next.base, snap, fp);
			render(state);
			badge(state.tabId, state.v.kind);
			$("msg").replaceChildren(el("div", `基準を今(${snap.at})にした`, "sub"));
		}
	});
	box.append(btn);
	renderDetail(rec.base, snap, v);
}

async function main() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	const list = await getList();
	if (!list) {
		$("verdict").append(el("div", "一覧がまだ読み込まれていない。"));
		const btn = el("button", "オプションページで読み込む");
		btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
		$("verdict").append(btn);
		return;
	}
	const hit = tab?.url ? lookup(list, tab.url) : null;
	if (!hit) {
		$("verdict").append(el("div", "このページは一覧に無い。本文は読まない。"));
		return;
	}
	const rows = reportRows(list, hit.entries);
	renderReports(rows);

	const stats = await getStats();
	const host = hostOf(tab.url);
	stats.popup++;
	stats.byHost[host] = (stats.byHost[host] ?? 0) + 1;

	let snap = null;
	try {
		const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage });
		if (r?.result) snap = await snapshot(r.result);
	} catch {
		// chrome:// ・ウェブストア・PDF など。判定できない(INV-7・Q-13)
	}
	const { fp } = await getSettings();
	const rec = await getRecord(hit.key);
	const v = judge(rec?.base, snap, fp);
	const state = { tabId: tab.id, key: hit.key, rec, prevLast: rec?.last ?? null, snap, fp, rows, v };
	const items = { [KEY_STATS]: stats };
	if (v.kind !== "unknown") {
		stats.judged++;
		if (v.kind === "changed") stats.changed++;
		state.rec = { ...rec, base: rec?.base ?? snap, last: snap }; // 基準は初めてのときだけ作る(INV-6)。最後に見た日は毎回(D-10)
		items[REC_PREFIX + hit.key] = state.rec;
	}
	await save(items);
	badge(tab.id, v.kind);
	render(state);
}

main().catch((e) => $("msg").append(el("div", `うまく動かなかった: ${e.message}`, "warn")));
