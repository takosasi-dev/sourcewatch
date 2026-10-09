// service worker: 一覧の URL だけアクションを有効にする declarativeContent の規則を、入れた時と一覧が変わった時に作り直す(FR-7)。
// タブが読み込みを始めたらそのタブのバッジを消す(D-16)。ページの中身も URL も受け取らない(案 A)。
import { KEY_LIST, getList, ruleUrls } from "./lib/store.js";

const rules = chrome.declarativeContent.onPageChanged;
const call = (method, ...args) =>
	new Promise((resolve, reject) =>
		rules[method](...args, (r) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(r))),
	);

// 作り直しは 1 回ずつ順に行う(重なると「消す → 消す → 足す → 足す」になり、古い一覧の規則が残る)。前の回の失敗で鎖を止めない
let queue = Promise.resolve();
const rebuildRules = () => (queue = queue.catch(() => {}).then(rebuild));

async function rebuild() {
	const t0 = performance.now();
	const urls = ruleUrls(await getList());
	try {
		await call("removeRules", undefined);
		if (urls.length) {
			const conditions = urls.map((u) => new chrome.declarativeContent.PageStateMatcher({ pageUrl: { urlEquals: u } }));
			await call("addRules", [{ conditions, actions: [new chrome.declarativeContent.ShowAction()] }]);
		}
		console.log(`SourceWatch: 規則の条件 ${urls.length} 個を ${Math.round(performance.now() - t0)} ms で登録した`); // §8.4 DC_REGISTER
	} catch (e) {
		console.error(`SourceWatch: 規則を登録できなかった(条件 ${urls.length} 個): ${e.message}`);
	}
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
	chrome.action.disable(); // 既定は無効。規則に合うページだけ ShowAction で有効になる
	await rebuildRules();
	if (reason === "install" && !(await getList())) chrome.runtime.openOptionsPage(); // §10: 読み込みを促す
});

chrome.runtime.onStartup.addListener(() => chrome.action.disable());

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && KEY_LIST in changes) rebuildRules();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
	if (info.status === "loading") chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {}); // 閉じたタブなど
});
