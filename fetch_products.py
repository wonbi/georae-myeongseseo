# -*- coding: utf-8 -*-
"""
Apps Script 연동 주소(.../exec) 응답 -> products.json / products.js

구글시트 덤프를 손으로 만들 필요 없이, 시트에 붙여넣어둔 apps-script.gs 가
이미 단가 규칙을 적용해 내려준 결과를 그대로 받아 씁니다.

사용:
    curl -sL "<웹 앱 URL>" -o fetched.json
    python fetch_products.py fetched.json

단가 규칙은 apps-script.gs 안에 있습니다 (변동공지 우선, (창고명,상품명) 로 구분).
여기서는 형식만 맞추고, 단가가 갈리는 상품(alts)이 있으면 경고로 보여줍니다.
"""
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))

FIELDS = ("name", "warehouse", "price", "courier", "fee",
          "taxable", "deadline", "expiry", "changedAt", "src", "alts")


def load(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read().strip()

    if raw.startswith("<"):
        sys.exit(
            "HTML 이 돌아왔습니다. 웹 앱 URL 이 아니거나 접근 권한이 '모든 사용자' 가\n"
            "아닐 수 있습니다. 배포 설정을 확인하고 .../exec 주소로 다시 받아주세요."
        )

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit("JSON 을 읽지 못했습니다: %s" % e)

    items = data if isinstance(data, list) else data.get("items")
    if not items:
        sys.exit("상품이 하나도 없습니다. 시트 머리글(창고명·상품명·공급가)을 확인하세요.")

    updated = "" if isinstance(data, list) else str(data.get("updatedAt") or "")
    return items, updated


def tidy(it):
    """웹앱이 쓰는 필드만 남기고 빈 값은 떨어냅니다 (파일 크기 절약)."""
    out = {}
    for k in FIELDS:
        v = it.get(k)
        if v in (None, "", []):
            continue
        out[k] = v
    out["price"] = int(it.get("price") or 0)
    out["fee"] = int(it.get("fee") or 0)
    out["taxable"] = bool(it.get("taxable"))
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit("사용법: python fetch_products.py <받아온.json>")

    items, updated = load(sys.argv[1])
    items = [tidy(i) for i in items if i.get("name") and i.get("price")]
    items.sort(key=lambda x: (x["name"], x.get("warehouse", "")))

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", updated):
        sys.exit("응답의 updatedAt 이 이상합니다: %r" % updated)

    # 합계 등식(공급가 = 단가 x 수량)에 영향을 주는 값이므로 이상값은 짚어줍니다
    bad = [i for i in items if i["price"] <= 0]
    conflicts = [i for i in items if i.get("alts")]
    changed = [i for i in items if i.get("src") == "변동사항"]

    print("상품 %d개 · 기준일 %s" % (len(items), updated))
    print("  변동공지 단가 적용 : %d" % len(changed))
    print("  단가 충돌(경고)    : %d" % len(conflicts))
    for it in conflicts:
        print("    * %s(%s) %s" % (it["name"], it.get("warehouse", "-"),
                                   " / ".join("{:,}".format(p) for p in it["alts"])))
    if bad:
        print("  단가 0원 : %d건" % len(bad))

    with open(os.path.join(BASE, "products.json"), "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)

    body = json.dumps(items, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(BASE, "products.js"), "w", encoding="utf-8") as f:
        f.write(
            "// 자동 생성됨 - fetch_products.py\n"
            "// 상품 %d개 · 기준일 %s\n"
            "window.PRODUCT_DATA = {\n"
            '  updatedAt: "%s",\n'
            '  source: "google-sheet",\n'
            "  items: %s\n};\n" % (len(items), updated, updated, body)
        )

    print("\nproducts.json / products.js 갱신 완료 — 이제 python build.py 를 실행하세요")


if __name__ == "__main__":
    main()
