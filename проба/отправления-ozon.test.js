import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.TZ = process.env.TZ || 'Europe/Moscow';
// значения уходят в HTTP-заголовки, а те обязаны быть латиницей
process.env.OZON_CLIENT_ID = 'test-client';
process.env.OZON_API_KEY = 'test-key';

/**
 * Поддельный метод отправлений Ozon.
 *
 * Схему держит строго: любое поле не из неё — 400. Именно так ловится возврат
 * `offset` и `dir`, на которых сервис однажды уже обжёгся: живой метод их молча
 * выбрасывает, отвечает 200, и запрос выглядит рабочим, не будучи им.
 */
const ПОЛЯ = new Set(['limit', 'filter', 'with', 'sort_dir', 'cursor', 'translit']);
const ПОЛЯ_ФИЛЬТРА = new Set(['since', 'to', 'status']);

function поддельныйOzon({
  отправления, курсорРаботает = false, полеСортировки = 'created_at',
  недолив = 0, пределПериода = 0,
}) {
  const запросы = [];
  const сервер = http.createServer((req, res) => {
    let сырое = '';
    req.on('data', (ч) => { сырое += ч; });
    req.on('end', () => {
      const тело = JSON.parse(сырое || '{}');
      запросы.push(тело);
      const отказ = (текст) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 3, message: текст }));
      };

      for (const к of Object.keys(тело)) {
        if (!ПОЛЯ.has(к)) return отказ(`unknown field "${к}"`);
      }
      for (const к of Object.keys(тело.filter || {})) {
        if (!ПОЛЯ_ФИЛЬТРА.has(к)) return отказ(`unknown filter field "${к}"`);
      }
      if (!(тело.limit > 0 && тело.limit <= 100)) {
        return отказ('invalid Limit: value must be inside range (0, 100]');
      }

      const с = new Date(тело.filter.since).getTime();
      const по = new Date(тело.filter.to).getTime();
      // живой метод не берёт период длиннее года
      if (пределПериода && по - с > пределПериода) return отказ('PERIOD_IS_TOO_LONG');
      // фильтруем по created_at, а сортируем, возможно, по другому полю:
      // так проверяется, что обход не двигает начало окна по дате страницы
      const подходят = отправления
        .filter((о) => { const д = new Date(о.created_at).getTime(); return д >= с && д <= по; })
        .sort((а, б) => String(а[полеСортировки]).localeCompare(String(б[полеСортировки])));

      const от = курсорРаботает && тело.cursor ? Number(тело.cursor) : 0;
      // недолив: метод вправе отдать меньше запрошенного, не соврав про has_next
      const пачка = подходят.slice(от, от + Math.min(тело.limit, недолив || тело.limit));
      const тело_ = { postings: пачка };
      if (курсорРаботает) {
        тело_.cursor = String(от + пачка.length);
        тело_.has_next = от + пачка.length < подходят.length;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: тело_ }));
    });
  });
  return { сервер, запросы };
}

function отправление(i, датаISO, ключ = null) {
  return {
    posting_number: `П-${i}`, order_number: `З-${i}`,
    created_at: датаISO, in_process_at: датаISO,
    status: 'delivered',
    порядок: ключ ?? String(i).padStart(4, '0'),
    analytics_data: { warehouse_name: 'Хоругвино', region: 'Москва' },
    financial_data: { cluster_to: 'Москва' },
    products: [{ offer_id: `art-${i}`, sku: 1000 + i, quantity: 1, price: '100.00' }],
  };
}

/** Ровно N отправлений, размазанных по периоду. */
function ряд(n, отДней = 30) {
  const конец = Date.UTC(2026, 8, 22, 12, 0, 0);
  const шаг = Math.floor((отДней * 86400000) / n);
  return Array.from({ length: n }, (_, i) =>
    отправление(i, new Date(конец - (n - i) * шаг).toISOString()));
}

async function собрать(отправления, опции = {}) {
  const { задача, ...повадки } = опции;
  const { сервер, запросы } = поддельныйOzon({ отправления, ...повадки });
  await new Promise((r) => сервер.listen(0, '127.0.0.1', r));
  process.env.OZON_API_URL = `http://127.0.0.1:${сервер.address().port}`;
  const { ozonОтправления } = await import(`../src/wb-ozon.js?${Math.random()}`);
  try {
    const итог = await ozonОтправления('/v3/posting/fbo/list',
      задача || { сдаты: '', глубина: 60, последний: null, успешный: new Date(Date.now() - 1800000) },
      true);
    return { ...итог, запросы };
  } finally {
    сервер.close();
  }
}

test('курсор работает — листаем им, ничего не теряя', async () => {
  const { строки, сводка, запросы } = await собрать(ряд(250), { курсорРаботает: true });
  assert.equal(строки.length, 250);
  assert.match(сводка, /листали: курсор/);
  assert.ok(запросы.length <= 5, `запросов ${запросы.length}, ожидалось не больше пяти`);
});

test('курсора нет — обход доедает окно датами, ни одно не потеряно', async () => {
  const { строки, сводка } = await собрать(ряд(250));
  assert.equal(строки.length, 250);
  assert.match(сводка, /листали: дата/);
});

test('окно помещается целиком — одна страница, без резов', async () => {
  const { строки, сводка, запросы } = await собрать(ряд(40));
  assert.equal(строки.length, 40);
  assert.match(сводка, /листали: одна страница/);
  assert.equal(запросы.length, 1);
});

test('группы отправлений с одинаковой датой не теряются на шве реза', async () => {
  // пять мгновений по полсотни: рез неизбежно придётся ровно на дату группы
  const отправления = [];
  for (let г = 0; г < 5; г += 1) {
    const д = new Date(Date.UTC(2026, 8, 10 + г, 12, 0, 0)).toISOString();
    for (let i = 0; i < 50; i += 1) отправления.push(отправление(г * 50 + i, д));
  }
  const { строки } = await собрать(отправления);
  assert.equal(строки.length, 250);
});

test('сортировка не по полю фильтра — начало окна не двигаем, потерь нет', async () => {
  // метод сортирует по «порядок», обратному дате: если обход двинет since по
  // дате последней строки страницы, он перескочит через хвост выборки
  const отправления = ряд(250).map((о, i) => ({ ...о, порядок: String(999 - i).padStart(4, '0') }));
  const { строки } = await собрать(отправления, { полеСортировки: 'порядок' });
  assert.equal(строки.length, 250);
});

test('больше сотни в одно мгновение — падаем, а не молчим', async () => {
  const д = new Date(Date.UTC(2026, 8, 15, 12, 0, 0)).toISOString();
  const отправления = Array.from({ length: 120 }, (_, i) => отправление(i, д));
  await assert.rejects(() => собрать(отправления), /уже не делится/);
});

test('в запросе нет ни offset, ни dir — иначе поддельный метод ответил бы 400', async () => {
  const { запросы } = await собрать(ряд(250));
  for (const з of запросы) {
    assert.ok(!('offset' in з), 'в запрос вернулся offset');
    assert.ok(!('dir' in з), 'в запрос вернулся dir');
    for (const к of Object.keys(з)) assert.ok(ПОЛЯ.has(к), `поле не из схемы: ${к}`);
  }
});

test('ответ без списка отправлений — ошибка, а не пустой успех', async () => {
  const сервер = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: { что_то_не_то: true } }));
  });
  await new Promise((r) => сервер.listen(0, '127.0.0.1', r));
  process.env.OZON_API_URL = `http://127.0.0.1:${сервер.address().port}`;
  const { ozonОтправления } = await import(`../src/wb-ozon.js?${Math.random()}`);
  try {
    await assert.rejects(
      () => ozonОтправления('/v3/posting/fbo/list',
        { сдаты: '', глубина: 7, последний: null, успешный: null }, true),
      /без списка отправлений/);
  } finally {
    сервер.close();
  }
});

test('недолитая страница не закрывает окно, если метод говорит has_next', async () => {
  // Метод вправе отдать меньше сотни и при этом сказать, что есть ещё. Поверить
  // длине страницы значит обрезать выборку молча — а это ровно то, что здесь
  // недопустимо: короткая страница закрывает окно только при has_next не «true»
  const { строки } = await собрать(ряд(250), { курсорРаботает: true, недолив: 40 });
  assert.equal(строки.length, 250);
});

test('период глубже года режется на окна — метод длиннее не берёт', async () => {
  // первичная заливка с «С даты» бывает и на два года, а живой метод на такой
  // интервал отвечает 400. Окна режутся заранее, не дожидаясь отказа
  // отправления размазаны по 400 дням, а период просят на 500: так все они
  // заведомо внутри периода, и проверяется именно рез окон, а не края
  const дней = 500;
  const { строки } = await собрать(ряд(150, 400), {
    курсорРаботает: true,
    пределПериода: 366 * 86400000,
    задача: {
      сдаты: new Date(Date.now() - дней * 86400000),
      глубина: 0, последний: null, успешный: null,
    },
  });
  assert.equal(строки.length, 150);
});
