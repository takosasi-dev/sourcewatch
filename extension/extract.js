// ページの中で走る関数(scripting.executeScript の func)。本文全体・主な部分・見出しの文字とタイトルを返すだけ。
// script・style・入力欄・contenteditable などの中は辿らない(D-8・INV-3)。保存も通信もしない。
// 注入のため、この関数の外の物を参照しない。試験では doc に別の文書を渡す。
export function extractPage(doc = document) {
	const SKIP = ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "INPUT", "TEXTAREA", "SELECT", "OPTION"];
	// テキストノードを文書順に sep でつなぐ(§9.6)。1 = 要素、4 = テキスト。受け入れ 1・子ごと捨てる 2・子だけ見る 3
	const textOf = (root, sep = "\n") => {
		if (!root) return "";
		const parts = [];
		const walker = doc.createTreeWalker(root, 1 | 4, {
			acceptNode: (n) => (n.nodeType === 3 ? 1 : SKIP.includes(n.nodeName.toUpperCase()) || n.isContentEditable ? 2 : 3),
		});
		for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.data);
		return parts.join(sep);
	};
	const main = doc.querySelector("main") || doc.querySelector("article") || doc.querySelector('[role="main"]') || doc.body;
	// 見出しの中も本文と同じ除外をかける(textContent だと中の入力欄・script を読む。INV-3)。見出しの中は textContent と同じく区切りなし
	const headings = Array.from(doc.querySelectorAll("h1, h2, h3"))
		.filter((h) => !h.isContentEditable)
		.map((h) => textOf(h, ""))
		.join("\n");
	return { title: doc.title, body: textOf(doc.body), main: textOf(main), headings };
}
