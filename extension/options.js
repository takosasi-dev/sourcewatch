// オプションページの処理: 一覧 JSON を検証して保存し件数と差を出す(FR-6)、指紋の設定(FR-14)、数えの表示(FR-16)、
// 記録の書き出し・読み戻し・一覧に無い記録の削除(FR-19・§10)。形が違う JSON では何も書き換えない。
// 読み込みと読み戻しの関数は export して、窓なしの確認からも呼べるようにしている。
import { FP_IDS, FP_LABEL } from "./lib/normalize.js";
import {
	KEY_LIST,
	KEY_SETTINGS,
	REC_PREFIX,
	diffKeys,
	exportRecords,
	getList,
	getSettings,
	getStats,
	listFromJson,
	orphanKeys,
	recordsFromJson,
} from "./lib/store.js";

const $ = (id) => document.getElementById(id);
function el(tag, text, cls) {
	const e = document.createElement(tag);
	if (text != null) e.textContent = text;
	if (cls) e.className = cls;
	return e;
}
function fillDl(dl, rows) {
	dl.replaceChildren(...rows.flatMap(([k, v]) => [el("dt", k), el("dd", String(v))]));
}
const localTime = (iso) => (iso ? new Date(iso).toLocaleString("ja-JP") : "—");
const parse = (text) => {
	try {
		return { ok: true, obj: JSON.parse(text) };
	} catch (e) {
		return { ok: false, error: `JSON として読めません(${e.message})` };
	}
};

// FR-6: 形を検証し、通れば保存する。通らなければ前の一覧を残す
export async function importListText(text, fileName) {
	const p = parse(text);
	if (!p.ok) return p;
	const r = listFromJson(p.obj, fileName);
	if (!r.ok) return r;
	const prev = await getList();
	try {
		await chrome.storage.local.set({ [KEY_LIST]: r.list });
	} catch (e) {
		return { ok: false, error: `保存できませんでした(${e.message})` };
	}
	return { ...r, diff: diffKeys(prev, r.list), hadPrev: prev !== null };
}

// FR-19: 書き出した JSON を読み戻す。形が違えば何も書かない
export async function restoreRecordsText(text) {
	const p = parse(text);
	if (!p.ok) return p;
	const r = recordsFromJson(p.obj);
	if (!r.ok) return r;
	await chrome.storage.local.set(r.items);
	return r;
}

export async function exportRecordsText() {
	return JSON.stringify(await exportRecords(), null, 2) + "\n";
}

function importMessage(name, r) {
	if (!r.ok) return [el("p", `読み込めなかった: ${r.error}。前の一覧はそのまま。`, "warn")];
	const { info, diff } = r;
	const s = info.stats ?? {};
	const out = [
		el("p", `読み込んだ: ${name}。URL ${info.urls}・リンク ${info.links}(JSON の stats は URL ${s.urls ?? "?"}・リンク ${s.links ?? "?"})`, "ok"),
		el("p", `照合に使う URL は ${info.keys}(フラグメントなどを外してまとめた数)`, "muted"),
	];
	if (info.skipped) out.push(el("p", `URL として読めないリンク ${info.skipped} 件は飛ばした`, "warn"));
	if (r.hadPrev) out.push(el("p", `前の一覧から 増えた URL ${diff.added}・消えた URL ${diff.removed}(消えた URL の記録は残す)`));
	return out;
}

async function refresh() {
	const all = await chrome.storage.local.get(null);
	const list = all[KEY_LIST] ?? null;
	fillDl(
		$("listInfo"),
		list
			? [
					["ファイル", list.fileName || "—"],
					["書き出した日時", localTime(list.generatedAt)],
					["読み込んだ日時", localTime(list.importedAt)],
					["レポート", `${list.reports.length} 本`],
					["照合に使う URL", `${Object.keys(list.urls).length} 個`],
				]
			: [["一覧", "まだ読み込んでいない。読み込むまでアイコンは全部灰色"]],
	);
	$("fp").value = (await getSettings()).fp;
	const stats = await getStats();
	fillDl($("stats"), [
		["popup を開いた", `${stats.popup} 回`],
		["判定した", `${stats.judged} 回`],
		["「変わった」と出た", `${stats.changed} 回`],
	]);
	const hosts = Object.entries(stats.byHost).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	$("hosts").replaceChildren(
		...hosts.slice(0, 20).map(([h, n]) => {
			const tr = el("tr");
			tr.append(el("td", h), el("td", `${n} 回`));
			return tr;
		}),
	);
	const recKeys = Object.keys(all).filter((k) => k.startsWith(REC_PREFIX));
	const orphans = orphanKeys(all, list);
	fillDl($("recInfo"), [
		["記録のある URL", `${recKeys.length} 個`],
		["一覧に無い記録", `${orphans.length} 個`],
	]);
	$("orphanBtn").disabled = orphans.length === 0;
}

function setupFp() {
	$("fp").replaceChildren(...FP_IDS.map((k) => Object.assign(el("option", FP_LABEL[k]), { value: k })));
	$("fp").addEventListener("change", async () => {
		await chrome.storage.local.set({ [KEY_SETTINGS]: { fp: $("fp").value } });
		$("fpMsg").textContent = "保存した";
	});
}

$("listFile").addEventListener("change", async (ev) => {
	const file = ev.target.files[0];
	if (!file) return;
	const r = await importListText(await file.text(), file.name);
	$("listMsg").replaceChildren(...importMessage(file.name, r));
	ev.target.value = "";
	await refresh();
});

$("exportBtn").addEventListener("click", async () => {
	const url = URL.createObjectURL(new Blob([await exportRecordsText()], { type: "application/json" }));
	const a = el("a");
	a.href = url;
	a.download = `sourcewatch_records_${new Date().toLocaleDateString("sv-SE")}.json`;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 10000);
	$("recMsg").replaceChildren(el("p", "書き出した(ダウンロードのフォルダ)", "ok"));
});

$("restoreFile").addEventListener("change", async (ev) => {
	const file = ev.target.files[0];
	if (!file) return;
	const r = await restoreRecordsText(await file.text());
	$("recMsg").replaceChildren(
		r.ok ? el("p", `読み戻した: 記録 ${r.records} 個(同じ URL の記録は上書き)`, "ok") : el("p", `読み戻せなかった: ${r.error}。何も変えていない。`, "warn"),
	);
	ev.target.value = "";
	await refresh();
});

$("orphanBtn").addEventListener("click", async () => {
	const all = await chrome.storage.local.get(null);
	const keys = orphanKeys(all, all[KEY_LIST]);
	if (!keys.length || !confirm(`一覧に無い記録 ${keys.length} 個を消します。よいですか`)) return;
	await chrome.storage.local.remove(keys);
	$("recMsg").replaceChildren(el("p", `消した: ${keys.length} 個`, "ok"));
	await refresh();
});

setupFp();
refresh();
chrome.storage.onChanged.addListener(() => refresh()); // popup で数えが増えたら出し直す
