# -*- coding: utf-8 -*-
"""
배포본 빌드 - index.html + products.js 를 파일 하나로 합칩니다.

    python build.py

결과: dist/index.html (단일 파일), dist/robots.txt, dist/_headers
상품 정보를 갱신한 뒤 이 스크립트를 다시 실행하면 배포본도 갱신됩니다.
"""
import json
import os
import re
import sys
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(BASE, "dist")
VERSION_FILE = os.path.join(BASE, "version.json")

MAJOR = 1  # 큰 변경이 있을 때만 손으로 올립니다


def next_version():
    """빌드할 때마다 뒷번호를 1씩 올립니다. (v1.0 -> v1.1 -> v1.2 ...)"""
    build = 0
    if os.path.exists(VERSION_FILE):
        try:
            with open(VERSION_FILE, encoding="utf-8") as f:
                build = int(json.load(f).get("build", 0))
        except Exception:
            build = 0
    build += 1
    now = datetime.now()
    with open(VERSION_FILE, "w", encoding="utf-8") as f:
        json.dump({"major": MAJOR, "build": build,
                   "builtAt": now.strftime("%Y-%m-%d %H:%M")}, f,
                  ensure_ascii=False, indent=1)
    return "v%d.%d" % (MAJOR, build), now.strftime("%Y-%m-%d %H:%M")

NOINDEX = (
    '<meta name="robots" content="noindex,nofollow,noarchive,nosnippet">\n'
    '<meta name="googlebot" content="noindex,nofollow">\n'
)


def read(name):
    with open(os.path.join(BASE, name), encoding="utf-8") as f:
        return f.read()


def main():
    html = read("index.html")
    products = read("products.js")

    # 1) products.js 를 인라인으로 삽입
    tag = '<script src="products.js"></script>'
    if tag not in html:
        sys.exit("오류: index.html 에서 products.js 스크립트 태그를 찾지 못했습니다.")
    # </script> 가 데이터 안에 있으면 조기 종료되므로 방어
    safe = products.replace("</script>", "<\\/script>")
    html = html.replace(tag, "<script>\n" + safe + "\n</script>")

    # 2) 검색엔진 색인 차단 메타 추가
    html = html.replace("<title>", NOINDEX + "<title>", 1)

    # 3) 버전 표기 주입
    version, built_at = next_version()
    if "__APP_VERSION__" not in html:
        sys.exit("오류: index.html 에서 __APP_VERSION__ 자리를 찾지 못했습니다.")
    html = html.replace("__APP_VERSION__", version)
    html = html.replace("__BUILD_TIME__", built_at)

    os.makedirs(DIST, exist_ok=True)

    out = os.path.join(DIST, "index.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)

    with open(os.path.join(DIST, "robots.txt"), "w", encoding="utf-8") as f:
        f.write("User-agent: *\nDisallow: /\n")

    # Netlify / Cloudflare Pages 용 헤더
    with open(os.path.join(DIST, "_headers"), "w", encoding="utf-8") as f:
        f.write("/*\n  X-Robots-Tag: noindex, nofollow\n")

    # 4) 원본 소스도 dist/source 로 복사해 함께 백업되게 한다
    #    (dist 폴더만 git 저장소이므로, 이렇게 해야 원본이 유실되지 않습니다)
    src_dir = os.path.join(DIST, "source")
    os.makedirs(src_dir, exist_ok=True)
    copied = []
    for name in ("index.html", "build.py", "parse_sheet.py", "apps-script.gs",
                 "README.md", "products.json", "version.json"):
        p = os.path.join(BASE, name)
        if not os.path.exists(p):
            continue
        with open(p, "rb") as fr, open(os.path.join(src_dir, name), "wb") as fw:
            fw.write(fr.read())
        copied.append(name)

    n = len(re.findall(r'"name":', products))
    size = os.path.getsize(out)
    print("버전 %s  (%s 빌드)" % (version, built_at))
    print("dist/index.html  %6.1f KB  (상품 %d개 포함)" % (size / 1024, n))
    print("dist/robots.txt  검색엔진 차단")
    print("dist/_headers    X-Robots-Tag 차단")
    print("dist/source/     원본 %d개 백업 (%s)" % (len(copied), ", ".join(copied)))
    print("\n완료 - dist 폴더를 통째로 배포하세요.")


if __name__ == "__main__":
    main()
