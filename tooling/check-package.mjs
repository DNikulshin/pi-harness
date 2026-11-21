#!/usr/bin/env node
/**
 * Проверка собранного архива перед публикацией.
 *
 * Зачем. `npm publish` необратим: версию нельзя перезаписать, а ошибку в составе архива первым
 * видит потребитель. Поэтому релизный workflow публикует **не репозиторий, а архив `npm pack`**, и
 * между сборкой и публикацией стоит эта проверка: обязательные файлы, отсутствие тестов и CI,
 * цели `bin` (с битом исполнения) и `exports`, покрытие `files`, совпадение версии с тегом.
 *
 * Правила — в `tooling/package-contract.mjs`: их же проверяет тест на настоящем архиве
 * (`test/package-contract.test.mjs`), поэтому список не разъезжается с публикацией.
 *
 * Использование:
 * ```
 * node tooling/check-package.mjs <архив.tgz> [--tag vX.Y.Z] [--repository owner/repo]
 * ```
 * `--repository` сверяет `repository.url` с репозиторием сборки: без него `npm publish
 * --provenance` отвечает `E422` уже на публикации (так и вышло на теге `v0.1.1`).
 *
 * Коды выхода: `0` — архив годен; `1` — есть находки; `2` — ошибка использования или чтения архива.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { archiveProblems, parseVerboseListing } from './package-contract.mjs';

/**
 * Разбор аргументов.
 * @param {string[]} argv аргументы без имени скрипта
 * @returns {{file: string, tag: string | null, repository: string | null}} параметры
 * @throws {Error} если аргументы не по формату
 */
export function parseArgs(argv) {
  /** @type {string | null} */
  let file = null;
  /** @type {string | null} */
  let tag = null;
  /** @type {string | null} */
  let repository = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--tag') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || !/^v\d+\.\d+\.\d+/u.test(value)) {
        throw new Error('--tag: ожидается vX.Y.Z');
      }
      tag = value;
      index += 1;
      continue;
    }

    if (arg === '--repository') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || !/^[^/\s]+\/[^/\s]+$/u.test(value)) {
        throw new Error('--repository: ожидается owner/repo');
      }
      repository = value;
      index += 1;
      continue;
    }

    if (typeof arg === 'string' && arg.startsWith('-')) throw new Error(`неизвестный флаг: ${arg}`);
    if (file !== null) throw new Error(`лишний аргумент: ${arg}`);
    file = arg ?? null;
  }

  if (file === null) throw new Error('использование: check-package.mjs <архив.tgz> [--tag vX.Y.Z]');

  return { file, tag, repository };
}

/**
 * Записи и режимы архива.
 * @param {string} file путь к `.tgz`
 * @returns {{entries: string[], modes: Record<string, string>}} содержимое
 */
export function readArchive(file) {
  const listing = execFileSync('tar', ['-tvzf', file], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  return parseVerboseListing(listing.split('\n'));
}

/**
 * `package.json` из архива — то, что получит потребитель.
 * @param {string} file путь к `.tgz`
 * @returns {Record<string, any>} манифест
 */
export function readManifest(file) {
  const text = execFileSync('tar', ['-xOzf', file, 'package/package.json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  return JSON.parse(text);
}

/**
 * Проверить архив.
 * @param {{file: string, tag?: string | null, repository?: string | null}} params архив, тег, репозиторий
 * @returns {string[]} находки
 */
export function checkArchive({ file, tag = null, repository = null }) {
  const { entries, modes } = readArchive(file);
  const manifest = readManifest(file);

  return archiveProblems({ entries, modes, manifest, tag, repository });
}

// Запуск только при прямом исполнении: модуль импортируется тестом.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { file, tag, repository } = parseArgs(process.argv.slice(2));
    if (!existsSync(file)) throw new Error(`архив не найден: ${file}`);

    const problems = checkArchive({ file, tag, repository });
    if (problems.length === 0) {
      const parts = [
        tag === null ? null : `тег ${tag}`,
        repository === null ? null : `репозиторий ${repository}`,
      ].filter((part) => part !== null);
      console.log(
        `check-package: ${file} годен${parts.length === 0 ? '' : ` (${parts.join(', ')})`}`,
      );
    } else {
      for (const problem of problems) console.error(`check-package: ${problem}`);
      console.error(`check-package: находок ${problems.length} — публикация остановлена`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`check-package: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
