/**
 * Собирает все исходники в один документ docs/ves-kod.md.
 *
 * Свод — снимок, а не источник правды. Он устаревает молча, поэтому здесь же
 * пишется коммит, на котором он собран: расхождение видно без сравнения файлов.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';

const КОРЕНЬ = path.resolve(import.meta.dirname, '..');
const ИТОГ = path.join(КОРЕНЬ, 'docs', 'ves-kod.md');

/** Порядок не алфавитный, а от общего к частному: так его и читают. */
const ПОРЯДОК = [
  'src/index.js',
  'src/schemas.js',
  'src/config.js',
  'src/http.js',
  'src/sheets.js',
  'src/wb-ozon.js',
  'src/yandex-lamoda.js',
  'src/tz.js',
];

const ОПИСАНИЯ = {
  'src/index.js': 'Цикл расписания и таблица «задача → коннектор».',
  'src/schemas.js': 'Единственный источник правды: листы, колонки, ключи, номера строк.',
  'src/config.js': 'Чтение листа «Настройки», разбор строки задачи, отметка запуска.',
  'src/http.js': 'Запросы с повторами, даты, период, защита значений от Таблиц.',
  'src/sheets.js': 'Чтение и запись книги: снимки, дозапись, сравнение, шапка.',
  'src/wb-ozon.js': 'Коннекторы Wildberries и Ozon.',
  'src/yandex-lamoda.js': 'Коннекторы Яндекс Маркета и Ламоды.',
  'src/tz.js': 'Часовой пояс. Импортируется первым.',
};

async function собрать() {
  const вКаталоге = await readdir(path.join(КОРЕНЬ, 'src'));
  const все = вКаталоге.filter((и) => и.endsWith('.js')).map((и) => `src/${и}`);

  // файл, забытый в ПОРЯДКЕ, молча не выпадет из свода
  const забытые = все.filter((ф) => !ПОРЯДОК.includes(ф)).sort();
  const список = [...ПОРЯДОК.filter((ф) => все.includes(ф)), ...забытые];

  const пробы = (await readdir(path.join(КОРЕНЬ, 'проба')))
    .filter((и) => и.endsWith('.test.js')).sort().map((и) => `проба/${и}`);

  const служебные = (await readdir(path.join(КОРЕНЬ, 'scripts')))
    .filter((и) => и.endsWith('.mjs')).sort().map((и) => `scripts/${и}`);

  // якорь берём по последнему изменению src/, а не по HEAD: правки документации
  // не должны сдвигать отметку, а правка кода — обязана
  let коммит = 'неизвестен';
  try {
    коммит = execSync('git log -1 --format=%h -- src', { cwd: КОРЕНЬ }).toString().trim() || 'неизвестен';
  } catch { /* не репозиторий — не беда */ }

  const куски = [
    '# Весь код одним документом',
    '',
    'Собрано командой `npm run свод`. Код взят на коммите `' + коммит + '` —',
    'это последний коммит, менявший `src/`.',
    '',
    '> Это **снимок**. Источник правды — каталог `src/`. Правьте там, свод',
    '> пересобирайте. Свод устарел, если `git log -1 --format=%h -- src` даёт',
    '> не тот коммит, что назван выше.',
    '',
    'Карта кода — в [`roadmap.md`](roadmap.md), зашитые значения — в',
    '[`reestr-kodov.md`](reestr-kodov.md), порядок правок — в',
    '[`obnovlenie.md`](obnovlenie.md).',
    '',
    '## Содержание',
    '',
  ];

  const якорь = (ф) => ф.replace(/[/.]/g, '').toLowerCase();
  for (const ф of список) куски.push(`* [\`${ф}\`](#${якорь(ф)}) — ${ОПИСАНИЯ[ф] || ''}`);
  куски.push('', '**Пробы**', '');
  for (const ф of пробы) куски.push(`* [\`${ф}\`](#${якорь(ф)})`);
  куски.push('', '**Служебное**', '');
  for (const ф of служебные) куски.push(`* [\`${ф}\`](#${якорь(ф)})`);
  куски.push('', '---', '');

  for (const ф of [...список, ...пробы, ...служебные]) {
    const текст = await readFile(path.join(КОРЕНЬ, ф), 'utf8');
    куски.push(`## ${ф}`, '');
    if (ОПИСАНИЯ[ф]) куски.push(ОПИСАНИЯ[ф], '');
    куски.push(`Строк: ${текст.split('\n').length - 1}`, '', '```js', текст.replace(/\n$/, ''), '```', '');
  }

  await writeFile(ИТОГ, куски.join('\n'), 'utf8');
  const строк = куски.join('\n').split('\n').length;
  console.log('docs/ves-kod.md собран: файлов '
    + (список.length + пробы.length + служебные.length) + `, строк ${строк}`);
  if (забытые.length) console.log(`  (в ПОРЯДОК не вписаны: ${забытые.join(', ')})`);
}

await собрать();
