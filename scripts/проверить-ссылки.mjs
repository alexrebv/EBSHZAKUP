/**
 * Проверяет ссылки вида `файл.js:номер` в документации.
 *
 * Номера строк устаревают молча — документ продолжает выглядеть точным, указывая
 * не туда. Содержимое здесь не сверяется: это проверка на «ссылка ведёт хоть
 * куда-то», а не на «ссылка ведёт туда, куда сказано».
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const КОРЕНЬ = path.resolve(import.meta.dirname, '..');
const ССЫЛКА = /`([\wа-яё-]+\.(?:js|mjs)):(\d+)`/giu;

/** Где искать файл, на который ссылаются: имя в ссылке дано без каталога. */
const КАТАЛОГИ = ['src', 'проба', 'scripts', '.'];

async function найти(имя) {
  for (const к of КАТАЛОГИ) {
    try {
      const п = path.join(КОРЕНЬ, к, имя);
      return { путь: п, текст: await readFile(п, 'utf8') };
    } catch { /* в следующем каталоге */ }
  }
  return null;
}

const документы = (await readdir(path.join(КОРЕНЬ, 'docs')))
  .filter((и) => и.endsWith('.md') && и !== 'ves-kod.md');

let всего = 0;
let плохо = 0;
const кэш = new Map();

for (const док of документы) {
  const текст = await readFile(path.join(КОРЕНЬ, 'docs', док), 'utf8');
  for (const [целиком, имя, номер] of текст.matchAll(ССЫЛКА)) {
    всего += 1;
    if (!кэш.has(имя)) кэш.set(имя, await найти(имя));
    const файл = кэш.get(имя);
    if (!файл) {
      console.log(`  ${док}: ${целиком} — такого файла нет`);
      плохо += 1;
      continue;
    }
    const строки = файл.текст.split('\n');
    const n = Number(номер);
    if (n < 1 || n > строки.length) {
      console.log(`  ${док}: ${целиком} — за пределами файла (строк ${строки.length})`);
      плохо += 1;
    } else if (!строки[n - 1].trim()) {
      console.log(`  ${док}: ${целиком} — пустая строка`);
      плохо += 1;
    }
  }
}

console.log(`ссылок проверено ${всего}, битых ${плохо}`);
if (плохо) process.exitCode = 1;
