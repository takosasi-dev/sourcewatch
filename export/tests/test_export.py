# sourcewatch_export.py の試験(AC-1〜AC-3 と FR-1〜FR-5)。合成の vault を tmp_path に作って回す。
# 拡張に写した format.js が SourceStamp の物とバイトで同じかもここで見る。
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest

import sourcewatch_export as sx

REPORTS = "レポート/調査レポート"


def make_vault(tmp_path: Path, files: dict[str, str | bytes]) -> Path:
    vault = tmp_path / "vault"
    for rel, body in files.items():
        p = vault / REPORTS / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(body, bytes):
            p.write_bytes(body)
        else:
            p.write_text(body, encoding="utf-8")
    return vault


def run(tmp_path: Path, vault: Path, *extra: str) -> tuple[int, dict[str, object], Path]:
    out = tmp_path / "list.json"
    code = sx.main(["--vault", str(vault), "--out", str(out), *extra])
    data = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    return code, data, out


def links_of(data: dict[str, object]) -> list[dict[str, object]]:
    links = data["links"]
    assert isinstance(links, list)
    return links


def reports_of(data: dict[str, object]) -> list[dict[str, object]]:
    reports = data["reports"]
    assert isinstance(reports, list)
    return reports


# --- FR-2: リンクの抜き出し ---


def test_paren_url_is_read_whole() -> None:
    assert sx.find_links("- [Rust](https://en.wikipedia.org/wiki/Rust_(programming_language))（確認）") == [
        ("Rust", "https://en.wikipedia.org/wiki/Rust_(programming_language)")
    ]


def test_empty_text_is_kept() -> None:
    assert sx.find_links("- [](https://patents.google.com/patent/X)") == [("", "https://patents.google.com/patent/X")]


def test_http_url_and_several_links_in_a_line() -> None:
    line = "見た: [A](http://a.example/x) / [B](https://b.example/) と [内部](note.md) と [[wiki]]"
    assert sx.find_links(line) == [("A", "http://a.example/x"), ("B", "https://b.example/")]


def test_escaped_title_and_escaped_bracket() -> None:
    assert sx.find_links(r"- [Array\[0\] と C:\\temp](https://x.example/a)") == [("Array[0] と C:\\temp", "https://x.example/a")]
    assert sx.find_links(r"\[not](https://x.example/a)") == []


def test_unclosed_paren_is_not_a_link() -> None:
    assert sx.find_links("[A](https://x.example/a(b") == []


def test_links_in_code_fence_are_skipped() -> None:
    lines = ["[A](https://a.example/)", "```md", "[B](https://b.example/)", "```", "[C](https://c.example/)"]
    assert sx.links_in(lines) == [(1, "A", "https://a.example/"), (5, "C", "https://c.example/")]


# --- FR-3: レポートの日付 ---


def test_frontmatter_date_in_key_order() -> None:
    lines = ["---", "作成日: 2026-09-01", 'rf_surveyed_on: "2026-09-20"', "---", "本文"]
    assert sx.report_date(lines, "x", ["rf_surveyed_on", "作成日"], True) == ("2026-09-20", "rf_surveyed_on")


def test_frontmatter_invalid_date_falls_through() -> None:
    lines = ["---", "rf_surveyed_on: 2026-02-30", "作成日: 2026-09-01T10:00", "---"]
    assert sx.report_date(lines, "2026-08-17_x", ["rf_surveyed_on", "作成日"], True) == ("2026-09-01", "作成日")


def test_filename_date() -> None:
    assert sx.report_date(["本文"], "2026-08-17_例_調査", ["作成日"], True) == ("2026-08-17", "ファイル名")
    assert sx.report_date(["本文"], "2026-08-170_x", ["作成日"], True) == (None, None)
    assert sx.report_date(["本文"], "2026-08-17_x", ["作成日"], False) == (None, None)


def test_no_date() -> None:
    assert sx.report_date(["---", "title: x", "---"], "メモ", ["rf_surveyed_on", "作成日"], True) == (None, None)
    # 閉じていない --- は frontmatter ではない
    assert sx.report_date(["---", "作成日: 2026-09-01"], "メモ", ["作成日"], True) == (None, None)


# --- 全体(FR-1・FR-4・FR-5) ---


def test_whole_run_counts_and_duplicates(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    vault = make_vault(
        tmp_path,
        {
            "OSS調査/2026-08-17_a.md": "- [A](https://a.example/x)\n- [A again](https://a.example/x)\n- [](http://b.example/)\r\n",
            "生成AI/b.md": "---\n作成日: 2026-09-01\n---\n本文 [A](https://a.example/x#frag)\n",
            "生成AI/リンク無し.md": "本文だけ\n",
            ".obsidian/hidden.md": "- [H](https://hidden.example/)\n",
            "壊れた.md": b"\xff\xfe\x00broken [Z](https://z.example/)",
        },
    )
    code, data, _ = run(tmp_path, vault)
    assert code == 0
    assert data["schema"] == "sourcewatch-list/1"
    assert data["reports_dir"] == REPORTS
    assert reports_of(data) == [
        {"path": f"{REPORTS}/OSS調査/2026-08-17_a.md", "date": "2026-08-17", "date_source": "ファイル名"},
        {"path": f"{REPORTS}/生成AI/b.md", "date": "2026-09-01", "date_source": "作成日"},
    ]
    assert links_of(data)[2] == {"url": "http://b.example/", "report": 0, "line": 3, "text": ""}
    assert links_of(data)[3] == {"url": "https://a.example/x#frag", "report": 1, "line": 4, "text": "A"}
    # URL は書かれたまま数える(フラグメント違いは拡張でまとめる)
    assert data["stats"] == {"files_scanned": 3, "files_with_links": 2, "links": 4, "urls": 3, "hosts": 2}
    captured = capsys.readouterr()
    assert "壊れた.md" in captured.err
    # AC-4: 標準出力の件数と stats が一致する
    stats = data["stats"]
    assert isinstance(stats, dict)
    for key, value in stats.items():
        assert f"{key}: {value}\n" in captured.out
    assert "  a.example 2\n" in captured.out  # 上位ホストは URL の数
    assert "  ファイル名 1\n" in captured.out and "  作成日 1\n" in captured.out and "  無し 0\n" in captured.out


def test_no_filename_date_option(tmp_path: Path) -> None:
    vault = make_vault(tmp_path, {"2026-08-17_a.md": "[A](https://a.example/)\n"})
    _, data, _ = run(tmp_path, vault, "--no-filename-date")
    assert reports_of(data)[0]["date"] is None and reports_of(data)[0]["date_source"] is None


def test_out_inside_vault_is_refused(tmp_path: Path) -> None:
    vault = make_vault(tmp_path, {"a.md": "[A](https://a.example/)\n"})
    out = vault / "sub" / "list.json"
    (vault / "sub").mkdir()
    assert sx.main(["--vault", str(vault), "--out", str(out)]) == 1
    assert not out.exists()
    # 大文字小文字を変えても vault の中とみなす(Windows。Linux ではパスの大文字小文字が別物なので見ない)
    if os.name == "nt":
        assert sx.main(["--vault", str(vault), "--out", str(vault).upper() + "\\list.json"]) == 1


def test_out_inside_real_vault_found_by_dot_obsidian_is_refused(tmp_path: Path) -> None:
    # --vault に本物の vault の下のフォルダを渡しても、--out の親に .obsidian のあるフォルダがあれば書かない
    real = tmp_path / "real_vault"
    (real / ".obsidian").mkdir(parents=True)
    vault = make_vault(real, {"a.md": "[A](https://a.example/)\n"})
    out = real / "list.json"
    assert sx.main(["--vault", str(vault), "--out", str(out)]) == 1
    assert not out.exists()


def test_argument_errors_exit_1(tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as e:
        sx.main(["--out", str(tmp_path / "x.json")])
    assert e.value.code == 1
    assert sx.main(["--vault", str(tmp_path / "無い"), "--out", str(tmp_path / "x.json")]) == 1
    vault = make_vault(tmp_path, {"a.md": ""})
    assert sx.main(["--vault", str(vault), "--out", str(tmp_path / "x.json"), "--reports-dir", "../.."]) == 1


def test_write_failure_exits_2(tmp_path: Path) -> None:
    vault = make_vault(tmp_path, {"a.md": "[A](https://a.example/)\n"})
    assert sx.main(["--vault", str(vault), "--out", str(tmp_path / "無いフォルダ" / "x.json")]) == 2


def test_format_js_is_a_byte_copy_of_sourcestamp() -> None:
    copy = Path(__file__).resolve().parents[2] / "extension" / "lib" / "format.js"
    assert hashlib.sha256(copy.read_bytes()).hexdigest() == "86e9f95b597b0311f24308584e104f482c70f8c6893dac5477c93221f05fe6f0"
