import { сохранить } from './sheets.js';
import { требовать } from './config.js';
import { запрос, сон, вТаблицу, число, началоПериода, период, текстом,
  локальныйISO } from './http.js';

/* ══════════════════ ЯНДЕКС МАРКЕТ ══════════════════
 * FBY и FBS — разные кампании. Если подставить чужой номер,
 * метод вернёт пустой список без ошибки, и это легко не заметить.
 *
 * Заказы берутся методом кабинета `POST /v1/businesses/{businessId}/orders`:
 * старый `GET /campaigns/{campaignId}/orders` объявлен устаревшим, с 18.01.2027
 * начинает деградировать и 12.04.2027 отключается. Номер кабинета сервис
 * узнаёт сам по номеру кампании, задавать его не обязательно.
 */
// адрес вынесен в окружение только ради пробы, как у Ozon и WB: пересечение
// типов остатков на живом API не проверить
const ЯМ = process.env.YM_API_URL || 'https://api.partner.market.yandex.ru';
const ЯМ_ПОДСТАВНОЙ = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(ЯМ);
const паузаЯМ = (мс) => сон(ЯМ_ПОДСТАВНОЙ ? 0 : мс);

/** Любой метод по полному пути: `/v2/warehouses`, `/v1/businesses/…/orders`. */
function ямЗапрос(путь, метод = 'GET', тело = null) {
  const [ключ] = требовать('YM_API_KEY');
  const опции = { method: метод, headers: { 'Api-Key': ключ } };
  if (тело) {
    опции.headers['Content-Type'] = 'application/json';
    опции.body = JSON.stringify(тело);
  }
  // в имя запроса токен страницы не берём: он длинный и в «Результате»
  // вытеснял сам текст ошибки
  return запрос(`${ЯМ}${путь}`, опции,
    { имя: `ЯМ ${путь.split('?')[0]}`, пауза: ЯМ_ПОДСТАВНОЙ ? 1 : 2000 });
}

const ям = (кампания, путь, метод = 'GET', тело = null) =>
  ямЗапрос(`/campaigns/${кампания}${путь}`, метод, тело);

const п2 = (n) => String(n).padStart(2, '0');
const датаISO = (д) => `${д.getFullYear()}-${п2(д.getMonth() + 1)}-${п2(д.getDate())}`;
const полночь = (д) => new Date(д.getFullYear(), д.getMonth(), д.getDate());
const плюсДней = (д, n) => new Date(д.getFullYear(), д.getMonth(), д.getDate() + n);

/**
 * Обход страниц курсором. Курсор, который не двигается, — это круг, и он
 * падает, а не обрывается молча: оборванный обход записался бы успешным,
 * а недочитанное не вернулось бы уже никогда.
 */
async function листать(имя, запросСтраницы, список, { страниц = 400 } = {}) {
  const итог = [];
  let токен = '';
  for (let n = 0; n < страниц; n += 1) {
    const ответ = await запросСтраницы(токен);
    const тело = ответ.result || ответ;
    const пачка = тело[список];
    if (!Array.isArray(пачка)) {
      throw new Error(`${имя}: метод ответил без списка «${список}» на странице ${n + 1}`);
    }
    итог.push(...пачка);
    const след = тело.paging?.nextPageToken;
    if (!след || !пачка.length) return итог;
    if (след === токен) {
      throw new Error(`${имя}: курсор страниц не двигается — выгрузка была бы неполной`);
    }
    токен = след;
    await паузаЯМ(300);
  }
  throw new Error(`${имя}: больше ${страниц} страниц — обход остановлен, неполное не пишем`);
}

/** Номер кабинета по номеру кампании. `YM_BUSINESS_ID` — если хочется задать руками. */
const кабинеты = new Map();
async function кабинетЯМ(кампания) {
  if (process.env.YM_BUSINESS_ID) return process.env.YM_BUSINESS_ID;
  if (кабинеты.has(кампания)) return кабинеты.get(кампания);
  const ответ = await ямЗапрос(`/v2/campaigns/${кампания}`);
  const ид = (ответ.result || ответ).campaign?.business?.id;
  if (!ид) {
    throw new Error(`ЯМ: у кампании ${кампания} в ответе нет номера кабинета — задайте YM_BUSINESS_ID`);
  }
  кабинеты.set(кампания, String(ид));
  return String(ид);
}

/**
 * Склады Маркета: номер → название. Остатки FBY приходят только с номером
 * склада, без имени, — на листе раньше так и стояло «305». Справочник меняется
 * редко, а лимит у метода сто запросов в час, поэтому держим его шесть часов.
 */
const СПРАВОЧНИК_ЖИВЁТ = 6 * 3600 * 1000;
let справочник = null;

async function складыМаркета() {
  if (справочник && Date.now() - справочник.когда < СПРАВОЧНИК_ЖИВЁТ) return справочник.карта;
  const ответ = await ямЗапрос('/v2/warehouses');
  const список = (ответ.result || ответ).warehouses;
  if (!Array.isArray(список)) throw new Error('ЯМ склады: метод ответил без списка складов');
  const карта = new Map(список.map((с) => [String(с.id), String(с.name || с.id).trim()]));
  справочник = { карта, когда: Date.now() };
  return карта;
}

/**
 * Без названий складов данные всё равно нужны: остатки и заказы пишутся,
 * а в «Результат» уходит, почему вместо названия стоит номер.
 */
async function названияСкладов() {
  try {
    return { имена: await складыМаркета(), заметка: '' };
  } catch (е) {
    return { имена: new Map(), заметка: `, названия складов не получены: ${е.message.slice(0, 120)}` };
  }
}

/**
 * Остатки приходят разложенными по типам, и типы **пересекаются**:
 *
 *   `AVAILABLE` («Доступный к заказу») — товар, доступный для продажи;
 *   `FREEZE` — товар, зарезервированный под заказы;
 *   `FIT` («Годный») — товар, доступный для продажи ИЛИ уже зарезервированный,
 *   то есть `AVAILABLE` + `FREEZE`.
 *
 * Складывать `AVAILABLE` с `FIT`, как если бы это были два имени одного и того
 * же, нельзя — свободный остаток посчитается дважды. Ровно на этом лист показывал
 * двойные остатки и по FBO, и по FBS: при десяти штуках без резерва и в «Доступно»,
 * и в «Всего» стояло двадцать.
 *
 * Остальные типы — `DEFECT`, `EXPIRED`, `QUARANTINE`, `UTILIZATION` — лежат рядом
 * с годным, а не внутри него, поэтому в «Всего» идут как есть.
 */
const ВНУТРИ_ГОДНОГО = new Set(['AVAILABLE', 'FREEZE']);

function остатокТовара(товар) {
  const поТипу = new Map();
  for (const о of товар.stocks || []) {
    поТипу.set(о.type, (поТипу.get(о.type) || 0) + число(о.count));
  }
  const заморожено = поТипу.get('FREEZE') || 0;
  // не дал «годный» — собираем его из частей; не дал «доступный» — вычитаем резерв
  const годный = поТипу.has('FIT')
    ? поТипу.get('FIT')
    : (поТипу.get('AVAILABLE') || 0) + заморожено;
  const доступно = поТипу.has('AVAILABLE')
    ? поТипу.get('AVAILABLE')
    : Math.max(0, годный - заморожено);
  let прочее = 0;
  for (const [тип, к] of поТипу) {
    if (тип !== 'FIT' && !ВНУТРИ_ГОДНОГО.has(тип)) прочее += к;
  }
  return { доступно, заморожено, брак: поТипу.get('DEFECT') || 0, всего: годный + прочее };
}

/** Оценка оборачиваемости Маркета: от неё зависит платное хранение FBY. */
const ОБОРАЧИВАЕМОСТЬ = {
  VERY_HIGH: 'очень высокая',
  HIGH: 'высокая',
  ALMOST_LOW: 'почти низкая',
  LOW: 'низкая',
  NO_SALES: 'нет продаж',
  FREE_STORE: 'хранение бесплатно',
};

export async function ямОстаткиСтроки(кампания, сФбо) {
  const склады = new Map();
  // склад и артикул: страница, пришедшая повторно, не должна задваивать товар.
  // Метод, который не двигает `page_token`, отдаёт ту же страницу снова, а
  // проверка на неподвижный токен стоит уже ПОСЛЕ того, как страница прочитана
  const виденные = new Set();
  let токен = '';
  for (let n = 0; n < 500; n += 1) {
    // больше сотни метод не отдаёт: лишнее он молча обрезает до ста
    const п = new URLSearchParams({ limit: '100' });
    if (токен) п.set('page_token', токен);
    // оборачиваемость метод считает только по FBY
    const ответ = await ям(кампания, `/offers/stocks?${п}`, 'POST',
      сФбо ? { withTurnover: true } : {});
    const тело = ответ.result || ответ;
    if (!Array.isArray(тело.warehouses)) {
      throw new Error(`ЯМ остатки: метод ответил без списка складов на странице ${n + 1}`);
    }
    for (const с of тело.warehouses) {
      const ид = String(с.warehouseId);
      if (!склады.has(ид)) склады.set(ид, { имя: с.name || '', товары: [] });
      for (const т of с.offers || []) {
        const ключ = `${ид}|${т.offerId}`;
        if (виденные.has(ключ)) continue;
        виденные.add(ключ);
        склады.get(ид).товары.push(т);
      }
    }
    const след = тело.paging?.nextPageToken;
    if (!след || след === токен) break;
    токен = след;
    await паузаЯМ(300);
  }

  // названия нужны только складам Маркета; у FBS склад свой, и в справочнике
  // Маркета его нет
  const { имена, заметка } = сФбо ? await названияСкладов() : { имена: new Map(), заметка: '' };
  const отметка = вТаблицу(new Date());
  const строки = [];
  let безИмени = 0;
  for (const [ид, склад] of склады) {
    const имя = склад.имя || имена.get(ид) || '';
    if (!имя && сФбо) безИмени += 1;
    for (const т of склад.товары) {
      const { доступно, заморожено, брак, всего } = остатокТовара(т);
      if (!всего) continue;
      if (!сФбо) {
        строки.push([текстом(т.offerId) || '-', имя || ид, доступно, всего, отметка]);
        continue;
      }
      const об = т.turnoverSummary || {};
      const дней = typeof об.turnoverDays === 'number' && Number.isFinite(об.turnoverDays)
        ? Math.round(об.turnoverDays * 10) / 10 : '';
      строки.push([текстом(т.offerId) || '-', имя || ид, доступно, заморожено, брак, всего,
        дней, ОБОРАЧИВАЕМОСТЬ[об.turnover] || об.turnover || '-', отметка]);
    }
  }
  const хвост = заметка + (безИмени && !заметка ? `, складов без названия ${безИмени}` : '');
  return { строки, складов: склады.size, заметка: хвост };
}

async function ямОстатки(кампания, лист, сФбо) {
  const { строки, складов, заметка } = await ямОстаткиСтроки(кампания, сФбо);
  await сохранить(лист, строки);
  return `складов ${складов}, строк ${строки.length}${заметка}`;
}

export const ямОстаткиFbo = () =>
  ямОстатки(требовать('YM_CAMPAIGN_FBY')[0], 'FBO остатки Яндекс', true);
export const ямОстаткиFbs = () =>
  ямОстатки(требовать('YM_CAMPAIGN_FBS')[0], 'FBS остатки Яндекс', false);

/**
 * Метод заказов не принимает интервал длиннее 30 суток. Режем период на окна
 * по 28 дней; конец окна у метода в интервал НЕ входит, поэтому окна стыкуются
 * встык: конец одного — начало следующего, без дыр и без нахлёста.
 */
export const ОКНО_ЯМ_ДНЕЙ = 28;

export function окнаЯМ(с, по) {
  const окна = [];
  const конец = плюсДней(полночь(по), 1);
  for (let нач = полночь(с); нач < конец;) {
    const кон = new Date(Math.min(плюсДней(нач, ОКНО_ЯМ_ДНЕЙ).getTime(), конец.getTime()));
    окна.push([нач, кон]);
    нач = кон;
  }
  return окна;
}

/**
 * Склад, с которого собран заказ FBY, есть только в статистике заказов: метод
 * заказов кабинета отдаёт склад в системе магазина, а у FBY его нет. Регион
 * доставки FBY — тоже только здесь. Отсюда же цена за штуку — запасной вариант,
 * если в самом заказе цены нет.
 *
 * Статистика отстаёт от заказов до сорока минут: свежий заказ сначала ляжет
 * без склада, а следующий прогон его допишет — строка в окне обновляется.
 */
async function статистикаЗаказов(кампания, [с, по]) {
  const заказы = await листать('ЯМ статистика заказов', (токен) => {
    const п = new URLSearchParams({ limit: '200' });
    if (токен) п.set('page_token', токен);
    return ямЗапрос(`/v2/campaigns/${кампания}/stats/orders?${п}`, 'POST',
      { dateFrom: датаISO(с), dateTo: датаISO(плюсДней(по, -1)) });
  }, 'orders');
  const карта = new Map();
  for (const з of заказы) {
    // регион доставки у FBY-заказа есть только здесь: в заказе кабинета нет ни
    // региона, ни адреса — на нём лист и потерял регионы за весь месяц
    if (з.deliveryRegion?.name) карта.set(`${з.id}|регион`, з.deliveryRegion.name);
    for (const т of [...(з.items || []), ...(з.initialItems || [])]) {
      if (т.shopServiceType) continue;
      const цена = (т.prices || []).find((ц) => ц.type === 'BUYER')?.costPerItem;
      const к = `${з.id}|${т.shopSku}`;
      if (!карта.has(к)) карта.set(к, { склад: т.warehouse || null, цена });
      // заказ целиком: на случай, если артикул в статистике записан иначе
      if (т.warehouse && !карта.has(`${з.id}|`)) карта.set(`${з.id}|`, { склад: т.warehouse });
    }
  }
  return карта;
}

function ценаЗаШтуку(т, стат) {
  const к = число(т.count);
  const сумма = число(т.prices?.payment?.value) + число(т.prices?.cashback?.value);
  if (к && сумма) return Math.round((сумма / к) * 100) / 100;
  return число(стат?.цена);
}

const регионЗаказа = (д = {}, изСтатистики = '') => д.courier?.region?.name
  || д.pickup?.region?.name || изСтатистики || д.courier?.address?.city
  || д.pickup?.address?.city || '-';

export async function ямЗаказыСтроки(кампания, задача) {
  const { с, по } = период(задача);
  const кабинет = await кабинетЯМ(кампания);
  const окна = окнаЯМ(с, по);
  const заказы = [];
  const виденные = new Set();
  const стат = new Map();
  let ошибкаСтат = '';

  for (const окно of окна) {
    const пачка = await листать('ЯМ заказы', (токен) => {
      const п = new URLSearchParams({ limit: '50' });
      if (токен) п.set('page_token', токен);
      return ямЗапрос(`/v1/businesses/${кабинет}/orders?${п}`, 'POST', {
        campaignIds: [Number(кампания)],
        fake: false,
        dates: { creationDateFrom: датаISO(окно[0]), creationDateTo: датаISO(окно[1]) },
      });
    }, 'orders');
    for (const з of пачка) {
      const ид = String(з.orderId ?? '');
      if (ид && виденные.has(ид)) continue;
      if (ид) виденные.add(ид);
      заказы.push(з);
    }
    // склад вторичен: без статистики заказы всё равно пишутся, а причина
    // уходит в «Результат». Строки в окне допишутся следующим прогоном
    if (!ошибкаСтат) {
      try {
        for (const [к, в] of await статистикаЗаказов(кампания, окно)) стат.set(к, в);
      } catch (е) {
        ошибкаСтат = е.message;
      }
    }
    await паузаЯМ(300);
  }

  const { имена, заметка } = ошибкаСтат ? { имена: new Map(), заметка: '' } : await названияСкладов();
  const отметка = вТаблицу(new Date());
  let безСклада = 0;
  const строки = заказы
    .filter((з) => з.fake !== true)
    .flatMap((з) => (з.items || []).map((т) => {
      const с1 = стат.get(`${з.orderId}|${т.offerId}`);
      const склад = с1?.склад || стат.get(`${з.orderId}|`)?.склад;
      const имяСклада = склад
        ? (имена.get(String(склад.id)) || склад.name || String(склад.id ?? '')) : '';
      if (!имяСклада) безСклада += 1;
      return [
        String(з.orderId), вТаблицу(з.creationDate ? new Date(з.creationDate) : null),
        текстом(т.offerId) || '-', число(т.count), ценаЗаШтуку(т, с1), з.status || '-',
        з.substatus || '-', регионЗаказа(з.delivery, стат.get(`${з.orderId}|регион`)),
        имяСклада || '-', отметка,
      ];
    }));
  const хвост = (ошибкаСтат ? `, склады не получены: ${ошибкаСтат.slice(0, 120)}` : '')
    + заметка + (безСклада && !ошибкаСтат ? `, без склада ${безСклада}` : '');
  return { строки, заказов: заказы.length, окон: окна.length, заметка: хвост };
}

async function ямЗаказы(кампания, лист, задача) {
  const { строки, заказов, окон, заметка } = await ямЗаказыСтроки(кампания, задача);
  const итог = await сохранить(лист, строки);
  return `заказов ${заказов} за окон ${окон}, строк ${строки.length}, `
       + `новых ${итог.новых}, изменено ${итог.изменено}${итог.заметка}${заметка}`;
}

export const ямЗаказыFbo = (з) =>
  ямЗаказы(требовать('YM_CAMPAIGN_FBY')[0], 'Заказы Яндекс FBO', з);
export const ямЗаказыFbs = (з) =>
  ямЗаказы(требовать('YM_CAMPAIGN_FBS')[0], 'Заказы Яндекс FBS', з);

/**
 * Поставки FBY, которые ещё не приняты складом: то, что уже едет или оформлено,
 * но в остатках Маркета пока не числится. Без них лист отгрузки предлагал бы
 * везти на склад то, что туда уже везут.
 *
 * Завершённые, отменённые и ошибочные заявки не берём. Родительская заявка
 * мультипоставки дублирует свои дочерние, поэтому заявка с дочерними пропускается:
 * товар считается по дочерним, иначе он посчитался бы дважды.
 */
export const ПОСТАВКА_ЭТАП = {
  CREATED: 'оформляется',
  VALIDATED: 'оформляется',
  PUBLISHED: 'оформляется',
  NEED_PREPARATION: 'оформляется',
  ACCEPTED_BY_WAREHOUSE_SYSTEM: 'утверждена',
  REGISTERED_IN_ELECTRONIC_QUEUE: 'в очереди',
  ARRIVED_TO_SERVICE: 'отгружена',
  ARRIVED_TO_XDOC_SERVICE: 'на транзитном складе',
  SHIPPED_TO_SERVICE: 'едет на склад',
  WAREHOUSE_HANDLING: 'приёмка',
  CANCELLATION_REQUESTED: 'запрошена отмена',
  CANCELLATION_REJECTED: 'отмена отклонена',
};
/**
 * Заявка, чья дата поставки прошла больше полутора месяцев назад, уже ничего не
 * везёт: так висят брошенные заявки, которые Маркет годами держит «утверждёнными».
 * Считать их товар «в пути» значит недогружать склад.
 */
export const ПОСТАВКА_ЗАБЫТА_ДНЕЙ = 45;
/** Подтипы, которые не везут товар: инвентаризации и пересортица. */
const НЕ_ВЕЗЁТ = new Set(['INVENTORYING_SUPPLY', 'INVENTORYING_SUPPLY_WAREHOUSE_BASED_PER_SUPPLIER',
  'MISGRADING_SUPPLY', 'FIX_LOST_INVENTORYING', 'OPER_LOST_INVENTORYING']);

export async function ямПоставкиСтроки(кампания) {
  const заявки = await листать('ЯМ заявки на поставку', (токен) => {
    const п = new URLSearchParams({ limit: '100' });
    if (токен) п.set('page_token', токен);
    return ямЗапрос(`/v2/campaigns/${кампания}/supply-requests?${п}`, 'POST', {
      requestTypes: ['SUPPLY'],
      requestStatuses: Object.keys(ПОСТАВКА_ЭТАП),
    });
  }, 'requests');

  const { имена, заметка } = await названияСкладов();
  const отметка = вТаблицу(new Date());
  const давно = Date.now() - ПОСТАВКА_ЗАБЫТА_ДНЕЙ * 24 * 3600 * 1000;
  const строки = [];
  let взято = 0;
  let забытых = 0;
  for (const з of заявки) {
    if (!ПОСТАВКА_ЭТАП[з.status] || НЕ_ВЕЗЁТ.has(з.subtype)) continue;
    if ((з.childrenLinks || []).length) continue;
    const когда = з.targetLocation?.requestedDate ? new Date(з.targetLocation.requestedDate) : null;
    if (когда && когда.getTime() < давно) { забытых += 1; continue; }
    const ид = з.id?.id;
    if (!ид) continue;
    взято += 1;
    const товары = await листать('ЯМ товары заявки', (токен) => {
      const п = new URLSearchParams({ limit: '500' });
      if (токен) п.set('page_token', токен);
      return ямЗапрос(`/v2/campaigns/${кампания}/supply-requests/items?${п}`, 'POST',
        { requestId: ид });
    }, 'items');
    const куда = з.targetLocation || {};
    const склад = имена.get(String(куда.serviceId)) || куда.name || String(куда.serviceId ?? '-');
    for (const т of товары) {
      const план = число(т.counters?.planCount);
      if (!план) continue;
      const принято = число(т.counters?.factCount);
      строки.push([
        String(ид), текстом(з.id?.marketplaceRequestId) || '-', ПОСТАВКА_ЭТАП[з.status],
        з.status, склад, вТаблицу(куда.requestedDate ? new Date(куда.requestedDate) : null),
        текстом(т.offerId) || '-', план, принято, Math.max(0, план - принято), отметка,
      ]);
    }
    await паузаЯМ(300);
  }
  const хвост = (забытых ? `, старых заявок пропущено ${забытых}` : '') + заметка;
  return { строки, заявок: взято, заметка: хвост };
}

export async function ямПоставкиFbo() {
  const { строки, заявок, заметка } = await ямПоставкиСтроки(требовать('YM_CAMPAIGN_FBY')[0]);
  await сохранить('FBO поставки Яндекс', строки);
  return `заявок в работе ${заявок}, строк ${строки.length}${заметка}`;
}

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
        ? [текстом(с.supplier_sku || с.sku) || '-', текстом(с.lamoda_sku || с.sku) || '-',
          с.warehouse || 'Склад Lamoda', доступно, число(с.reserved), отметка]
        : [текстом(с.supplier_sku || с.sku) || '-', текстом(с.lamoda_sku || с.sku) || '-',
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
    текстом(т.supplier_sku || т.sku) || '-', текстом(т.lamoda_sku || т.sku) || '-',
    число(т.quantity ?? 1), число(т.price), з.status || '-',
    з.delivery?.region || з.region || '-', отметка,
  ]));
  const итог = await сохранить(лист, строки);
  return `заказов ${заказы.length}, строк ${строки.length}, `
       + `новых ${итог.новых}, изменено ${итог.изменено}${итог.заметка}`;
}

export const лмЗаказыFbo = (з) => лмЗаказы('Заказы Ламода FBO', 'fbo', з);
export const лмЗаказыFbs = (з) => лмЗаказы('Заказы Ламода FBS', 'fbs', з);
