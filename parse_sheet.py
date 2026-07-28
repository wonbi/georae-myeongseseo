# -*- coding: utf-8 -*-
"""
구글시트 덤프 -> products.json / products.js

단가 결정 규칙 (우선순위)
 1. '상품 변동사항' 시트에 있으면 그 값을 씁니다.
    같은 상품이 여러 번 나오면 적용날짜 > 기재날짜 > 시트 등장순 으로 가장 최신 행을 택합니다.
 2. 없으면 창고별 마스터 시트 값을 씁니다.
 3. 상품은 (창고명, 상품명) 으로 구분합니다. 창고가 다르면 동명이품이라도 별개 상품입니다.
 4. 같은 창고 안에서 단가가 서로 다르게 여러 번 나오면 자동으로 정하지 않고
    alts 에 후보를 모두 담아 웹앱에서 경고를 띄웁니다.

사용:  python parse_sheet.py <시트덤프.txt>
"""
import json
import os
import re
import sys
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))

clean = lambda s: re.sub(r"\\(.)", r"\1", s).strip()
tail = lambda v: str(v or "").split(">")[-1].strip()


def to_num(v):
    v = tail(v)
    return int(v.replace(",", "")) if re.fullmatch(r"[\d,]+", v) else None


def fee_of(v):
    raw = tail(v)
    return 0 if "무료" in raw else (to_num(raw) or 0)


def taxable_of(v):
    v = str(v or "")
    return "과세" in v and "면세" not in v


def cells_of(line):
    parts = line.split("|")
    return [clean(c) for c in parts[1:-1]] if len(parts) >= 3 else []


def norm_date(s):
    """'2026. 07. 24' -> '20260724' (비교 가능한 형태)"""
    d = re.sub(r"\D", "", str(s or ""))
    return d if len(d) == 8 else ""


def parse(path):
    content = json.load(open(path, encoding="utf-8"))["fileContent"]
    lines = content.split("\n")

    # ---------- 1) 변동사항 시트 ----------
    changes = {}  # (wh, name) -> dict
    cmap = None
    for order, line in enumerate(lines):
        c = cells_of(line)
        if not c:
            continue
        if "상품명변동" in c:
            cmap = {h: i for i, h in enumerate(c) if h}
            continue
        if cmap is None or "[merged]" in line:
            continue
        g = lambda k: c[cmap[k]] if k in cmap and cmap[k] < len(c) else ""

        name = g("상품명변동")
        price = to_num(g("공급가변동 (공급가)"))
        if not name or price is None:
            continue

        wh = g("창고명변동")
        key = (wh, name)
        rank = (norm_date(g("적용 날짜")), norm_date(g("기재 날짜")), order)
        prev = changes.get(key)
        if prev and prev["_rank"] >= rank:
            continue
        changes[key] = {
            "_rank": rank,
            "price": price,
            "fee": fee_of(g("택배비변동")),
            "courier": g("택배사"),
            "taxable": taxable_of(g("면과세변동")),
            "changedAt": g("적용 날짜").replace(" ", ""),
            "changeType": g("변동"),
        }

    # ---------- 2) 창고별 마스터 시트 ----------
    master = defaultdict(list)  # (wh, name) -> [row dict]
    colmap = None
    last_wh = ""
    for order, line in enumerate(lines):
        if ":-:" in line:
            colmap = None
            continue
        c = cells_of(line)
        if not c:
            continue
        if "상품명" in c:
            colmap = {h: k for k, h in enumerate(c) if h}
            continue
        if colmap is None or "[merged]" in line:
            continue
        g = lambda k: c[colmap[k]] if k in colmap and colmap[k] < len(c) else ""

        name = g("상품명")
        price = to_num(g("공급가"))
        if not name or price is None:
            continue

        wh = g("창고명") or last_wh
        if g("창고명"):
            last_wh = g("창고명")

        # 공급가 바로 오른쪽이 택배사, 그 다음이 택배비 (시트 열 구조 기준)
        pi = colmap["공급가"]
        master[(wh, name)].append({
            "price": price,
            "courier": c[pi + 1] if pi + 1 < len(c) else "",
            "fee": fee_of(c[pi + 2] if pi + 2 < len(c) else ""),
            "taxable": taxable_of(g("면과세")),
            "deadline": g("발주마감시간"),
            "expiry": g("유통기한"),
            "_line": order,
        })

    # ---------- 3) 병합 ----------
    items = []
    stats = {"변동사항적용": 0, "충돌": 0}

    for (wh, name), rows in master.items():
        prices = sorted({r["price"] for r in rows})
        base = rows[0]

        item = {
            "name": name,
            "warehouse": wh,
            "price": base["price"],
            "courier": base["courier"],
            "fee": base["fee"],
            "taxable": base["taxable"],
            "deadline": base["deadline"],
            "expiry": base["expiry"],
        }

        chg = changes.get((wh, name))
        if chg:
            item["price"] = chg["price"]
            item["fee"] = chg["fee"]
            item["taxable"] = chg["taxable"]
            if chg["courier"]:
                item["courier"] = chg["courier"]
            item["changedAt"] = chg["changedAt"]
            item["src"] = "변동사항"
            stats["변동사항적용"] += 1
        else:
            item["src"] = "마스터"

        # 같은 창고에서 단가가 갈리는데 변동사항으로도 확정 못한 경우 -> 경고
        if len(prices) > 1 and item["price"] not in (prices if chg else []):
            if not chg:
                item["alts"] = prices
                stats["충돌"] += 1

        items.append(item)

    # 변동사항에만 있고 마스터에 없는 상품도 추가
    for (wh, name), chg in changes.items():
        if (wh, name) in master or not wh:
            continue
        items.append({
            "name": name, "warehouse": wh, "price": chg["price"],
            "courier": chg["courier"], "fee": chg["fee"], "taxable": chg["taxable"],
            "deadline": "", "expiry": "", "changedAt": chg["changedAt"], "src": "변동사항",
        })

    items.sort(key=lambda x: (x["name"], x["warehouse"]))
    return items, stats


def main():
    if len(sys.argv) < 2:
        sys.exit("사용법: python parse_sheet.py <시트덤프.txt>")
    items, stats = parse(sys.argv[1])

    print("상품 %d개" % len(items))
    print("  변동사항 단가 적용 : %d" % stats["변동사항적용"])
    print("  단가 충돌(경고)    : %d" % stats["충돌"])
    for it in items:
        if it.get("alts"):
            print("    ⚠ %s(%s) %s" % (it["name"], it["warehouse"],
                                       " / ".join(f"{p:,}" for p in it["alts"])))

    stamp = "2026-07-27"
    with open(os.path.join(BASE, "products.json"), "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)

    body = json.dumps(items, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(BASE, "products.js"), "w", encoding="utf-8") as f:
        f.write(
            "// 자동 생성됨 - parse_sheet.py\n"
            "// 상품 %d개 · 기준일 %s\n"
            "window.PRODUCT_DATA = {\n"
            '  updatedAt: "%s",\n'
            '  source: "google-sheet",\n'
            "  items: %s\n};\n" % (len(items), stamp, stamp, body)
        )
    print("\nproducts.json / products.js 갱신 완료")


if __name__ == "__main__":
    main()
