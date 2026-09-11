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

Dependency: `pip install rapidocr` (distro packages exist too). Models are
downloaded on the first run and cached — after that the engine works offline.
"""

import json
import sys

from rapidocr import RapidOCR


def extract(result):
    """-> (texts, scores). Handles both API generations."""
    txts = getattr(result, "txts", None)
    if txts is not None:  # current releases
        return list(txts), [float(s) for s in (getattr(result, "scores", None) or [])]
    if isinstance(result, (list, tuple)) and result:  # older: (rows, elapse)
        rows = result[0]
        if isinstance(rows, (list, tuple)):
            texts, scores = [], []
            for row in rows:
                if isinstance(row, (list, tuple)) and len(row) >= 2:
                    texts.append(str(row[1]))
                    scores.append(float(row[2]) if len(row) > 2 else 1.0)
            return texts, scores
    return [], []


def main(paths):
    ocr = RapidOCR()
    for index, path in enumerate(paths):
        try:
            texts, scores = extract(ocr(path))
            print(
                json.dumps({"n": index, "lines": texts, "scores": scores}, ensure_ascii=False),
                flush=True,
            )
        except Exception as exc:  # a bad image must not kill the whole run
            print(json.dumps({"n": index, "error": str(exc)[:200]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
