#!/usr/bin/env python3
"""PR overwrite guard: detect a PR silently cancelling other work.

Failure mode this guards against (observed 2026-11-15, PR #881 vs #879):
a branch is committed from a stale whole-file snapshot. The resulting
commit *deletes* lines that another PR added minutes earlier, as if the
deletion were intentional, so git merges it cleanly and the earlier
PR's work disappears from main without any conflict.

This script compares the PR head against the merge-base and looks at
the substantive lines the PR deletes. A deleted line is "protected"
when `git blame` on the merge-base attributes it to a recent commit.
Two rules flag a file:

  R1 (foreign work): >= FOREIGN_MIN deleted protected lines in one
     file whose blame author is not one of the PR's commit authors,
     added within FOREIGN_DAYS days.
  R2 (bulk rewrite): >= BULK_MIN deleted protected lines in one file
     added within BULK_DAYS days, regardless of author. Whole-file
     rewrites of hot files are exactly how cancellations happen.

Legitimate removals override the guard by adding the PR label
`confirm-removals` (the workflow passes --soft then); the report is
printed either way so the deletions stay visible in the CI log and in
the job summary.

Lines that still exist elsewhere in the PR's version of the same file
(moved code) are not counted. Whole-file deletions are not counted
(they are obvious in the PR file list). Trivial lines (short or pure
punctuation) are not counted. Generated/lock files are exempt.

Usage:
  pr_overwrite_guard.py --base <sha> --head <sha> [--soft]
Exit code 0 = pass, 1 = flagged (unless --soft), 2 = usage/git error.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections import Counter, defaultdict

FOREIGN_DAYS = 30
FOREIGN_MIN = 3
BULK_DAYS = 7
BULK_MIN = 20
MIN_LINE_LEN = 12

EXEMPT_PATTERNS = [
    re.compile(r"(^|/)package-lock\.json$"),
    re.compile(r"\.lock$"),
    re.compile(r"^web/data/.*\.json$"),  # regenerated at deploy time
    re.compile(r"^\.github/"),
    re.compile(r"^tools/pr_overwrite_guard\.py$"),
]

TRIVIAL = re.compile(r"^[\s\{\}\(\)\[\];,<>/]+$")


def git(*args: str) -> str:
    proc = subprocess.run(
        ["git", *args], capture_output=True, text=True, encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def is_exempt(path: str) -> bool:
    return any(p.search(path) for p in EXEMPT_PATTERNS)


def parse_deleted_lines(diff_text: str) -> list[tuple[int, str]]:
    """Return (merge-base line number, content) for each deleted line."""
    deleted: list[tuple[int, str]] = []
    base_lineno = None
    for line in diff_text.splitlines():
        if line.startswith("@@"):
            m = re.search(r"-(\d+)(?:,(\d+))?", line)
            base_lineno = int(m.group(1)) if m else None
            continue
        if base_lineno is None:
            continue
        if line.startswith("-") and not line.startswith("---"):
            deleted.append((base_lineno, line[1:]))
            base_lineno += 1
        elif line.startswith("+") and not line.startswith("+++"):
            continue
        elif line.startswith("\\"):
            continue
        else:
            base_lineno += 1
    return deleted


def blame_map(rev: str, path: str) -> dict[int, tuple[str, str, int]]:
    """Line number -> (commit sha, author ident, author time) at rev."""
    out = git("blame", "--porcelain", rev, "--", path)
    result: dict[int, tuple[str, str, int]] = {}
    # Porcelain only prints author fields in the first block per commit;
    # later blocks for the same commit carry just header + content.
    info_by_sha: dict[str, list] = {}
    sha = ""
    lineno = 0
    for line in out.splitlines():
        if re.match(r"^[0-9a-f]{40} \d+ \d+", line):
            parts = line.split()
            sha = parts[0]
            lineno = int(parts[2])
            info_by_sha.setdefault(sha, ["", 0])
        elif line.startswith("author ") and not line.startswith("author-"):
            info_by_sha[sha][0] = line[len("author "):]
        elif line.startswith("author-mail "):
            mail = line[len("author-mail "):]
            info_by_sha[sha][0] = f"{info_by_sha[sha][0]} {mail}".strip()
        elif line.startswith("author-time "):
            info_by_sha[sha][1] = int(line[len("author-time "):])
        elif line.startswith("\t"):
            author, author_time = info_by_sha.get(sha, ["", 0])
            result[lineno] = (sha, author.lower(), author_time)
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--soft", action="store_true",
                    help="report only, never fail (confirm-removals label)")
    args = ap.parse_args()

    try:
        merge_base = git("merge-base", args.base, args.head).strip()
        head_time = int(git("log", "-1", "--format=%ct", args.head).strip())
        pr_authors = {
            ident.strip().lower()
            for ident in git(
                "log", "--format=%an%n%ae", f"{merge_base}..{args.head}"
            ).splitlines()
            if ident.strip()
        }
        name_status = git(
            "diff", "--name-status", merge_base, args.head
        ).splitlines()
    except RuntimeError as exc:
        print(f"overwrite-guard: {exc}", file=sys.stderr)
        return 2

    changed: list[str] = []
    for entry in name_status:
        parts = entry.split("\t")
        status = parts[0]
        if status.startswith("D") or status.startswith("A"):
            continue  # whole-file delete/add: visible, not a silent overwrite
        path = parts[-1]
        if not is_exempt(path):
            changed.append(path)

    numstat = {}
    for entry in git("diff", "--numstat", merge_base, args.head).splitlines():
        parts = entry.split("\t")
        if len(parts) == 3:
            numstat[parts[2]] = (parts[0], parts[1])

    flagged: list[str] = []
    report: list[str] = []

    for path in changed:
        if numstat.get(path, ("0", "0"))[0] == "-":
            continue  # binary
        diff_text = git(
            "diff", "--unified=0", "--no-color", merge_base, args.head,
            "--", path,
        )
        deleted = parse_deleted_lines(diff_text)
        if not deleted:
            continue
        try:
            head_content = git("show", f"{args.head}:{path}")
        except RuntimeError:
            continue
        head_lines = Counter(
            ln.strip() for ln in head_content.splitlines() if ln.strip()
        )
        try:
            blame = blame_map(merge_base, path)
        except RuntimeError:
            continue

        foreign: list[tuple[int, str, str]] = []  # (lineno, sha, content)
        recent = 0
        subjects: dict[str, str] = {}
        for lineno, content in deleted:
            stripped = content.strip()
            if len(stripped) < MIN_LINE_LEN or TRIVIAL.match(stripped):
                continue
            if head_lines.get(stripped, 0) > 0:
                head_lines[stripped] -= 1
                continue  # moved, not removed
            info = blame.get(lineno)
            if info is None:
                continue
            sha, author, atime = info
            age_days = (head_time - atime) / 86400 if atime else 9999
            author_foreign = not any(
                token and token in author for token in pr_authors
            )
            if age_days <= BULK_DAYS:
                recent += 1
            if age_days <= FOREIGN_DAYS and author_foreign:
                foreign.append((lineno, sha, stripped))
                if sha not in subjects:
                    try:
                        subjects[sha] = git(
                            "log", "-1", "--format=%s", sha
                        ).strip()
                    except RuntimeError:
                        subjects[sha] = ""

        reasons = []
        if len(foreign) >= FOREIGN_MIN:
            reasons.append(
                f"R1: {len(foreign)} lines added by others within "
                f"{FOREIGN_DAYS}d are deleted"
            )
        if recent >= BULK_MIN:
            reasons.append(
                f"R2: {recent} lines added within {BULK_DAYS}d are "
                f"deleted (bulk rewrite)"
            )
        if reasons:
            flagged.append(path)
            report.append(f"### {path}")
            report.extend(f"- {r}" for r in reasons)
            by_sha: dict[str, list[str]] = defaultdict(list)
            for _, sha, content in foreign:
                by_sha[sha].append(content)
            for sha, lines in by_sha.items():
                report.append(
                    f"- introduced by `{sha[:7]}` {subjects.get(sha, '')}"
                )
                for sample in lines[:5]:
                    report.append(f"  - deleted: `{sample[:100]}`")
                if len(lines) > 5:
                    report.append(f"  - … and {len(lines) - 5} more")
            report.append("")

    if flagged:
        print("## Overwrite guard: suspicious deletions found\n")
        print("\n".join(report))
        print(
            "These deletions can silently cancel another PR's work "
            "(stale whole-file snapshot). Restore the lines, or, if "
            "the removal is intentional, add the PR label "
            "`confirm-removals` and re-run."
        )
        return 0 if args.soft else 1

    print("overwrite-guard: no suspicious deletions.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
