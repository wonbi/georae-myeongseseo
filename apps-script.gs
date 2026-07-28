/**
 * 거래명세서 웹앱용 - 구글시트 상품정보 API
 * ---------------------------------------------------------------
 * [설치 방법]
 *  1. 상품 구글시트 열기 → 확장 프로그램 → Apps Script
 *  2. 아래 코드 전체를 붙여넣고 저장
 *  3. 우측 상단 [배포] → [새 배포] → 유형 [웹 앱]
 *       - 실행 계정 : 나
 *       - 액세스 권한 : 모든 사용자
 *  4. 배포 후 나오는 "웹 앱 URL"(.../exec)을 복사
 *  5. 거래명세서 웹앱 → [↻ 상품 새로고침] → 연동 주소에 붙여넣기 → [지금 가져오기]
 *
 *  이후에는 새로고침 버튼만 누르면 최신 단가가 반영됩니다.
 * ---------------------------------------------------------------
 *
 * [단가 결정 규칙] - parse_sheet.py 와 동일하게 맞춰져 있습니다
 *  1. '변동공지(변동사항)' 시트에 있으면 그 값이 최우선.
 *     같은 상품이 여러 번 나오면 적용날짜 > 기재날짜 > 시트 등장순 으로 최신 행을 택합니다
 *  2. 없으면 창고별 마스터 시트 값
 *  3. 상품은 (창고명, 상품명) 으로 구분합니다. 창고가 다르면 동명이품이라도 별개 상품입니다
 *  4. 같은 창고 안에서 단가가 갈리는데 변동공지로도 확정 못하면 alts 에 후보를 모두 담습니다
 */

// 상품 목록이 아예 없는 시트는 건너뜁니다.
var SKIP_SHEETS = ['공지', '읽어주세요'];

// 이 문구가 시트 이름에 들어 있으면 '변동사항' 시트로 봅니다.
var CHANGE_HINTS = ['변동공지', '변동사항'];

// (창고명, 상품명) 합성 키. 상품명에 공백이 있어 공백은 구분자로 못 씁니다
var SEP = '\u0000';

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();

  var changes = readChanges(sheets);
  var master = readMaster(sheets);
  var items = merge(master, changes);

  var body = JSON.stringify({
    updatedAt: Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'),
    count: items.length,
    items: items
  });

  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- 1) 변동공지 시트 ---------------- */

function readChanges(sheets) {
  var changes = {}; // key -> {price, fee, courier, taxable, changedAt, _rank}
  var order = 0;

  sheets.forEach(function (sheet) {
    if (!isChangeSheet(sheet.getName())) return;

    var values = sheet.getDataRange().getDisplayValues();
    var col = headerOf(values, ['창고명변동']);
    if (!col) return;

    for (var r = col._row + 1; r < values.length; r++) {
      var g = cellGetter(values[r], col);
      order++;

      var name = g('상품명변동') || g('상품명');
      var price = toNum(g('공급가변동(공급가)') || g('공급가변동') || g('공급가'));
      if (!name || !price) continue;

      var wh = g('창고명변동') || g('창고명');
      var key = wh + SEP + name;
      var rank = [normDate(g('적용날짜')), normDate(g('기재날짜')), order];

      var prev = changes[key];
      if (prev && cmpRank(prev._rank, rank) >= 0) continue;

      changes[key] = {
        _rank: rank,
        price: price,
        fee: feeOf(g('택배비변동') || g('택배비')),
        courier: g('택배사'),
        taxable: taxableOf(g('면과세변동') || g('면과세')),
        changedAt: String(g('적용날짜')).replace(/\s+/g, '')
      };
    }
  });

  return changes;
}

/* ---------------- 2) 창고별 마스터 시트 ---------------- */

function readMaster(sheets) {
  var master = {}; // key -> [row, ...]

  sheets.forEach(function (sheet) {
    var title = sheet.getName();
    if (SKIP_SHEETS.indexOf(title) >= 0 || isChangeSheet(title)) return;

    var values = sheet.getDataRange().getDisplayValues();
    var col = headerOf(values, ['상품명', '공급가']);
    if (!col) return;

    var lastWarehouse = '';

    for (var r = col._row + 1; r < values.length; r++) {
      var row = values[r];
      var g = cellGetter(row, col);

      var name = g('상품명');
      var price = toNum(g('공급가'));
      if (!name || name === '상품명' || !price) continue;

      // 창고명 칸이 비어 있으면 위쪽 값을 이어받습니다(병합 셀 대응)
      var wh = g('창고명');
      if (wh) lastWarehouse = wh; else wh = lastWarehouse;

      // 택배사·택배비는 이름으로 찾고, 없으면 공급가 오른쪽 두 칸을 씁니다
      var pi = col['공급가'];
      var courier = '택배사' in col ? g('택배사') : String(row[pi + 1] || '').trim();
      var feeTxt = '택배비' in col ? g('택배비') : String(row[pi + 2] || '');

      var key = (wh || title) + SEP + name;
      (master[key] = master[key] || []).push({
        price: price,
        courier: courier,
        fee: feeOf(feeTxt),
        taxable: taxableOf(g('면과세')),
        deadline: g('발주마감시간'),
        expiry: g('유통기한')
      });
    }
  });

  return master;
}

/* ---------------- 3) 병합 ---------------- */

function merge(master, changes) {
  var items = [];
  var seen = {};

  Object.keys(master).forEach(function (key) {
    var rows = master[key];
    var parts = key.split(SEP);
    var base = rows[0];

    var item = {
      name: parts[1],
      warehouse: parts[0],
      price: base.price,
      courier: base.courier,
      fee: base.fee,
      taxable: base.taxable,
      deadline: base.deadline,
      expiry: base.expiry,
      src: '마스터'
    };

    var chg = changes[key];
    if (chg) {
      item.price = chg.price;
      item.fee = chg.fee;
      item.taxable = chg.taxable;
      if (chg.courier) item.courier = chg.courier;
      item.changedAt = chg.changedAt;
      item.src = '변동사항';
    } else {
      // 같은 창고 안에서 단가가 갈리는데 변동공지로도 확정 못한 경우
      var prices = uniqSorted(rows);
      if (prices.length > 1) item.alts = prices;
    }

    seen[key] = true;
    items.push(item);
  });

  // 변동공지에만 있고 마스터에는 없는 상품도 넣어줍니다
  Object.keys(changes).forEach(function (key) {
    if (seen[key]) return;
    var parts = key.split(SEP);
    if (!parts[0]) return;
    var chg = changes[key];
    items.push({
      name: parts[1],
      warehouse: parts[0],
      price: chg.price,
      courier: chg.courier,
      fee: chg.fee,
      taxable: chg.taxable,
      deadline: '',
      expiry: '',
      changedAt: chg.changedAt,
      src: '변동사항'
    });
  });

  items.sort(function (a, b) {
    return a.name < b.name ? -1 : a.name > b.name ? 1
      : a.warehouse < b.warehouse ? -1 : a.warehouse > b.warehouse ? 1 : 0;
  });

  return items;
}

/* ---------------- 공통 ---------------- */

function isChangeSheet(title) {
  for (var i = 0; i < CHANGE_HINTS.length; i++) {
    if (title.indexOf(CHANGE_HINTS[i]) >= 0) return true;
  }
  return false;
}

/** 필요한 머리글이 모두 있는 행을 찾아 {머리글: 열번호, _row: 행번호} 를 돌려줍니다 */
function headerOf(values, required) {
  var limit = Math.min(values.length, 30);
  for (var r = 0; r < limit; r++) {
    var col = {};
    values[r].forEach(function (h, c) {
      h = norm(h);
      if (h && !(h in col)) col[h] = c;
    });
    var ok = required.every(function (k) { return k in col; });
    if (ok) { col._row = r; return col; }
  }
  return null;
}

function cellGetter(row, col) {
  return function (key) {
    return key in col && col[key] < row.length ? String(row[col[key]] || '').trim() : '';
  };
}

/** 머리글 표기 흔들림 흡수 : '적용 날짜' -> '적용날짜', '공급가변동 (공급가)' -> '공급가변동(공급가)' */
function norm(h) {
  return String(h == null ? '' : h).replace(/\s+/g, '');
}

/** "12,000 > 13,000" → "13,000" (변경된 최신 값) */
function lastVal(v) {
  var parts = String(v == null ? '' : v).split('>');
  return parts[parts.length - 1].trim();
}

function toNum(v) {
  var t = lastVal(v).replace(/,/g, '');
  return /^\d+$/.test(t) ? parseInt(t, 10) : 0;
}

function feeOf(v) {
  var raw = lastVal(v);
  return raw.indexOf('무료') >= 0 ? 0 : toNum(raw);
}

function taxableOf(v) {
  v = String(v || '');
  return v.indexOf('과세') >= 0 && v.indexOf('면세') < 0;
}

/**
 * '2026. 07. 24' -> '20260724' (비교 가능한 형태)
 *
 * 연도가 없는 '09월30일' 같은 표기는 일부러 빈 값으로 둡니다.
 * 월일(4자리)만으로 비교하면 해가 바뀌는 순간 1월 행이 전년 10월 행보다
 * 오래된 것으로 잡혀 옛 단가가 되살아납니다. 이 경우 시트 등장순
 * (아래쪽 행이 최신)으로 판단하게 두는 편이 안전합니다.
 */
function normDate(s) {
  var d = String(s == null ? '' : s).replace(/\D/g, '');
  return d.length === 8 ? d : '';
}

function cmpRank(a, b) {
  for (var i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function uniqSorted(rows) {
  var out = [];
  rows.forEach(function (r) {
    if (out.indexOf(r.price) < 0) out.push(r.price);
  });
  return out.sort(function (x, y) { return x - y; });
}
