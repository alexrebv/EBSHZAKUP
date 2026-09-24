import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import '../src/tz.js';

process.env.WB_ANALYTICS_KEY = 'test-key';
process.env.WB_MARKET_KEY = 'test-key';

const серийно = (г, м, д) => (Date.UTC(г, м - 1, д) - Date.UTC(1899, 11, 30)) / 86400000;
const сутки = 24 * 3600 * 1000;

function возврат(i, дата) {
  return {
    srid: `srid-${i}`, orderId: 100000 + i,
    barcode: `468000000000${i % 3}`, nmId: 200000 + i,
    shkId: 17000000000 + i, stickerId: `4680${i}`,
    subjectName: 'Платье', brand: 'Марка', techSize: ['42', '12-31', '0042'][i % 3],
    reason: 'Брак', returnType: 'Возврат', status: 'Выдан', isStatusActive: 1,
    orderDt: дата, readyToReturnDt: дата, completedDt: дата, expiredDt: дата,
    dstOfficeAddress: 'Москва, ПВЗ', dstOfficeId: 5000 + i,
  };
}

/** Поддельный сервис: держит предел в 31 день и отдаёт по возврату на окно. */
function поддельныйВБ({ предел = 31, пустойОтвет = false } = {}) {
  const окна = [];
  const сервер = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.includes('cards/list')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ cards: [{
        nmID: 200000, vendorCode: '025-12-31',
        sizes: [{ chrtID: 1, skus: ['4680000000000'] }, { chrtID: 2, skus: ['4680000000001'] }],
      }], cursor: { total: 1 } }));
    }
    const от = u.searchParams.get('dateFrom');
    const до = u.searchParams.get('dateTo');
    const дней = Math.round((new Date(до) - new Date(от)) / сутки) + 1;
    окна.push({ от, до, дней });
    if (дней > предел) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ title: 'too long', detail: `период ${дней} дней` }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (пустойОтвет) return res.end('{}');
    res.end(JSON.stringify({ report: [возврат(окна.length, `${от}T11:33:53`)] }));
  });
  return { сервер, окна };
}

async function собрать(задача = {}, опции = {}) {
  const { сервер, окна } = поддельныйВБ(опции);
  await new Promise((r) => сервер.listen(0, '127.0.0.1', r));
  const адрес = `http://127.0.0.1:${сервер.address().port}`;
  process.env.WB_ANALYTICS_URL = адрес;
  process.env.WB_CONTENT_URL = адрес;
  try {
    const m = await import(`../src/wb-ozon.js?${Math.random()}`);
    return { ...(await m.wbВозвратыСтроки(задача)), окна };
  } finally {
    сервер.close();
  }
}

test('период режется на окна не длиннее предела метода', async () => {
  // 100 суток назад: должно выйти четыре окна по 30 суток
  const с = серийно(2026, 6, 15);
  const { окна, окон } = await собрать({ сдаты: с });
  assert.ok(окна.length >= 3, `окон ${окна.length}`);
  assert.equal(окон, окна.length);
  for (const о of окна) assert.ok(о.дней <= 31, `окно ${о.от}—${о.до} длиной ${о.дней} суток`);
});

test('окна идут подряд, без разрывов и нахлёстов', async () => {
  const { окна } = await собрать({ сдаты: серийно(2026, 7, 1) });
  for (let i = 1; i < окна.length; i += 1) {
    const разрыв = Math.round((new Date(окна[i].от) - new Date(окна[i - 1].до)) / сутки);
    assert.equal(разрыв, 1, `между окнами ${окна[i - 1].до} и ${окна[i].от} разрыв ${разрыв}`);
  }
});

test('без «С даты» берём одно последнее окно', async () => {
  const { окна } = await собрать({});
  assert.equal(окна.length, 1);
  assert.ok(окна[0].дней <= 31);
});

test('артикул продавца подставляется из карточек и уходит текстом', async () => {
  const { строки, безКарточки } = await собрать({ сдаты: серийно(2026, 9, 1) });
  const свой = строки.find((р) => р[3] !== '-');
  assert.ok(свой, 'ни один артикул не нашёлся в карточках');
  assert.equal(свой[3], "'025-12-31", 'артикул-дата ушёл без пометки «текст»');
  assert.equal(typeof безКарточки, 'number');
});

test('размер вида «12-31» не станет датой', async () => {
  const { строки } = await собрать({ сдаты: серийно(2026, 6, 15) });
  for (const р of строки) {
    if (String(р[9]).replace(/^'/, '') === '12-31') {
      assert.equal(р[9], "'12-31", 'размер ушёл без пометки «текст»');
    }
  }
});

test('строка собрана по схеме', async () => {
  const { строки } = await собрать({ сдаты: серийно(2026, 9, 1) });
  const [п] = строки;
  assert.equal(п.length, 21);
  assert.match(п[0], /^srid-/);
  assert.equal(п[13], 'да');                 // Активен
  assert.match(п[14], /^\d{2}\.\d{2}\.\d{4}/); // Дата заказа
  assert.equal(п[18], 'Москва, ПВЗ');
});

test('ответ без отчёта — ошибка, а не пустой успех', async () => {
  await assert.rejects(() => собрать({ сдаты: серийно(2026, 9, 1) }, { пустойОтвет: true }),
    /ответил без отчёта/);
});

test('«С даты» в будущем — понятная ошибка', async () => {
  await assert.rejects(() => собрать({ сдаты: серийно(2027, 1, 1) }),
    /позже сегодняшнего дня/);
});
