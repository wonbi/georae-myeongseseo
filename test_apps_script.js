// apps-script.gs 로직 검증 - 가짜 SpreadsheetApp 을 물려 doGet 결과를 확인한다
const fs = require('fs');
const path = require('path');

const SRC = path.join('/home/user/georae-myeongseseo', 'apps-script.gs');

function makeSheet(name, rows) {
  return {
    getName: () => name,
    getDataRange: () => ({ getDisplayValues: () => rows }),
  };
}

const SHEETS = [
  // 창고별 마스터 시트
  makeSheet('[상품] 3. 상품목록', [
    ['창고명', '상품명', '공급가', '택배사', '택배비', '면과세', '발주마감시간', '유통기한'],
    // 같은 이름, 다른 창고 -> 둘 다 살아남아야 함
    ['하남', '맛상 미니족발 300g', '3,000', '롯데택배', '4000', '과세', '오전마감 : 10시', ''],
    ['이성', '맛상 미니족발 300g', '5,500', '씨제이대한통운', '4000', '면세', '', ''],
    // 같은 창고 안에서 단가가 갈림 -> alts
    ['제수', '토막 은갈치 대짜 350g급', '14,000', '롯데택배', '4000', '면세', '', ''],
    ['제수', '토막 은갈치 대짜 350g급', '16,600', '롯데택배', '4000', '면세', '', ''],
    // 창고명 병합 셀 (빈 칸은 위 값 이어받기)
    ['', '왕 바지락 1kg', '4,000', '씨제이대한통운', '무료배송', '면세', '', ''],
    // "12,000 > 13,000" 표기 -> 뒤쪽 값
    ['창원', '원뿔 한우 꽃등심 200g', '18,000 > 18,500', '롯데택배', '4000', '과세', '', ''],
    // 변동공지로 덮어써질 상품
    ['하남', '맛상 쯔란 1팩', '1,800', '롯데택배', '4000', '과세', '', ''],
  ]),

  // 변동공지 시트 - 마스터보다 우선
  makeSheet('[상품] 2. 변동공지', [
    ['구분', '기재 날짜', '적용날짜', '변동', '상시/당일', '유통기한',
     '창고명변동', '상품명', '공급가변동 (공급가)', '택배사', '원가', '택배비변동', '면과세변동'],
    ['하남/마스터', '10월01일', '10월01일', '인하', '상시', '',
     '하남', '맛상 쯔란 1팩', '1,800 > 1,000', '롯데택배', '', '4,000', '과세'],
    // 같은 상품이 뒤에 또 나옴 -> 아래쪽(최신) 행이 이겨야 함
    ['하남/마스터', '10월05일', '10월05일', '인상', '상시', '',
     '하남', '맛상 쯔란 1팩', '1,200', '롯데택배', '', '무료배송', '과세'],
    // 마스터에 없는 상품 -> 새로 추가돼야 함
    ['단독/마스터', '10월01일', '10월01일', '출시', '당일', '',
     '단독', '활 홍가리비 1kg', '3,000 > 2,800', '씨제이대한통운', '', '4,000', '면세'],
  ]),

  // 상품 목록이 아닌 시트 - 건너뛰어야 함
  makeSheet('[상품] 1. 수량요청', [
    ['날짜', '담당', '창고', '요청상품명', '요청수량'],
    ['07월28일', '마찬', '진수', '활 흰다리새우 500g', '1'],
  ]),
];

// --- Apps Script 런타임 흉내 ---
global.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheets: () => SHEETS }) };
global.Utilities = { formatDate: () => '2026-07-28' };
let captured = null;
global.ContentService = {
  MimeType: { JSON: 'json' },
  createTextOutput: (t) => { captured = t; return { setMimeType: () => ({ body: t }) }; },
};

eval(fs.readFileSync(SRC, 'utf8'));
doGet({});
const out = JSON.parse(captured);

// --- 검증 ---
let fail = 0;
const find = (wh, name) => out.items.find((i) => i.warehouse === wh && i.name === name);
const check = (label, cond, got) => {
  if (cond) { console.log('  PASS  ' + label); }
  else { console.log('  FAIL  ' + label + '  ->  ' + JSON.stringify(got)); fail++; }
};

console.log(`상품 ${out.count}개\n`);

const hanam = find('하남', '맛상 미니족발 300g');
const iseong = find('이성', '맛상 미니족발 300g');
check('창고가 다른 동명 상품이 둘 다 남는다', hanam && iseong, { hanam, iseong });
check('  하남 3,000 유지', hanam && hanam.price === 3000, hanam);
check('  이성 5,500 유지', iseong && iseong.price === 5500, iseong);

const galchi = find('제수', '토막 은갈치 대짜 350g급');
check('같은 창고 단가 충돌은 alts 로 표시',
  galchi && JSON.stringify(galchi.alts) === JSON.stringify([14000, 16600]), galchi);

const bajirak = find('제수', '왕 바지락 1kg');
check('창고명 빈 칸은 위 값을 이어받는다', !!bajirak, out.items.map((i) => i.warehouse + '/' + i.name));
check('  무료배송 -> 택배비 0', bajirak && bajirak.fee === 0, bajirak);

const deungsim = find('창원', '원뿔 한우 꽃등심 200g');
check('"18,000 > 18,500" 은 뒤쪽 값', deungsim && deungsim.price === 18500, deungsim);
check('  과세 판정', deungsim && deungsim.taxable === true, deungsim);

const jjuran = find('하남', '맛상 쯔란 1팩');
check('변동공지가 마스터를 덮어쓴다', jjuran && jjuran.src === '변동사항', jjuran);
check('  같은 상품은 아래쪽(최신) 행이 이긴다 -> 1,200', jjuran && jjuran.price === 1200, jjuran);
check('  변동공지의 무료배송도 반영 -> 0', jjuran && jjuran.fee === 0, jjuran);

const hong = find('단독', '활 홍가리비 1kg');
check('변동공지에만 있는 상품도 추가된다', hong && hong.price === 2800, hong);
check('  면세 판정', hong && hong.taxable === false, hong);

check('상품목록이 아닌 시트는 건너뛴다',
  !out.items.some((i) => i.name === '활 흰다리새우 500g'), out.items.map((i) => i.name));

console.log(fail ? `\n실패 ${fail}건` : '\n전부 통과');
process.exit(fail ? 1 : 0);
