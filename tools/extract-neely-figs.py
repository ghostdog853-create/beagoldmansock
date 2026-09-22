# -*- coding: utf-8 -*-
"""
닐리 『엘리어트 파동이론 마스터하기』에서 그림(도해)만 뽑아낸다.

이 PDF는 페이지 전체가 한 장의 스캔 JPEG이고 그 위에 OCR 텍스트 레이어가 얹혀 있다.
따라서 이미지 객체를 뽑으면 '페이지 사진 478장'이 나올 뿐 그림은 안 나온다.

그래서 이렇게 한다:
  ① 페이지를 렌더링해 잉크(어두운 픽셀) 마스크를 만든다
  ② OCR 단어 상자 영역을 마스크에서 지운다  → 남은 잉크 = 글자가 아닌 것 = 도해
  ③ 남은 잉크를 행/열 투영으로 뭉쳐 사각형을 얻고, 너무 작은 것은 버린다
  ④ 그 사각형을 원본 해상도로 잘라 저장한다
  ⑤ 같은 페이지의 '그림 N-M' 캡션을 찾아 파일명·메타에 붙인다

산출:
  docs/neely/figs/p0107_그림3-23.png ...
  docs/neely/figs/index.json
"""
import os, re, io, json, glob, sys
import numpy as np
import pymupdf
from PIL import Image

SRC_DIR = r'C:\Users\wooba\Creative Cloud Files Personal Account woong021105@gmail.com 0A37424F5DB9AE980A495FD1@AdobeID\바탕 화면\재웅 파일\자매 버전 1\내용들'
OUT_DIR = r'C:\Users\wooba\wave-floor\docs\neely\figs'

RENDER_DPI = 110          # 탐지용 저해상도
CROP_DPI = 200            # 저장용 고해상도
INK_THRESHOLD = 205       # 이보다 어두우면 잉크
PAD_TEXT = 2              # 단어 상자를 지울 때 여유 (pt)
MIN_W_RATIO = 0.13        # 페이지 폭 대비 최소 그림 폭
MIN_H_RATIO = 0.05        # 페이지 높이 대비 최소 그림 높이
MIN_INK = 900             # 최소 잉크 픽셀 수 (점·얼룩 제거)
GAP_MERGE = 14            # 이 픽셀 이내로 떨어진 덩어리는 하나로 본다

CAPTION = re.compile(r'그\s*림\s*(\d{1,2})\s*[-–—]\s*(\d{1,3})\s*([a-zA-Z]?)')


def find_pdf():
    for x in glob.glob(os.path.join(SRC_DIR, '*.pdf')):
        if '마스터하기' in x:
            return x
    raise SystemExit('닐리 PDF를 찾지 못했습니다')


def runs_from_projection(proj, gap, min_len):
    """1차원 불리언 투영에서 연속 구간을 뽑고, gap 이내로 떨어진 것은 합친다."""
    idx = np.flatnonzero(proj)
    if idx.size == 0:
        return []
    groups = []
    start = prev = idx[0]
    for v in idx[1:]:
        if v - prev > gap:
            groups.append((start, prev))
            start = v
        prev = v
    groups.append((start, prev))
    return [(a, b) for a, b in groups if (b - a) >= min_len]


def page_captions(page):
    txt = page.get_text()
    out = []
    for m in CAPTION.finditer(txt):
        out.append(f'그림{m.group(1)}-{m.group(2)}{m.group(3)}')
    # 중복 제거 (순서 유지)
    seen, uniq = set(), []
    for c in out:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


def extract_page(doc, pno, out_dir):
    page = doc[pno]
    zoom = RENDER_DPI / 72.0
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csGRAY)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)

    ink = arr < INK_THRESHOLD

    # OCR 단어 상자를 잉크에서 제거 → 남는 건 글자가 아닌 것
    for w in page.get_text('words'):
        x0, y0, x1, y1 = w[0], w[1], w[2], w[3]
        a = int(max(0, (x0 - PAD_TEXT) * zoom))
        b = int(max(0, (y0 - PAD_TEXT) * zoom))
        c = int(min(pix.width, (x1 + PAD_TEXT) * zoom))
        d = int(min(pix.height, (y1 + PAD_TEXT) * zoom))
        if c > a and d > b:
            ink[b:d, a:c] = False

    # 스캔 가장자리 그림자 제거
    m = int(0.035 * pix.width)
    ink[:m, :] = False
    ink[-m:, :] = False
    ink[:, :m] = False
    ink[:, -m:] = False

    if ink.sum() < MIN_INK:
        return []

    # 행 투영으로 그림 띠를 찾고, 각 띠 안에서 열 투영으로 좌우를 자른다
    row_has = ink.sum(axis=1) > 2
    bands = runs_from_projection(row_has, GAP_MERGE, int(MIN_H_RATIO * pix.height))

    results = []
    caps = page_captions(page)
    for bi, (y0, y1) in enumerate(bands):
        sub = ink[y0:y1 + 1, :]
        if sub.sum() < MIN_INK:
            continue
        col_has = sub.sum(axis=0) > 1
        cols = runs_from_projection(col_has, GAP_MERGE * 2, int(MIN_W_RATIO * pix.width))
        if not cols:
            continue
        x0 = min(a for a, _ in cols)
        x1 = max(b for _, b in cols)
        if (x1 - x0) < MIN_W_RATIO * pix.width:
            continue
        if sub[:, x0:x1 + 1].sum() < MIN_INK:
            continue

        # 저해상도 좌표 → PDF 좌표 → 고해상도 크롭
        pad = 6
        rect = pymupdf.Rect(
            max(0, (x0 - pad)) / zoom,
            max(0, (y0 - pad)) / zoom,
            min(pix.width, (x1 + pad)) / zoom,
            min(pix.height, (y1 + pad)) / zoom,
        )
        cz = CROP_DPI / 72.0
        crop = page.get_pixmap(matrix=pymupdf.Matrix(cz, cz), clip=rect)
        img = Image.frombytes('RGB', (crop.width, crop.height), crop.samples)

        cap = caps[bi] if bi < len(caps) else (caps[0] if caps else '')
        safe = cap if cap else f'fig{bi + 1}'
        name = f'p{pno + 1:04d}_{safe}' + (f'_{bi + 1}' if len(bands) > 1 else '') + '.png'
        path = os.path.join(out_dir, name)
        img.save(path, optimize=True)
        results.append({
            'page': pno + 1,
            'caption': cap,
            'file': name,
            'w': crop.width,
            'h': crop.height,
        })
    return results


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    doc = pymupdf.open(find_pdf())
    total = doc.page_count
    lo = int(sys.argv[1]) - 1 if len(sys.argv) > 1 else 0
    hi = int(sys.argv[2]) if len(sys.argv) > 2 else total
    index = []
    for pno in range(lo, min(hi, total)):
        try:
            got = extract_page(doc, pno, OUT_DIR)
            index.extend(got)
        except Exception as e:
            print(f'  p.{pno+1} 실패: {e}', file=sys.stderr)
        if (pno + 1) % 40 == 0:
            print(f'  ... p.{pno+1}/{total} 누적 {len(index)}개', flush=True)
    idx_path = os.path.join(OUT_DIR, 'index.json')
    old = []
    if os.path.exists(idx_path):
        try:
            old = json.load(open(idx_path, encoding='utf-8'))
        except Exception:
            old = []
    merged = {(r['page'], r['file']): r for r in old + index}
    out = sorted(merged.values(), key=lambda r: (r['page'], r['file']))
    json.dump(out, open(idx_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    named = sum(1 for r in out if r['caption'])
    print(f'추출 완료: {len(out)}개 (캡션 매칭 {named}개) → {OUT_DIR}')


if __name__ == '__main__':
    main()
