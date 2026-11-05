/**
 * Остатки Яндекс Маркета: раскладка по типам и пагинация.
 *
 * Типы остатков у метода **пересекаются** — `FIT` («Годный») это `AVAILABLE`
 * плюс `FREEZE`, — и на живом API этого не увидеть: ответ выглядит как набор
 * независимых ведёрок. Поэтому поддельный метод отдаёт их так же, как живой, и
 * проба сторожит арифметику.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import '../src/tz.js';

process.env.YM_API_KEY = 'test-key';

const товар = (артикул, остатки) => ({ offerId: артикул, stocks: остатки });
const склад = (ид, имя, товары) => ({ warehouseId: ид, name: имя, offers: товары });

/**
 * Поддельный метод остатков.
 * `страницы` — по элементу на страницу, каждый со своим списком складов.
 * `токенНеДвигается` — метод отдаёт один и тот же `page_token` и ту же страницу:
 * так проверяется, что повторная страница не задваивает товар.
 * `справочник` — ответ `/v2/warehouses`: живой метод остатков названия склада
 * не отдаёт, только номер. `null` — справочник отвечает ошибкой.
 */
function поддельныйЯМ({ страницы, токенНеДвигается = false, безСкладов = false,
  справочник = [] }) {
  const запросы = [];
  const сервер = http.createServer((req, res) => {
    let сырое = '';
    req.on('data', (ч) => { сырое += ч; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/v2/warehouses') {
        if (справочник === null) {
          res.writeHead(403, { 'content-type': 'application/json' });
          return res.end('{"status":"ERROR"}');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ result: { warehouses: справочник } }));
      }
      запросы.push({ токен: u.searchParams.get('page_token'), лимит: u.searchParams.get('limit'),
        тело: сырое ? JSON.parse(сырое) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (безСкладов) return res.end(JSON.stringify({ result: { paging: {} } }));

      const н = токенНеДвигается ? 0 : запросы.length - 1;
      const склады = страницы[Math.min(н, страницы.length - 1)] || [];
      const ещё = токенНеДвигается || н < страницы.length - 1;
      return res.end(JSON.stringify({
        result: { warehouses: склады, paging: ещё ? { nextPageToken: 'Т1' } : {} },
      }));
    });
  });
  return { сервер, запросы };
}

async function собрать(настройки, сФбо = true) {
  const { сервер, запросы } = поддельныйЯМ(настройки);
  await new Promise((r) => сервер.listen(0, '127.0.0.1', r));
  process.env.YM_API_URL = `http://127.0.0.1:${сервер.address().port}`;
  const { ямОстаткиСтроки } = await import(`../src/yandex-lamoda.js?${Math.random()}`);
  try {
    return { ...(await ямОстаткиСтроки('12345', сФбо)), запросы };
  } finally {
    сервер.close();
  }
}

/** Строка без последней колонки «Обновлено» — она всегда текущее время. */
const безОтметки = (р) => р.slice(0, -1);
/** Остатки FBO без оборачиваемости и «Обновлено»: арифметика типов отдельно. */
const остатки = (р) => р.slice(0, 6);

test('AVAILABLE и FIT вместе — остаток не задваивается', async () => {
  // Живой ответ на десять свободных штук: AVAILABLE 10, FIT 10, FREEZE 0.
  // Сложить AVAILABLE с FIT значит написать в лист двадцать
  const { строки } = await собрать({ страницы: [[склад(1, 'Софьино', [
    товар('art-1', [
      { type: 'AVAILABLE', count: 10 },
      { type: 'FIT', count: 10 },
      { type: 'FREEZE', count: 0 },
    ]),
  ])]] });
  assert.equal(строки.length, 1);
  assert.deepEqual(остатки(строки[0]), ['art-1', 'Софьино', 10, 0, 0, 10]);
});

test('резерв, брак и карантин разложены по своим колонкам', async () => {
  const { строки } = await собрать({ страницы: [[склад(1, 'Софьино', [
    товар('art-2', [
      { type: 'AVAILABLE', count: 8 },
      { type: 'FIT', count: 10 },        // 8 свободных + 2 в резерве
      { type: 'FREEZE', count: 2 },
      { type: 'DEFECT', count: 1 },
      { type: 'QUARANTINE', count: 3 },
    ]),
  ])]] });
  // Доступно 8, Заморожено 2, Брак 1, Всего 10 годных + 1 брак + 3 карантина
  assert.deepEqual(остатки(строки[0]), ['art-2', 'Софьино', 8, 2, 1, 14]);
});

test('метод не дал AVAILABLE — доступное выводим из годного за вычетом резерва', async () => {
  const { строки } = await собрать({ страницы: [[склад(1, 'Софьино', [
    товар('art-3', [{ type: 'FIT', count: 10 }, { type: 'FREEZE', count: 4 }]),
  ])]] });
  assert.deepEqual(остатки(строки[0]), ['art-3', 'Софьино', 6, 4, 0, 10]);
});

test('метод не дал FIT — годное собираем из частей', async () => {
  const { строки } = await собрать({ страницы: [[склад(1, 'Софьино', [
    товар('art-4', [{ type: 'AVAILABLE', count: 7 }, { type: 'FREEZE', count: 3 }]),
  ])]] });
  assert.deepEqual(остатки(строки[0]), ['art-4', 'Софьино', 7, 3, 0, 10]);
});

test('страница, пришедшая повторно, не задваивает товар', async () => {
  // метод не двигает page_token и отдаёт ту же страницу снова. Проверка на
  // неподвижный токен стоит уже после того, как страница прочитана
  const { строки, запросы } = await собрать({
    токенНеДвигается: true,
    страницы: [[склад(1, 'Софьино', [
      товар('art-5', [{ type: 'AVAILABLE', count: 5 }, { type: 'FIT', count: 5 }]),
    ])]],
  });
  assert.equal(строки.length, 1, 'товар попал в лист дважды');
  assert.deepEqual(остатки(строки[0]), ['art-5', 'Софьино', 5, 0, 0, 5]);
  assert.ok(запросы.length >= 2, 'иначе случай собран неверно: повторной страницы не было');
});

test('несколько страниц — товары со всех, по одному разу', async () => {
  const { строки } = await собрать({ страницы: [
    [склад(1, 'Софьино', [товар('art-6', [{ type: 'FIT', count: 1 }])])],
    [склад(1, 'Софьино', [товар('art-7', [{ type: 'FIT', count: 2 }])]),
      склад(2, 'Томилино', [товар('art-8', [{ type: 'FIT', count: 3 }])])],
  ] });
  assert.deepEqual(строки.map((р) => [р[0], р[1], р[5]]),
    [['art-6', 'Софьино', 1], ['art-7', 'Софьино', 2], ['art-8', 'Томилино', 3]]);
});

test('нулевой остаток в лист не попадает', async () => {
  const { строки } = await собрать({ страницы: [[склад(1, 'Софьино', [
    товар('art-9', [{ type: 'AVAILABLE', count: 0 }, { type: 'FIT', count: 0 }]),
    товар('art-10', [{ type: 'FIT', count: 4 }]),
  ])]] });
  assert.deepEqual(строки.map((р) => р[0]), ['art-10']);
});

test('лист FBS собран по своей схеме: доступно и всего', async () => {
  const { строки, складов } = await собрать({ страницы: [[склад(9, 'Склад продавца', [
    товар('art-11', [
      { type: 'AVAILABLE', count: 6 }, { type: 'FIT', count: 8 }, { type: 'FREEZE', count: 2 },
    ]),
  ])]] }, false);
  assert.deepEqual(безОтметки(строки[0]), ['art-11', 'Склад продавца', 6, 8]);
  assert.equal(складов, 1);
});

test('артикул, который Таблицы переиначат, уходит текстом', async () => {
  const { строки } = await собрать({ страницы: [[склад(1, 'Софьино', [
    товар('12-31', [{ type: 'FIT', count: 1 }]),
  ])]] });
  assert.equal(строки[0][0], "'12-31", 'размер 12-31 станет в книге датой');
});

test('ответ без списка складов — ошибка, а не пустой успех', async () => {
  await assert.rejects(() => собрать({ страницы: [], безСкладов: true }),
    /без списка складов/);
});

test('название склада FBY берётся из справочника: в остатках только номер', async () => {
  const { строки, заметка } = await собрать({
    справочник: [{ id: 305, name: 'Софьино' }, { id: 147, name: 'Ростов' }],
    страницы: [[
      { warehouseId: 305, offers: [товар('art-20', [{ type: 'FIT', count: 2 }])] },
      { warehouseId: 147, offers: [товар('art-21', [{ type: 'FIT', count: 3 }])] },
    ]],
  });
  assert.deepEqual(строки.map((р) => [р[0], р[1]]), [['art-20', 'Софьино'], ['art-21', 'Ростов']]);
  assert.equal(заметка, '');
});

test('справочник складов не ответил — номер вместо названия и причина в отчёте', async () => {
  const { строки, заметка } = await собрать({
    справочник: null,
    страницы: [[{ warehouseId: 305, offers: [товар('art-22', [{ type: 'FIT', count: 1 }])] }]],
  });
  assert.equal(строки[0][1], '305');
  assert.match(заметка, /названия складов не получены/);
});

test('оборачиваемость FBY: дни и оценка Маркета в своих колонках', async () => {
  const { строки, запросы } = await собрать({ страницы: [[склад(1, 'Софьино', [
    { ...товар('art-23', [{ type: 'FIT', count: 4 }]),
      turnoverSummary: { turnover: 'ALMOST_LOW', turnoverDays: 104.27 } },
    товар('art-24', [{ type: 'FIT', count: 1 }]),
  ])]] });
  assert.deepEqual(безОтметки(строки[0]), ['art-23', 'Софьино', 4, 0, 0, 4, 104.3, 'почти низкая']);
  assert.deepEqual(безОтметки(строки[1]).slice(6), ['', '-'], 'нет данных — пусто, а не ноль дней');
  assert.equal(запросы[0].тело.withTurnover, true, 'без withTurnover метод оборачиваемость не отдаёт');
  assert.equal(запросы[0].лимит, '100', 'больше сотни метод молча обрезает');
});

test('FBS: оборачиваемость не запрашивается, схема прежняя', async () => {
  const { строки, запросы } = await собрать({ страницы: [[склад(9, 'Склад продавца', [
    товар('art-25', [{ type: 'FIT', count: 2 }]),
  ])]] }, false);
  assert.equal(строки[0].length, 5);
  assert.equal(запросы[0].тело.withTurnover, undefined);
});
