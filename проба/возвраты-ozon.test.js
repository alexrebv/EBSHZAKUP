import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.TZ = process.env.TZ || 'Europe/Moscow';
// значения уходят в HTTP-заголовки, а те обязаны быть латиницей
process.env.OZON_CLIENT_ID = 'test-client';
process.env.OZON_API_KEY = 'test-key';

const серийно = (г, м, д) => (Date.UTC(г, м - 1, д) - Date.UTC(1899, 11, 30)) / 86400000;

const ПОЛЯ = new Set(['filter', 'limit', 'last_id']);
/** Метод принимает только один фильтр-дату за запрос, остальное — ошибка. */
const ДАТЫ = ['logistic_return_date', 'storage_tariffication_start_date', 'visual_status_change_moment'];

function возврат(i) {
  return {
    id: String(1000000 + i),
    posting_number: `58544282-00${i}-1`,
    order_number: `58544282-00${i}`,
    schema: i % 2 ? 'Fbs' : 'Fbo',
    type: 'FullReturn',
    return_reason_name: 'Покупатель отказался при вручении',
    place: { id: '2386', name: 'СЦ_Львовский_Возвраты', address: 'Подольск' },
    product: {
      // артикулы продавца бывают такими: Таблицы сочли бы их датами
      sku: String(1100526200 + i), offer_id: ['1970-01-29', '1950-02-28', '1995-09-29'][i % 3],
      name: `Товар ${i}`,
      price: { currency_code: 'RUB', price: '3318' }, quantity: 1,
    },
    logistic: { return_date: '2026-09-01T06:15:48.998146Z', barcode: `ii52752103${i}` },
    visual: { status: { id: 3, display_name: 'В пункте выдачи', sys_name: 'ArrivedAtReturnPlace' },
      change_moment: '2026-09-02T06:15:48.998146Z' },
  };
}

function поддельныйOzon({ всего, курсорРаботает = true, безHasNext = false }) {
  const все = Array.from({ length: всего }, (_, i) => возврат(i));
  const запросы = [];
  const сервер = http.createServer((req, res) => {
    let сырое = '';
    req.on('data', (ч) => { сырое += ч; });
    req.on('end', () => {
      const тело = JSON.parse(сырое || '{}');
      запросы.push(тело);
      const отказ = (т) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 3, message: т }));
      };
      for (const к of Object.keys(тело)) if (!ПОЛЯ.has(к)) return отказ(`unknown field "${к}"`);
      if (!(тело.limit > 0 && тело.limit <= 500)) return отказ('invalid Limit: max 500');
      const датных = ДАТЫ.filter((д) => тело.filter && д in тело.filter);
      if (датных.length > 1) return отказ('use only one date filter');

      const от = курсорРаботает
        ? все.findIndex((в) => Number(в.id) > Number(тело.last_id || 0))
        : 0;
      const пачка = от < 0 ? [] : все.slice(от, от + тело.limit);
      const ответ = { returns: пачка };
      if (!безHasNext) ответ.has_next = от >= 0 && от + пачка.length < все.length;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ответ));
    });
  });
  return { сервер, запросы };
}

/** Прогоняет сбор возвратов против поддельного метода. */
async function собрать(опции, задача = {}) {
  const { сервер, запросы } = поддельныйOzon(опции);
  await new Promise((r) => сервер.listen(0, '127.0.0.1', r));
  process.env.OZON_API_URL = `http://127.0.0.1:${сервер.address().port}`;
  try {
    // импорт внутри try: сорвись он снаружи, поддельный сервер остался бы
    // открытым и прогон пробы повис бы вместо понятной ошибки
    const { ozonВозвратыСтроки } = await import(`../src/wb-ozon.js?${Math.random()}`);
    const { строки, мимо } = await ozonВозвратыСтроки(задача);
    return { строки, мимо, запросы };
  } finally {
    сервер.close();
  }
}

test('листается last_id, ничего не теряя и не задваивая', async () => {
  const { строки, запросы } = await собрать({ всего: 1200 });
  assert.equal(строки.length, 1200);
  assert.equal(new Set(строки.map((р) => р[0])).size, 1200);
  assert.equal(запросы.length, 3);
});

test('одна страница — один запрос', async () => {
  const { строки, запросы } = await собрать({ всего: 40 });
  assert.equal(строки.length, 40);
  assert.equal(запросы.length, 1);
});

test('has_next отсутствует — выходим по короткой странице', async () => {
  const { строки } = await собрать({ всего: 700, безHasNext: true });
  assert.equal(строки.length, 700);
});

test('last_id не двигает выборку — падаем, а не крутимся', async () => {
  await assert.rejects(() => собрать({ всего: 1200, курсорРаботает: false }),
    /last_id не двигает выборку/);
});

test('тело запроса держится схемы метода: ни лишних полей, ни двух дат', async () => {
  const { запросы } = await собрать({ всего: 600 });
  for (const з of запросы) {
    assert.ok(!('filter' in з), 'в запрос попал фильтр');
    for (const к of Object.keys(з)) assert.ok(ПОЛЯ.has(к), `поле не из схемы: ${к}`);
    assert.ok(з.limit <= 500, 'limit больше предела метода');
  }
});

test('строка листа собрана по схеме', async () => {
  const { строки } = await собрать({ всего: 2 });
  const [первая] = строки;
  assert.equal(первая.length, 17);
  assert.equal(первая[0], '1000000');            // Возврат
  assert.equal(первая[3], 'Fbo');                // Схема
  assert.equal(первая[4], "'1970-01-29");        // Артикул — с пометкой «текст»
  assert.equal(первая[7], 1);                    // Кол-во
  assert.equal(первая[8], 3318);                 // Цена — строкой из {price}
  assert.equal(первая[11], 'В пункте выдачи');   // Статус
  assert.match(первая[13], /^01\.09\.2026/);     // Дата возврата
  assert.equal(строки[1][3], 'Fbs');
});

test('артикул-дата уходит в лист как текст, а не как дата', async () => {
  const { строки } = await собрать({ всего: 3 });
  assert.deepEqual(строки.map((р) => р[4]),
    ["'1970-01-29", "'1950-02-28", "'1995-09-29"]);
  // апостроф — пометка Таблицам, в ячейке останется ровно исходное значение
  for (const р of строки) assert.equal(р[4].slice(1).length, 10);
});

test('«С даты» уходит фильтром по дате возврата', async () => {
  const { запросы } = await собрать({ всего: 40 }, { сдаты: 46252, глубина: 31 });
  assert.equal(запросы.length, 1);
  const ф = запросы[0].filter;
  assert.ok(ф, 'фильтр не отправлен');
  assert.deepEqual(Object.keys(ф), ['logistic_return_date'], 'фильтр должен быть ровно один');
  assert.match(ф.logistic_return_date.time_from, /^2026-08-1[78]T/);
  assert.ok(ф.logistic_return_date.time_to, 'нет верхней границы');
});

test('пустая «С даты» — фильтра нет, берём все возвраты', async () => {
  const { запросы } = await собрать({ всего: 40 }, { сдаты: '' });
  assert.ok(!('filter' in запросы[0]));
});

test('возврат раньше запрошенной даты виден в отчёте как непримененный фильтр', async () => {
  // поддельный метод фильтр игнорирует, поэтому отдаёт всё подряд
  const { строки, мимо } = await собрать({ всего: 3 }, { сдаты: серийно(2026, 9, 15) });
  assert.equal(строки.length, 3);
  assert.equal(мимо, 3, 'возвраты вне периода должны быть посчитаны');
});

test('без «С даты» ничего не считаем мимо периода', async () => {
  const { мимо } = await собрать({ всего: 3 });
  assert.equal(мимо, 0);
});
