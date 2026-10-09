# 調査レポートの md から [文字](http…) のリンクを抜き出し、SourceWatch の一覧 JSON(仕様書 §9.2)を書く。
# vault は読むだけで、読むのは --reports-dir 以下の md だけ(INV-8)。標準ライブラリだけ。
# リンクの文字と URL の切り方は SourceStamp 仕様書 §9.1 (g)(format.js の parseSourceLine)と同じ。
from __future__ import annotations

import argparse
import collections
import datetime as dt
import io
import json
import os
import re
import sys
from pathlib import Path
from typing import NoReturn
from urllib.parse import urlsplit

SCHEMA = "sourcewatch-list/1"
DEFAULT_REPORTS_DIR = "レポート/調査レポート"
DEFAULT_DATE_KEYS = "rf_surveyed_on,作成日"  # Q-15: ReportAge の dateKeys が決まったら揃える
FILENAME_LABEL = "ファイル名"
NO_DATE_LABEL = "無し"
# ReportAge FR-2: 先頭が YYYY-MM-DD で、直後が数字でない物(2026-08-170 は採らない)
DATE_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})(?!\d)")
KEY_RE = re.compile(r"([^\s#:][^:]*):(.*)$")


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:  # 引数の誤りは終了コード 1(§9.1)
        self.print_usage(sys.stderr)
        print(f"{self.prog}: エラー: {message}", file=sys.stderr)
        raise SystemExit(1)


def parse_link_at(s: str, start: int) -> tuple[str, str, int] | None:
    """s[start] の `[` から (文字, URL, 閉じ括弧の次の位置) を読む。§9.1 (g): `\\`+1 文字は戻し、URL は括弧の深さで切る。"""
    i = start + 1
    text: list[str] = []
    while i < len(s) and s[i] != "]":
        if s[i] == "\\" and i + 1 < len(s):
            i += 1
        text.append(s[i])
        i += 1
    if not s.startswith("](", i):
        return None
    begin = i + 2
    depth = 0
    for k in range(begin, len(s)):
        if s[k] == "(":
            depth += 1
        elif s[k] == ")":
            if depth == 0:
                return "".join(text), s[begin:k], k + 1
            depth -= 1
    return None


def find_links(line: str) -> list[tuple[str, str]]:
    """1 行から http(s) の [文字](URL) を左から順に拾う。`\\[` はリンクの始まりにしない。"""
    found: list[tuple[str, str]] = []
    i = 0
    while i < len(line):
        c = line[i]
        if c == "\\":
            i += 2
            continue
        if c == "[":
            hit = parse_link_at(line, i)
            if hit is not None and hit[1].startswith(("http://", "https://")):
                found.append((hit[0], hit[1]))
                i = hit[2]
                continue
        i += 1
    return found


def links_in(lines: list[str]) -> list[tuple[int, str, str]]:
    """(行番号, 文字, URL)。``` で囲んだ中(囲みの行も)は除く。"""
    out: list[tuple[int, str, str]] = []
    in_fence = False
    for no, line in enumerate(lines, 1):
        if line.lstrip().startswith("```"):  # ponytail: ~~~ や長さ違いの囲みは見ない。仕様書 FR-2 は ``` だけ
            in_fence = not in_fence
            continue
        if not in_fence:
            out.extend((no, text, url) for text, url in find_links(line))
    return out


def frontmatter(lines: list[str]) -> dict[str, str]:
    """先頭の --- から次の --- までの、字下げの無い `キー: 値` を文字のまま読む(最初に出た物が勝つ)。"""
    if not lines or lines[0].strip() != "---":
        return {}
    out: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() in ("---", "..."):
            return out
        m = KEY_RE.match(line)
        if m:
            out.setdefault(m.group(1).strip(), m.group(2).strip())
    return {}  # 閉じていなければ frontmatter ではない


def valid_date(s: str) -> str | None:
    """先頭が実在する YYYY-MM-DD ならその 10 文字。引用符は外す。"""
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        s = s[1:-1].strip()
    m = DATE_RE.match(s)
    if not m:
        return None
    try:
        dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None
    return m.group(0)


def report_date(lines: list[str], stem: str, keys: list[str], use_filename: bool) -> tuple[str | None, str | None]:
    """ReportAge D-9 の順: frontmatter のキー → ファイル名の先頭の日付。→ (日付, 出典ラベル)"""
    fm = frontmatter(lines)
    for key in keys:
        if key in fm:
            d = valid_date(fm[key])
            if d:
                return d, key
    if use_filename:
        d = valid_date(stem)
        if d:
            return d, FILENAME_LABEL
    return None, None


def is_inside(path: Path, root: Path) -> bool:
    p, r = os.path.normcase(str(path)), os.path.normcase(str(root))
    try:
        return os.path.commonpath([p, r]) == r
    except ValueError:  # ドライブが違う
        return False


def iter_md(root: Path) -> list[Path]:
    """root 以下の .md を名前順に。ドット始まりのフォルダは辿らない(FR-1)。"""
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        files.extend(Path(dirpath, f) for f in sorted(filenames) if f.lower().endswith(".md"))
    return files


def host_of(url: str) -> str | None:
    try:
        return urlsplit(url).hostname
    except ValueError:
        return None


def build(vault: Path, reports_root: Path, reports_dir: str, keys: list[str], use_filename: bool) -> tuple[dict[str, object], list[str]]:
    """一覧 JSON の中身と、読めなかった md の一覧を返す。"""
    reports: list[dict[str, str | None]] = []
    links: list[dict[str, object]] = []
    skipped: list[str] = []
    scanned = 0
    for path in iter_md(reports_root):
        rel = path.relative_to(vault).as_posix()
        try:
            text = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError) as e:
            skipped.append(f"{rel}: {e.__class__.__name__}")
            continue
        scanned += 1
        lines = [line.rstrip("\r") for line in text.split("\n")]
        found = links_in(lines)
        if not found:
            continue
        date, source = report_date(lines, path.stem, keys, use_filename)
        reports.append({"path": rel, "date": date, "date_source": source})
        idx = len(reports) - 1
        links.extend({"url": url, "report": idx, "line": no, "text": t} for no, t, url in found)
    urls = {str(link["url"]) for link in links}
    hosts = {h for h in map(host_of, urls) if h}
    data: dict[str, object] = {
        "schema": SCHEMA,
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "reports_dir": reports_dir,
        "reports": reports,
        "links": links,
        "stats": {
            "files_scanned": scanned,
            "files_with_links": len(reports),
            "links": len(links),
            "urls": len(urls),
            "hosts": len(hosts),
        },
    }
    return data, skipped


def summary(data: dict[str, object], keys: list[str], skipped: int, out: Path) -> str:
    """FR-4 の件数。上位ホストは重複を除いた URL の数(仕様書 §1 の数え方)。日付の出典はリンクを持つレポートで数える。"""
    stats = data["stats"]
    links = data["links"]
    reports = data["reports"]
    assert isinstance(stats, dict) and isinstance(links, list) and isinstance(reports, list)
    rows = [f"{k}: {v}" for k, v in stats.items()]
    rows.append(f"unreadable_md: {skipped}")
    rows.append("top_hosts(URL の数):")
    by_host = collections.Counter(host_of(u) or "(読めない)" for u in {str(link["url"]) for link in links})
    rows.extend(f"  {h} {n}" for h, n in by_host.most_common(10))
    rows.append("date_sources(リンクを持つレポートの数):")
    by_source = collections.Counter(r["date_source"] or NO_DATE_LABEL for r in reports)
    for label in [*keys, FILENAME_LABEL, NO_DATE_LABEL]:
        rows.append(f"  {label} {by_source.get(label, 0)}")
    rows.append(f"out: {out}")
    return "\n".join(rows)


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(errors="backslashreplace")  # cp932 の窓でも落ちない
    parser = _Parser(prog="sourcewatch_export.py", description="SourceWatch の一覧 JSON を書き出す(vault は読むだけ)")
    parser.add_argument("--vault", required=True, help="vault の根")
    parser.add_argument("--out", required=True, help="JSON の出力先(vault の外)")
    parser.add_argument("--reports-dir", default=DEFAULT_REPORTS_DIR, help="vault の根からの相対パス")
    parser.add_argument("--date-keys", default=DEFAULT_DATE_KEYS, help="frontmatter のキーを見る順(カンマ区切り)")
    parser.add_argument("--no-filename-date", action="store_true", help="ファイル名の日付を使わない")
    args = parser.parse_args(argv)

    vault = Path(args.vault)
    if not vault.is_dir():
        print(f"エラー: vault がありません: {vault}", file=sys.stderr)
        return 1
    vault = vault.resolve()
    out = Path(args.out).resolve()
    # --vault に vault の下のフォルダを渡されても、--out の親に .obsidian のあるフォルダ(vault の根)があれば書かない(INV-8)
    if is_inside(out, vault) or any((d / ".obsidian").is_dir() for d in out.parents):
        print(f"エラー: --out が vault の中です。vault の外を指してください: {out}", file=sys.stderr)
        return 1
    reports_root = (vault / args.reports_dir).resolve()
    if not is_inside(reports_root, vault) or not reports_root.is_dir():
        print(f"エラー: --reports-dir が vault の中のフォルダではありません: {args.reports_dir}", file=sys.stderr)
        return 1
    keys = [k.strip() for k in args.date_keys.split(",") if k.strip()]

    data, skipped = build(vault, reports_root, args.reports_dir, keys, not args.no_filename_date)
    for s in skipped:
        print(f"読めない md を飛ばした: {s}", file=sys.stderr)
    try:
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    except OSError as e:
        print(f"エラー: 書けません: {out}: {e}", file=sys.stderr)
        return 2
    print(summary(data, keys, len(skipped), out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
