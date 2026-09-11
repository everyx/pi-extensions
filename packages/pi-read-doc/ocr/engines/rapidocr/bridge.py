#!/usr/bin/env python3
"""pi-read-doc — rapidocr bridge.

One JSON line per image on stdout, in argv order:

  {"n": 0, "lines": ["contract", "dated 2024-01-01"], "scores": [0.98, 0.91]}
  {"n": 2, "error": "cannot identify image file"}

The threshold lives on the caller's side (it filters with `scores`), so this
stays a dumb bridge. RapidOCR's own API changed shape across majors: current
releases return a `RapidOCROutput` (`txts`/`scores`), older ones a tuple whose
first element is a list of [box, text, score] rows. Both are handled; the old
shape is best-effort since only the new one is installed here to test against.

"Nothing on this page" and "I do not understand this result" are deliberately
NOT the same answer: the first is a fact about the image, the second is a bug
here. Reporting the second as the first would tell the user a falsehood —
`extract` returns None for an unknown shape, and that becomes an `error` line.

Dependency: `pip install rapidocr` (distro packages exist too). Models are
downloaded on the first run and cached — after that the engine works offline.
"""

import json
import sys

from rapidocr import RapidOCR


_UNKNOWN = object()


def extract(result):
    """-> (texts, scores), or None when the shape is one we do not know.

    None means "cannot tell what this is" — never "the page was empty": a
    valid result with no text returns ([], []) like any other empty page.
    """
    txts = getattr(result, "txts", _UNKNOWN)
    if txts is not _UNKNOWN:  # current releases: RapidOCROutput
        return list(txts or []), [float(s) for s in (getattr(result, "scores", None) or [])]
    if isinstance(result, (list, tuple)) and result:  # older: (rows, elapse)
        rows = result[0]
        if rows is None:
            return [], []  # the old API's "nothing was detected"
        if isinstance(rows, (list, tuple)):
            texts, scores = [], []
            for row in rows:
                if isinstance(row, (list, tuple)) and len(row) >= 2:
                    texts.append(str(row[1]))
                    scores.append(float(row[2]) if len(row) > 2 else 1.0)
            return texts, scores
    return None


def main(paths):
    ocr = RapidOCR()
    for index, path in enumerate(paths):
        try:
            got = extract(ocr(path))
            if got is None:
                # Say what actually happened: we did not understand the engine's
                # output. Claiming "no text" here would be a lie the caller
                # cannot detect.
                print(
                    json.dumps({"n": index, "error": "unrecognized rapidocr output shape"}, ensure_ascii=False),
                    flush=True,
                )
                continue
            texts, scores = got
            print(
                json.dumps({"n": index, "lines": texts, "scores": scores}, ensure_ascii=False),
                flush=True,
            )
        except Exception as exc:  # a bad image must not kill the whole run
            print(json.dumps({"n": index, "error": str(exc)[:200]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
