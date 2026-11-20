#!/usr/bin/env python3
"""PDFium character-count baseline for the Ling Gao 校对员 plugin (dev only).

This script is the design §13.0 character-layer baseline: it extracts the text
layer of sample newspaper PDFs with `pypdfium2` (a real PDFium binding) and
prints per-page character counts. The plugin itself parses PDFs in the browser
with PDF.js; comparing the two counts on the 10 desktop samples proves the
PDF.js extraction does not silently drop text (acceptance: < 1% difference).

It is **development-only** and is never bundled or released: it depends on
`pypdfium2`, which is not a plugin dependency, and the archive whitelist in
`scripts/release.mjs` excludes `scripts/`.

Usage
-----
    pip install pypdfium2
    python scripts/baseline-pdfium.py path/to/sample-1.pdf path/to/sample-2.pdf
    python scripts/baseline-pdfium.py --text sample.pdf      # also print the text
    python scripts/baseline-pdfium.py --json sample.pdf | Out-File baseline.json

Output (default, one line per page):

    <file>\t<page>\t<non-whitespace chars>\t<total chars>

Sample PDFs are copyright material and must never be committed to this repo.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _load_pdfium():
    try:
        import pypdfium2  # noqa: PLC0415 - optional dev-only dependency
    except ImportError as exc:  # pragma: no cover - environment guard
        raise SystemExit(
            "pypdfium2 is required for the character baseline.\n"
            "Install it with:  pip install pypdfium2"
        ) from exc
    return pypdfium2


def extract_page_text(pdfium, page) -> str:
    """Extract one page's text layer (raises on a broken page)."""
    text_page = page.get_textpage()
    try:
        return text_page.get_text_range()
    finally:
        text_page.close()


def count_page(pdfium, page, index: int) -> dict[str, object]:
    text = extract_page_text(pdfium, page)
    return {
        "page": index + 1,
        "chars": len(text),
        "nonWhitespaceChars": len("".join(text.split())),
        "text": text,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Print per-page PDFium character counts for PDFs (dev baseline).",
    )
    parser.add_argument("pdfs", nargs="+", type=Path, help="PDF files to measure")
    parser.add_argument(
        "--json",
        action="store_true",
        help="emit JSON instead of the tab-separated table",
    )
    parser.add_argument(
        "--text",
        action="store_true",
        help="include the extracted page text in the JSON output",
    )
    args = parser.parse_args(argv)

    pdfium = _load_pdfium()

    results = []
    exit_code = 0
    for pdf_path in args.pdfs:
        if not pdf_path.is_file():
            print(f"error: not a file: {pdf_path}", file=sys.stderr)
            exit_code = 1
            continue
        document = pdfium.PdfDocument(str(pdf_path))
        try:
            pages = [
                count_page(pdfium, document[index], index)
                for index in range(len(document))
            ]
        except Exception as error:  # noqa: BLE001 - keep going over other samples
            print(f"error: cannot read {pdf_path}: {error}", file=sys.stderr)
            exit_code = 1
            continue
        finally:
            document.close()

        entry = {
            "file": str(pdf_path),
            "pageCount": len(pages),
            "pages": pages,
        }
        if not args.text:
            for page in entry["pages"]:
                page.pop("text", None)
        results.append(entry)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        print("file\tpage\tchars\tnon-whitespace-chars")
        for entry in results:
            for page in entry["pages"]:
                print(
                    f"{entry['file']}\t{page['page']}\t{page['chars']}\t"
                    f"{page['nonWhitespaceChars']}"
                )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
