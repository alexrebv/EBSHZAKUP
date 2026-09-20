import { сохранить } from './sheets.js';
import { требовать } from './config.js';
import { запрос, сон, вТаблицу, число, началоПериода, период, локальныйISO } from './http.js';

/* ══════════════════ ЯНДЕКС МАРКЕТ ══════════════════
 * FBY и FBS — разные кампании. Если подставить чужой номер,
 * метод вернёт пустой список без ошибки, и это легко не заметить.
 */
const ЯМ = 'https://api.partner.market.yandex.ru';

function ям(кампания, путь, метод = 'GET', тело = null) {
  const [ключ] = требовать('YM_API_KEY');
  const опции = { method: метод, headers: { 'Api-Key': ключ } };
  if (тело) {
    опции.headers['Content-Type'] = 'application/json';
    опции.body = JSON.stringify(тело);
  }
  return запрос(`${ЯМ}/campaigns/${кампания}${путь}`, опции,
    { имя: `ЯМ ${путь}`, пауза: 2000 });
}

const датаЯМ = (д) => {
  const п = (n) => String(n).padStart(2, '0');
  return `${п(д.getDate())}-${п(д.getMonth() + 1)}-${д.getFullYear()}`;
};

/** Яндекс отдаёт ДД-ММ-ГГГГ — конструктор Date такое читает неверно. */
function изЯМ(строка) {
  if (!строка) return null;
  const м = String(строка).match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  if (!м) return new Date(строка);
  return new Date(+м[3], +м[2] - 1, +м[1], +(м[4] || 0), +(м[5] || 0), +(м[6] || 0));
}

async function ямОстатки(кампания, лист, сФбо) {
  const склады = new Map();
  let токен = '';
  for (let n = 0; n < 500; n += 1) {
    const п = new URLSearchParams({ limit: '200' });
    if (токен) п.set('page_token', токен);
    const ответ = await ям(кампания, `/offers/stocks?${п}`, 'POST', {});
    const тело = ответ.result || ответ;
    for (const с of тело.warehouses || []) {
      const ид = String(с.warehouseId);
      if (!склады.has(ид)) склады.set(ид, { имя: с.name || ид, товары: [] });
      склады.get(ид).товары.push(...(с.offers || []));
    }
    const след = тело.paging?.nextPageToken;
    if (!след || след === токен) break;
    токен = след;
    await сон(300);
  }
  const отметка = вТаблицу(new Date());
  const строки = [];
  for (const склад of склады.values()) {
    for (const т of склад.товары) {
      let доступно = 0; let заморожено = 0; let брак = 0; let всего = 0;
      for (const о of т.stocks || []) {
        const к = число(о.count);
        всего += к;
        if (о.type === 'AVAILABLE' || о.type === 'FIT') доступно += к;
        if (о.type === 'FREEZE') заморожено += к;
        if (о.type === 'DEFECT') брак += к;
      }
      if (!всего) continue;
      строки.push(сФбо
        ? [т.offerId || '-', склад.имя, доступно, заморожено, брак, всего, отметка]
        : [т.offerId || '-', склад.имя, доступно, всего, отметка]);
    }
  }
  await сохранить(лист, строки);
  return `складов ${склады.size}, строк ${строки.length}`;
}

export const ямОстаткиFbo = () =>
  ямОстатки(требовать('YM_CAMPAIGN_FBY')[0], 'FBO остатки Яндекс', true);
export const ямОстаткиFbs = () =>
  ямОстатки(требовать('YM_CAMPAIGN_FBS')[0], 'FBS остатки Яндекс', false);

/**
 * Метод заказов не принимает интервал длиннее 30 суток: на 33 днях отвечает
 * 400 «Invalid filters: interval between dates». Режем период на окна по 28 дней
 * с запасом. Заодно: заказы, доставленные или отменённые больше 30 дней назад,
 * этот метод не отдаёт вовсе — глубже месяца история отсюда не берётся.
 */
const ШАГ_ЯМ = 28 * 24 * 3600 * 1000;

async function ямЗаказы(кампания, лист, задача) {
  const { с, по } = период(задача);
  const заказы = [];
  const виденные = new Set();
  let окон = 0;

  for (let окноС = new Date(с); окноС.getTime() <= по.getTime();) {
    const окноПо = new Date(Math.min(окноС.getTime() + ШАГ_ЯМ, по.getTime()));
    окон += 1;
    let токен = '';
    for (let n = 0; n < 400; n += 1) {
      const п = new URLSearchParams({
        fromDate: датаЯМ(окноС), toDate: датаЯМ(окноПо), limit: '50',
      });
      if (токен) п.set('page_token', токен);
      const ответ = await ям(кампания, `/orders?${п}`);
      const тело = ответ.result || ответ;
      const пачка = тело.orders || [];
      for (const з of пачка) {
        const ид = String(з.id ?? '');
        if (ид && виденные.has(ид)) continue;
        if (ид) виденные.add(ид);
        заказы.push(з);
      }
      const след = тело.paging?.nextPageToken;
      if (!след || след === токен || !пачка.length) break;
      токен = след;
      await сон(300);
    }
    окноС = new Date(окноПо.getTime() + 24 * 3600 * 1000);
    await сон(300);
  }

  const отметка = вТаблицу(new Date());
  const строки = заказы
    .filter((з) => з.fake !== true)
    .flatMap((з) => (з.items || []).map((т) => [
      String(з.id), вТаблицу(изЯМ(з.creationDate)), т.offerId || т.shopSku || '-',
      число(т.count), число(т.price ?? т.buyerPrice), з.status || '-',
      з.substatus || '-', з.delivery?.region?.name || '-',
      з.delivery?.shipments?.[0]?.warehouse?.name || '-', отметка,
    ]));
  const итог = await сохранить(лист, строки);
  return `заказов ${заказы.length} за окон ${окон}, строк ${строки.length}, `
       + `новых ${итог.новых}, изменено ${итог.изменено}${итог.заметка}`;
}

export const ямЗаказыFbo = (з) =>
  ямЗаказы(требовать('YM_CAMPAIGN_FBY')[0], 'Заказы Яндекс FBO', з);
export const ямЗаказыFbs = (з) =>
  ямЗаказы(требовать('YM_CAMPAIGN_FBS')[0], 'Заказы Яндекс FBS', з);

/* ══════════════════ ЛАМОДА ══════════════════
 * Остатки и товары — Seller Partner API на JSON-RPC.
 * Заказы — B2B Platform Partner API на REST, отдельный токен.
 */
const LM_RPC = 'https://api-seller.lamoda.ru/rpc';
const LM_B2B = 'https://b2b-api.lamoda.ru';

async function rpc(метод, параметры = {}) {
  const [токен] = требовать('LAMODA_TOKEN');
  const ответ = await запрос(LM_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${токен}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: метод, params: параметры }),
  }, { имя: `Lamoda ${метод}` });
  if (ответ.error) throw new Error(`Lamoda ${метод}: ${JSON.stringify(ответ.error).slice(0, 200)}`);
  return ответ.result || {};
}

async function лмОстатки(лист, схема) {
  const строки = [];
  const отметка = вТаблицу(new Date());
  let страница = 1;
  for (let n = 0; n < 200; n += 1) {
    const res = await rpc('getStocks', { page: страница, limit: 500, stock_type: схема });
    const пачка = res.items || res.stocks || [];
    for (const с of пачка) {
      const доступно = число(с.quantity ?? с.available);
      if (!доступно) continue;
      строки.push(схема === 'fbo'
        ? [с.supplier_sku || с.sku || '-', с.lamoda_sku || с.sku || '-',
          с.warehouse || 'Склад Lamoda', доступно, число(с.reserved), отметка]
        : [с.supplier_sku || с.sku || '-', с.lamoda_sku || с.sku || '-',
          с.warehouse || 'Склад продавца', доступно, отметка]);
    }
    if (пачка.length < 500) break;
    страница += 1;
    await сон(300);
  }
  await сохранить(лист, строки);
  return `строк ${строки.length}`;
}

export const лмОстаткиFbo = () => лмОстатки('FBO остатки Ламода', 'fbo');
export const лмОстаткиFbs = () => лмОстатки('FBS остатки Ламода', 'fbs');

async function лмЗаказы(лист, схема, задача) {
  const [токен] = требовать('LAMODA_B2B_TOKEN');
  const с = началоПериода(задача);
  const заказы = [];
  let страница = 1;
  for (let n = 0; n < 300; n += 1) {
    const п = new URLSearchParams({
      page: String(страница), limit: '200',
      created_from: локальныйISO(с).slice(0, 10),
      fulfillment_type: схема,
    });
    const ответ = await запрос(`${LM_B2B}/v1/orders?${п}`, {
      headers: { Authorization: `Bearer ${токен}` },
    }, { имя: 'Lamoda заказы' });
    const пачка = ответ.items || ответ.orders || [];
    заказы.push(...пачка);
    if (пачка.length < 200) break;
    страница += 1;
    await сон(300);
  }
  const отметка = вТаблицу(new Date());
  const строки = заказы.flatMap((з) => (з.items || [з]).map((т) => [
    String(з.order_id || з.id || ''), вТаблицу(з.created_at || з.order_date),
    т.supplier_sku || т.sku || '-', т.lamoda_sku || т.sku || '-',
    число(т.quantity ?? 1), число(т.price), з.status || '-',
    з.delivery?.region || з.region || '-', отметка,
  ]));
  const итог = await сохранить(лист, строки);
  return `заказов ${заказы.length}, строк ${строки.length}, `
       + `новых ${итог.новых}, изменено ${итог.изменено}${итог.заметка}`;
}

export const лмЗаказыFbo = (з) => лмЗаказы('Заказы Ламода FBO', 'fbo', з);
export const лмЗаказыFbs = (з) => лмЗаказы('Заказы Ламода FBS', 'fbs', з);
