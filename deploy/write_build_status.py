#!/usr/bin/env python3
"""AGOBOT Web のビルド状態を JSON に書き出す（deploy-web.sh から呼ばれる）。

実行中の Web サーバー（旧リリース）がこのファイルを読み、ビルド中の PR 番号を
全ページ共通バナーと /status に表示する。書き込みは一時ファイル + rename で
原子的に行い、読み手が書きかけの JSON を掴まないようにする。

使い方:
  write_build_status.py --path /srv/supabase-data/agobot-web/build-status.json \
      --repo ~/BOT --state building [--head <sha>] [--base <sha>]

--base..--head のコミット件名・本文から PR 番号を集める。GitHub のマージ
コミットは件名が "Merge pull request #123 from ..." で PR タイトルが本文に
入るため、タイトルは本文の先頭行を優先する。スカッシュマージ "(#123)" 形式
では件名自体がタイトルになる。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

PR_RE = re.compile(r"#(\d+)")
MERGE_SUBJECT_RE = re.compile(r"^Merge pull request #\d+ from \S+\s*$")


def _git(repo: str, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", repo, *args],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git failed")
    return result.stdout


def collect_prs(repo: str, head: str, base: str) -> list[dict]:
    """base..head のコミットから PR 番号とタイトルを順序を保って集める。"""
    fmt = "%s%x1f%b%x1e"
    log = ""
    if base:
        try:
            log = _git(repo, "log", f"--pretty=format:{fmt}", f"{base}..{head}")
        except Exception:
            log = ""
    if not log.strip():
        # 範囲が空（同一コミットの再ビルド等）なら HEAD のコミットだけを見る
        try:
            log = _git(repo, "log", "-1", f"--pretty=format:{fmt}", head)
        except Exception:
            return []
    prs: list[dict] = []
    seen: set[int] = set()
    for record in log.split("\x1e"):
        record = record.strip("\n")
        if not record.strip():
            continue
        subject, _, body = record.partition("\x1f")
        subject = subject.strip()
        body_lines = [line.strip() for line in body.splitlines() if line.strip()]
        match = PR_RE.search(subject)
        if not match:
            continue
        number = int(match.group(1))
        if number in seen:
            continue
        seen.add(number)
        if MERGE_SUBJECT_RE.match(subject) and body_lines:
            title = body_lines[0]
        else:
            # スカッシュマージの末尾 "(#123)" は表示タイトルから外す
            title = re.sub(r"\s*\(#\d+\)\s*$", "", subject).strip() or subject
        prs.append({"number": number, "title": title})
    return prs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--state", required=True, choices=["building", "deployed", "failed"])
    parser.add_argument("--head", default="")
    parser.add_argument("--base", default="")
    args = parser.parse_args()

    head = args.head
    if not head:
        try:
            head = _git(args.repo, "rev-parse", "HEAD").strip()
        except Exception:
            head = ""
    base = args.base
    if base and base == head:
        base = ""

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # 同じコミットの building 書き込みが既にあれば started_at を引き継ぐ
    started_at = now
    existing: dict = {}
    try:
        with open(args.path, encoding="utf-8") as fh:
            existing = json.load(fh)
        if existing.get("commit") == head and isinstance(existing.get("started_at"), str):
            started_at = existing["started_at"]
    except Exception:
        existing = {}

    prs = collect_prs(args.repo, head, base) if head else []
    if not prs and isinstance(existing.get("prs"), list) and existing.get("commit") == head:
        prs = existing["prs"]

    payload = {
        "state": args.state,
        "commit": head,
        "prs": prs,
        "started_at": started_at,
        "finished_at": None if args.state == "building" else now,
        "updated_at": now,
    }

    os.makedirs(os.path.dirname(args.path), exist_ok=True)
    tmp = f"{args.path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, args.path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
