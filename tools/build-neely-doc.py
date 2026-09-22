# -*- coding: utf-8 -*-
"""
닐리 책 본문 + 추출한 그림 300여 장을 하나의 HTML 문서로 합친다.

입력:
  docs/source/_주식_엘리어트_파동이론_마스터하기_unlocked.txt   (OCR 본문)
  docs/neely/figs/*.png + index.json                          (추출한 도해)

출력:
  docs/neely/글렌닐리-전체정리.html   (그림 인라인, 장별 목차, 검색)

원칙:
  · 본문은 OCR 원문이라 띄어쓰기가 깨진 곳이 많다. 읽기 위해 최소한만 손본다.
  · 그림은 나온 페이지 자리에 그대로 끼워 넣는다. 순서를 바꾸지 않는다.
  · 러닝헤더(장 제목 + 쪽번호)는 매 페이지 반복되므로 제거한다.
"""
import os, re, io, json, base64, html, collections

ROOT = r'C:\Users\wooba\wave-floor'
TXT = os.path.join(ROOT, 'docs', 'source', '_주식_엘리어트_파동이론_마스터하기_unlocked.txt')
FIGS = os.path.join(ROOT, 'docs', 'neely', 'figs')
OUT = os.path.join(ROOT, 'docs', 'neely', '글렌닐리-전체정리.html')

CHAPTERS = [
    (1, 34, 57, '엘리어트 파동이론에 대한 기본적 논의'),
    (2, 58, 79, '엘리어트 파동이론의 일반적인 개념들'),
    (3, 80, 185, '엘리어트 파동이론에 대한 예비적 분석'),
    (4, 186, 199, '엘리어트 파동이론의 중간적 관찰'),
    (5, 200, 261, '엘리어트 파동이론의 중점 고려사항'),
    (6, 262, 271, '논리적 사후 구성법칙'),
    (7, 272, 295, '엘리어트 파동이론의 결론'),
    (8, 296, 335, '복합 폴리파동과 멀티파동의 구성'),
    (9, 336, 351, '닐리에 의해 새롭게 확장된 기본적인 내용들'),
    (10, 352, 371, '고급 논리법칙'),
    (11, 372, 417, '고급 진행기호 적용'),
    (12, 418, 478, '닐리에 의해 새롭게 확장된 고급 이론'),
]

# 러닝헤더: "3장 엘리어트 파동이론에 대한 예비적 분석 107"
HDR = re.compile(r'^\s*\d{1,2}장\s+[가-힣][가-힣 ·]{3,40}\s+\d{2,3}\s*$')
PAGENUM = re.compile(r'^\s*\d{1,3}\s*$')


def load_pages():
    s = io.open(TXT, encoding='utf-8').read()
    parts = re.split(r'-----\s*p\.(\d+)\s*-----', s)
    pages = {}
    for i in range(1, len(parts), 2):
        pages[int(parts[i])] = parts[i + 1]
    return pages


def clean_page(txt):
    """러닝헤더·쪽번호를 지우고 문단을 잇는다."""
    lines = [l.rstrip() for l in txt.split('\n')]
    keep = []
    for l in lines:
        t = l.strip()
        if not t:
            keep.append('')
            continue
        if HDR.match(t):
            continue
        if PAGENUM.match(t) and len(t) <= 3:
            continue
        keep.append(t)
    # 빈 줄 압축
    out, blank = [], 0
    for l in keep:
        if not l:
            blank += 1
            if blank > 1:
                continue
        else:
            blank = 0
        out.append(l)
    return out


def para_join(lines):
    """OCR 줄바꿈을 문단으로 묶는다. 문장 끝(。.다) 이 아니면 이어붙인다."""
    paras, buf = [], ''
    for l in lines:
        if not l:
            if buf:
                paras.append(buf)
                buf = ''
            continue
        if buf and not re.search(r'[.。!?」』\)]$|다$|라$|음$|임$', buf):
            buf += ' ' + l
        else:
            if buf:
                paras.append(buf)
            buf = l
    if buf:
        paras.append(buf)
    return paras


def b64(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode('ascii')


def main():
    pages = load_pages()
    figs = []
    ip = os.path.join(FIGS, 'index.json')
    if os.path.exists(ip):
        figs = json.load(open(ip, encoding='utf-8'))
    by_page = collections.defaultdict(list)
    for f in figs:
        by_page[f['page']].append(f)

    total_fig = len(figs)
    body = []
    toc = []

    for (num, lo, hi, title) in CHAPTERS:
        cid = f'ch{num}'
        nfig = sum(len(by_page.get(p, [])) for p in range(lo, hi + 1))
        toc.append(f'<li><a href="#{cid}">{num}장 · {html.escape(title)}'
                   f'<span class="tn">p.{lo}~{hi} · 그림 {nfig}</span></a></li>')
        body.append(f'<section class="chap" id="{cid}">')
        body.append(f'<h2><i>{num}장</i>{html.escape(title)}'
                    f'<span class="meta">원서 p.{lo}~{hi} · 그림 {nfig}장</span></h2>')

        for p in range(lo, hi + 1):
            if p not in pages and p not in by_page:
                continue
            body.append(f'<div class="pg" id="p{p}"><span class="pgn">p.{p}</span>')
            if p in pages:
                for para in para_join(clean_page(pages[p])):
                    if len(para) < 2:
                        continue
                    cls = 'fc' if re.match(r'^\s*[•·]*\s*그\s*림', para) else ''
                    body.append(f'<p class="{cls}">{html.escape(para)}</p>')
            for f in by_page.get(p, []):
                fp = os.path.join(FIGS, f['file'])
                if not os.path.exists(fp):
                    continue
                cap = f.get('caption') or ''
                # base64로 넣으면 단일 파일이 42MB가 돼 브라우저가 버거워한다.
                # 같은 폴더의 figs/ 를 상대경로로 참조하고 lazy 로딩에 맡긴다.
                body.append(
                    f'<figure><img src="figs/{html.escape(f["file"])}" alt="{html.escape(cap)}" loading="lazy">'
                    f'<figcaption>{html.escape(cap)} <span>p.{p}</span></figcaption></figure>'
                )
            body.append('</div>')
        body.append('</section>')

    doc = f'''<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>글렌 닐리 — 엘리어트 파동이론 마스터하기 · 전체 정리</title>
<style>
:root{{--bg:#0d0d12;--fg:#d8d8e0;--dim:#8a8a9a;--acc:#e8c84a;--line:#26262f;--card:#14141b}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.75 -apple-system,"Segoe UI","Malgun Gothic",sans-serif}}
header{{position:sticky;top:0;z-index:9;background:#0a0a0f;border-bottom:1px solid var(--line);padding:10px 18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}}
header h1{{font-size:15px;margin:0;color:var(--acc);font-weight:600;white-space:nowrap}}
header .sub{{color:var(--dim);font-size:12px}}
#q{{margin-left:auto;background:#12121a;border:1px solid var(--line);color:var(--fg);padding:5px 10px;font-size:13px;min-width:190px;border-radius:3px}}
.wrap{{display:grid;grid-template-columns:250px 1fr;gap:0;align-items:start}}
nav{{position:sticky;top:52px;max-height:calc(100vh - 52px);overflow:auto;border-right:1px solid var(--line);padding:14px 10px}}
nav ol{{list-style:none;margin:0;padding:0;counter-reset:c}}
nav a{{display:block;color:var(--fg);text-decoration:none;font-size:12.5px;padding:6px 8px;border-radius:3px;line-height:1.4}}
nav a:hover{{background:#1a1a24;color:var(--acc)}}
nav .tn{{display:block;color:var(--dim);font-size:11px}}
main{{padding:22px 32px;max-width:900px}}
.chap{{margin-bottom:44px}}
h2{{font-size:19px;color:var(--acc);border-bottom:1px solid var(--line);padding-bottom:8px;margin:28px 0 16px}}
h2 i{{font-style:normal;color:var(--dim);font-size:13px;display:block}}
h2 .meta{{display:block;color:var(--dim);font-size:12px;font-weight:400;margin-top:3px}}
.pg{{position:relative;padding:2px 0 2px 0;border-left:2px solid transparent}}
.pg:hover{{border-left-color:#2a2a36}}
.pgn{{position:absolute;left:-56px;top:4px;color:#3a3a48;font-size:11px;font-family:monospace}}
p{{margin:0 0 11px;text-align:justify;word-break:keep-all}}
p.fc{{color:var(--dim);font-size:13px;font-style:italic}}
figure{{margin:16px 0;background:#fff;border:1px solid var(--line);border-radius:4px;padding:8px}}
figure img{{width:100%;height:auto;display:block}}
figcaption{{color:#333;font-size:12px;text-align:center;padding-top:6px;font-weight:600}}
figcaption span{{color:#888;font-weight:400}}
mark{{background:#4a3c0a;color:#ffe680}}
.hidden{{display:none}}
@media(max-width:820px){{.wrap{{grid-template-columns:1fr}}nav{{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--line)}}main{{padding:16px}}.pgn{{position:static;display:inline-block;margin-right:6px}}}}
</style></head><body>
<header>
  <h1>글렌 닐리 — 엘리어트 파동이론 마스터하기</h1>
  <span class="sub">전체 정리 · 원서 478쪽 · 도해 {total_fig}장</span>
  <input id="q" type="search" placeholder="본문 검색 (예: 되돌림 법칙)">
</header>
<div class="wrap">
<nav><ol>{''.join(toc)}</ol></nav>
<main id="doc">{''.join(body)}</main>
</div>
<script>
const q=document.getElementById('q'),doc=document.getElementById('doc');
let t=null;
q.addEventListener('input',()=>{{clearTimeout(t);t=setTimeout(run,220)}});
function run(){{
  const v=q.value.trim();
  doc.querySelectorAll('mark').forEach(m=>m.replaceWith(m.textContent));
  doc.querySelectorAll('.pg').forEach(d=>d.classList.remove('hidden'));
  doc.querySelectorAll('.chap').forEach(d=>d.classList.remove('hidden'));
  if(v.length<2)return;
  const re=new RegExp(v.replace(/[.*+?^${{}}()|[\\]\\\\]/g,'\\\\$&'),'gi');
  doc.querySelectorAll('.chap').forEach(ch=>{{
    let any=false;
    ch.querySelectorAll('.pg').forEach(pg=>{{
      let hit=false;
      pg.querySelectorAll('p').forEach(p=>{{
        if(re.test(p.textContent)){{hit=true;p.innerHTML=p.textContent.replace(re,m=>'<mark>'+m+'</mark>')}}
        re.lastIndex=0;
      }});
      pg.classList.toggle('hidden',!hit); if(hit)any=true;
    }});
    ch.classList.toggle('hidden',!any);
  }});
}}
</script></body></html>'''

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    io.open(OUT, 'w', encoding='utf-8', newline='').write(doc)
    mb = os.path.getsize(OUT) / 1024 / 1024
    print(f'생성: {OUT}')
    print(f'  그림 {total_fig}장 · 크기 {mb:.1f}MB')


if __name__ == '__main__':
    main()
