/**
 * Заказы и поставки Яндекс Маркета.
 *
 * Заказы идут новым методом кабинета `POST /v1/businesses/{id}/orders`: старый
 * метод кампании отключается 12.04.2027. Склад FBY у заказа есть только в
 * статистике заказов, название склада — только в справочнике складов Маркета.
 * Три метода сходятся в одну строку листа, и проба сторожит именно стык.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import '../src/tz.js';

process.env.YM_API_KEY = 'test-key';
delete process.env.YM_BUSINESS_ID;

const КАМПАНИЯ = '12345';
const КАБИНЕТ = 777;
const ДЕНЬ = 24 * 3600 * 1000;

const дней = (n) => new Date(Date.now() - n * ДЕНЬ);
const isoМск = (д) => {
  const п = (x) => String(x).padStart(2, '0');
  return `${д.getFullYear()}-${п(д.getMonth() + 1)}-${п(д.getDate())}T12:00:00+03:00`;
};

const заказ = (ид, когда, товары, доставка = {}) => ({
  orderId: ид, campaignId: Number(КАМПАНИЯ), status: 'DELIVERED',
  substatus: 'DELIVERY_SERVICE_DELIVERED', creationDate: isoМск(когда), fake: false,
  items: товары, delivery: { type: 'PICKUP', ...доставка },
});
const позиция = (артикул, шт, оплачено, баллы = 0) => ({
  id: 1, offerId: артикул, offerName: артикул, count: шт,
  prices: { payment: { value: оплачено, currencyId: 'RUR' },
    cashback: { value: баллы, currencyId: 'RUR' } },
});

/**
 * Поддельный Маркет.
 * `заказы` — все заказы кабинета; метод отдаёт те, что попали в окно запроса,
 * по `на_странице` за раз. `склады` — номер заказа → склад в статистике.
 */
function поддельныйМаркет({
  заказы = [], склады = {}, справочник = [{ id: 305, name: 'Софьино' }],
  статистикаЛомается = false, безСписка = false, курсорСтоит = false, на_странице = 50,
  заявки = [], товарыЗаявок = {},
} = {}) {
  const журнал = [];
  const сервер = http.createServer((req, res) => {
    let сырое = '';
    req.on('data', (ч) => { сырое += ч; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const тело = сырое ? JSON.parse(сырое) : null;
      журнал.push({ путь: u.pathname, метод: req.method, тело, токен: u.searchParams.get('page_token') });
      const ответ = (код, данные) => {
        res.writeHead(код, { 'content-type': 'application/json' });
        res.end(JSON.stringify(данные));
      };

      if (u.pathname === `/v2/campaigns/${КАМПАНИЯ}`) {
        return ответ(200, { campaign: { id: Number(КАМПАНИЯ), business: { id: КАБИНЕТ } } });
      }
      if (u.pathname === '/v2/warehouses') return ответ(200, { result: { warehouses: справочник } });

      if (u.pathname === `/v1/businesses/${КАБИНЕТ}/orders`) {
        if (безСписка) return ответ(200, { paging: {} });
        const { creationDateFrom: от, creationDateTo: до } = тело.dates;
        const в_окне = заказы.filter((з) => {
          const день = з.creationDate.slice(0, 10);
          return день >= от && день < до;
        });
        const с = Number(u.searchParams.get('page_token') || 0);
        const пачка = в_окне.slice(с, с + на_странице);
        const ещё = с + на_странице < в_окне.length;
        const след = курсорСтоит ? '0' : String(с + на_странице);
        return ответ(200, { orders: пачка, paging: ещё || курсорСтоит ? { nextPageToken: след } : {} });
      }

      if (u.pathname === `/v2/campaigns/${КАМПАНИЯ}/stats/orders`) {
        if (статистикаЛомается) return ответ(403, { status: 'ERROR', errors: [{ code: 'FORBIDDEN' }] });
        const стат = заказы.map((з) => ({
          id: з.orderId,
          items: [
            ...з.items.map((т) => ({ shopSku: т.offerId, count: т.count,
              warehouse: склады[з.orderId] || undefined,
              prices: [{ type: 'BUYER', costPerItem: 999 }] })),
            { offerName: 'Доставка' },
          ],
        })).filter((з) => склады[з.id] !== undefined);
        return ответ(200, { result: { orders: стат, paging: {} } });
      }

      if (u.pathname === `/v2/campaigns/${КАМПАНИЯ}/supply-requests`) {
        return ответ(200, { result: { requests: заявки, paging: {} } });
      }
      if (u.pathname === `/v2/campaigns/${КАМПАНИЯ}/supply-requests/items`) {
        return ответ(200, { result: { items: товарыЗаявок[тело.requestId] || [], paging: {} } });
      }
      return ответ(404, { status: 'ERROR' });
    });
  });
  return { сервер, журнал };
}

async function запустить(настройки, что) {
  const { сервер, журнал } = поддельныйМаркет(настройки);
  await new Promise((r) => сервер.listen(0, '127.0.0.1', r));
  process.env.YM_API_URL = `http://127.0.0.1:${сервер.address().port}`;
  const модуль = await import(`../src/yandex-lamoda.js?${Math.random()}`);
  try {
    return { ...(await что(модуль)), журнал };
  } finally {
    сервер.close();
  }
}

const задача = (глубина) => ({ имя: 'Заказы Яндекс FBO', глубина, сдаты: '', успешный: null });
const заказать = (настройки, глубина = 10) =>
  запустить(настройки, (м) => м.ямЗаказыСтроки(КАМПАНИЯ, задача(глубина)));
const безОтметки = (р) => р.slice(0, -1);

test('окна стыкуются встык и не длиннее 30 суток: конец окна в интервал не входит', async () => {
  const { окнаЯМ } = await import(`../src/yandex-lamoda.js?${Math.random()}`);
  const с = new Date(2026, 6, 1, 15, 30);
  const по = new Date(2026, 8, 20, 9, 0);
  const окна = окнаЯМ(с, по);
  assert.deepEqual(окна[0][0], new Date(2026, 6, 1));
  assert.deepEqual(окна.at(-1)[1], new Date(2026, 8, 21), 'последний день периода потерян');
  for (let i = 0; i < окна.length; i += 1) {
    assert.ok((окна[i][1] - окна[i][0]) / ДЕНЬ <= 30, `окно ${i} длиннее 30 суток`);
    if (i) assert.deepEqual(окна[i][0], окна[i - 1][1], `между окнами ${i - 1} и ${i} дыра`);
  }
});

test('заказы идут методом кабинета: кабинет по кампании, без тестовых, окна без дыр', async () => {
  const { журнал, окон } = await заказать({ заказы: [] }, 60);
  const запросы = журнал.filter((з) => з.путь === `/v1/businesses/${КАБИНЕТ}/orders`);
  assert.ok(журнал.some((з) => з.путь === `/v2/campaigns/${КАМПАНИЯ}` && з.метод === 'GET'));
  assert.equal(запросы.length, окон);
  assert.ok(окон >= 3, 'шестьдесят дней одним окном метод не примет');
  for (const з of запросы) {
    assert.equal(з.метод, 'POST');
    assert.deepEqual(з.тело.campaignIds, [Number(КАМПАНИЯ)]);
    assert.equal(з.тело.fake, false);
  }
  for (let i = 1; i < запросы.length; i += 1) {
    assert.equal(запросы[i].тело.dates.creationDateFrom, запросы[i - 1].тело.dates.creationDateTo);
  }
});

test('строка заказа: цена за штуку, регион, склад FBY по справочнику', async () => {
  const { строки, заметка } = await заказать({
    заказы: [
      заказ(1001, дней(2), [позиция('Black_29', 2, 5000, 400)],
        { pickup: { region: { id: 1, name: 'Москва', type: 'CITY' } } }),
      заказ(1002, дней(1), [позиция('12-31', 1, 2500)],
        { courier: { address: { city: 'Тула' } } }),
    ],
    склады: { 1001: { id: 305, name: 'Склад 305 из статистики' }, 1002: { id: 147, name: 'Ростов' } },
  });
  const поЗаказу = Object.fromEntries(строки.map((р) => [р[0], безОтметки(р)]));
  assert.deepEqual(поЗаказу['1001'].slice(2),
    ['Black_29', 2, 2700, 'DELIVERED', 'DELIVERY_SERVICE_DELIVERED', 'Москва', 'Софьино']);
  assert.equal(поЗаказу['1002'][2], "'12-31", 'размер 12-31 станет в книге датой');
  assert.equal(поЗаказу['1002'][7], 'Тула');
  assert.equal(поЗаказу['1002'][8], 'Ростов', 'склада нет в справочнике — имя из статистики');
  assert.match(поЗаказу['1001'][1], /^\d{2}\.\d{2}\.\d{4} 12:00:00$/);
  assert.equal(заметка, '');
});

test('заказа ещё нет в статистике — склад прочерком, и это видно в отчёте', async () => {
  const { строки, заметка } = await заказать({
    заказы: [заказ(2001, дней(1), [позиция('art', 1, 100)])],
    склады: {},
  });
  assert.equal(строки[0][8], '-');
  assert.match(заметка, /без склада 1/);
});

test('статистика недоступна — заказы всё равно пишутся, причина в отчёте', async () => {
  const { строки, заметка } = await заказать({
    заказы: [заказ(3001, дней(1), [позиция('art', 1, 100)])],
    статистикаЛомается: true,
  });
  assert.equal(строки.length, 1);
  assert.match(заметка, /склады не получены/);
});

test('цены в заказе нет — берём цену покупателя из статистики', async () => {
  const без = { ...позиция('art', 1, 0), prices: {} };
  const { строки } = await заказать({
    заказы: [заказ(4001, дней(1), [без])],
    склады: { 4001: { id: 305 } },
  });
  assert.equal(строки[0][4], 999);
});

test('много страниц — все заказы по разу', async () => {
  const заказы = Array.from({ length: 120 }, (_, i) =>
    заказ(5000 + i, дней(1 + (i % 5)), [позиция(`a${i}`, 1, 100)]));
  const { строки } = await заказать({ заказы, на_странице: 50 });
  assert.equal(new Set(строки.map((р) => р[0])).size, 120);
  assert.equal(строки.length, 120);
});

test('ответ без списка заказов — ошибка, а не пустой успех', async () => {
  await assert.rejects(() => заказать({ безСписка: true }), /без списка «orders»/);
});

test('курсор не двигается — падаем, а не пишем первую страницу как всё', async () => {
  const заказы = Array.from({ length: 60 }, (_, i) => заказ(6000 + i, дней(1), [позиция('a', 1, 1)]));
  await assert.rejects(() => заказать({ заказы, курсорСтоит: true }), /курсор страниц не двигается/);
});

/* ─────────── поставки FBY ─────────── */

const заявка = (ид, статус, склад, { подтип = 'DEFAULT', дети = null } = {}) => ({
  id: { id: ид, marketplaceRequestId: `M-${ид}` }, type: 'SUPPLY', subtype: подтип,
  status: статус, updatedAt: '2026-11-01T10:00:00+03:00', counters: {},
  childrenLinks: дети,
  targetLocation: { serviceId: склад, name: `склад ${склад}`, type: 'FULFILLMENT',
    requestedDate: '2026-11-07T09:00:00+03:00', address: {} },
});

test('поставки: в пути = план − принято, родитель мультипоставки не задваивает', async () => {
  const { строки, заявок, журнал } = await запустить({
    заявки: [
      заявка(1, 'SHIPPED_TO_SERVICE', 305),
      заявка(2, 'WAREHOUSE_HANDLING', 147),
      заявка(3, 'CREATED', 305, { подтип: 'VIRTUAL_DISTRIBUTION_CENTER',
        дети: [{ id: { id: 1 }, type: 'CHILD' }] }),
      заявка(4, 'FINISHED', 305),
      заявка(5, 'ACCEPTED_BY_WAREHOUSE_SYSTEM', 305, { подтип: 'INVENTORYING_SUPPLY' }),
    ],
    товарыЗаявок: {
      1: [{ offerId: 'Black_29', name: 'x', counters: { planCount: 10 } }],
      2: [{ offerId: 'Black_30', name: 'x', counters: { planCount: 8, factCount: 5 } },
        { offerId: 'Black_31', name: 'x', counters: { planCount: 0 } }],
      3: [{ offerId: 'Black_29', name: 'x', counters: { planCount: 10 } }],
    },
    справочник: [{ id: 305, name: 'Софьино' }],
  }, (м) => м.ямПоставкиСтроки(КАМПАНИЯ));
  assert.equal(заявок, 2);
  assert.deepEqual(строки.map((р) => [р[0], р[2], р[4], р[6], р[7], р[8], р[9]]), [
    ['1', 'едет на склад', 'Софьино', 'Black_29', 10, 0, 10],
    ['2', 'приёмка', 'склад 147', 'Black_30', 8, 5, 3],
  ]);
  const список = журнал.find((з) => з.путь.endsWith('/supply-requests'));
  assert.deepEqual(список.тело.requestTypes, ['SUPPLY']);
  assert.ok(!список.тело.requestStatuses.includes('FINISHED'));
});

test('поставок в работе нет — пустой снимок чистит лист, а не падает', async () => {
  const { подставитьКлиент, сохранить } = await import('../src/sheets.js');
  const очищено = [];
  подставитьКлиент({ spreadsheets: { values: {
    async get() { return { data: { values: [] } }; },
    async update() { throw new Error('писать нечего'); },
    async batchUpdate() { throw new Error('писать нечего'); },
    async clear({ range }) { очищено.push(range); },
  } } });
  const итог = await сохранить('FBO поставки Яндекс', []);
  assert.equal(итог.всего, 0);
  assert.equal(очищено.length, 1);
  assert.match(очищено[0], /^'FBO поставки Яндекс'!A2:K/);
  await assert.rejects(() => сохранить('FBO остатки Яндекс', []), /пришло 0 строк/,
    'пустые остатки по-прежнему не стирают лист');
});
