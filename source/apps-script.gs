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
 */

// 상품 목록이 없는 시트는 건너뜁니다.
var SKIP_SHEETS = ['상품 변동사항', '변동사항', '공지', '읽어주세요'];

function doGet(e) {
  var out = [];
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  ss.getSheets().forEach(function (sheet) {
    var title = sheet.getName();
    if (SKIP_SHEETS.indexOf(title) >= 0) return;

    var values = sheet.getDataRange().getDisplayValues();
    if (!values.length) return;

    // '상품명' 이 들어있는 행을 헤더로 인식
    var head = -1, col = {};
    for (var r = 0; r < Math.min(values.length, 30); r++) {
      var row = values[r];
      for (var c = 0; c < row.length; c++) {
        if (String(row[c]).trim() === '상품명') { head = r; break; }
      }
      if (head >= 0) {
        row.forEach(function (h, c) {
          h = String(h).trim();
          if (h && !(h in col)) col[h] = c;
        });
        break;
      }
    }
    if (head < 0) return;

    var priceCol = col['공급가'];
    if (priceCol === undefined) return;

    var lastWarehouse = '';
    for (var r = head + 1; r < values.length; r++) {
      var row = values[r];
      var name = String(row[col['상품명']] || '').trim();
      if (!name || name === '상품명') continue;

      var priceTxt = lastVal(row[priceCol]);
      var price = toNum(priceTxt);
      if (!price) continue;

      // 공급가 바로 오른쪽 = 택배사, 그 다음 = 택배비 (시트 구조 기준)
      var courier = String(row[priceCol + 1] || '').trim();
      var feeTxt = lastVal(row[priceCol + 2]);

      var wh = String(row[col['창고명']] || '').trim();
      if (wh) lastWarehouse = wh; else wh = lastWarehouse;

      var tax = String(row[col['면과세']] || '').trim();

      out.push({
        name: name,
        warehouse: wh || title,
        price: price,
        courier: courier,
        fee: /무료/.test(feeTxt) ? 0 : toNum(feeTxt),
        taxable: tax.indexOf('과세') >= 0 && tax.indexOf('면세') < 0,
        deadline: String(row[col['발주마감시간']] || '').trim()
      });
    }
  });

  // 상품명 중복 제거 (뒤에 나온 값 우선)
  var map = {};
  out.forEach(function (p) { map[p.name] = p; });
  var items = Object.keys(map).sort().map(function (k) { return map[k]; });

  var body = JSON.stringify({
    updatedAt: Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'),
    count: items.length,
    items: items
  });

  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

/** "12,000 > 13,000" → "13,000" (변경된 최신 값) */
function lastVal(v) {
  var parts = String(v == null ? '' : v).split('>');
  return parts[parts.length - 1].trim();
}

function toNum(v) {
  var n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return isNaN(n) ? 0 : n;
}
