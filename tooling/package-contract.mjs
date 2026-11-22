/**
 * Контракт архива пакета: что обязано попасть в `.tgz`, чего в нём быть не должно и какие
 * обещания `package.json` проверяются на самом архиве.
 *
 * Зачем отдельный модуль от CLI: правила нужны двоим — релизному workflow (публикуется только
 * проверенный архив) и тесту (архив собирается `npm pack` и проверяется без публикации). Два
 * списка разошлись бы на первой правке `files`, а ошибка в составе видна только у потребителя:
 * не хватает `types/` — `tsc` у него падает; нет `bin` — `npx pi-harness-check` не находится.
 *
 * Модуль не читает файлов: получает список записей архива, режимы и разобранный `package.json`
 * архива. Поэтому правила проверяются на синтетических списках, а настоящий архив — одним тестом.
 *
 * Shebang не нужен: модуль подключается CLI и тестом.
 */

/** Что обязано быть в архиве, чтобы потребитель заработал. @type {readonly string[]} */
export const REQUIRED_ENTRIES = Object.freeze([
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'package.json',
  'src/artifacts.mjs',
  'src/extension.mjs',
  'src/compat.mjs',
  'src/core.mjs',
  'src/driver.mjs',
  'src/run.mjs',
  'scripts/check-core.mjs',
  'types/artifacts.d.mts',
  'types/extension.d.mts',
  'types/compat.d.mts',
  'types/core.d.mts',
  'types/driver.d.mts',
  'types/run.d.mts',
]);

/** Чего в архиве быть не должно: тесты и инфраструктура репозитория. @type {readonly string[]} */
export const FORBIDDEN_PREFIXES = Object.freeze([
  'node_modules/',
  'test/',
  'test-support/',
  'tooling/',
  '.github/',
  'coverage/',
]);

/**
 * Записи архива без ведущего `package/`.
 * @param {string[]} lines строки вывода `tar -tzf`
 * @returns {string[]} имена файлов и каталогов
 */
export function archiveEntries(lines) {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== 'package/')
    .map((line) => line.replace(/^package\//u, ''));
}

/**
 * Разбор `tar -tvzf`: имя и режим доступа (нужен для `bin`).
 * @param {string[]} lines строки вывода `tar -tvzf`
 * @returns {{entries: string[], modes: Record<string, string>}} имена и режимы
 */
export function parseVerboseListing(lines) {
  /** @type {Record<string, string>} */
  const modes = {};
  /** @type {string[]} */
  const entries = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    // Режим — первые 10 символов, дальше формат у tar разный: GNU печатает `owner/group size
    // date time`, BSD (macos) — `nlink owner group size date time`. Поэтому путь ищется по
    // маркеру `package/`, а не по номеру поля: иначе проверка проходит на linux и молча
    // превращается в «нет обязательных файлов» на macos.
    const mode = line.slice(0, 10);
    if (!/^[-dl][rwxsStT-]{9}$/u.test(mode)) continue;

    const marker = line.indexOf('package/');
    if (marker === -1) continue;

    const name = line.slice(marker + 'package/'.length).replace(/\s+.*$/u, '');
    if (name === '') continue;

    entries.push(name);
    modes[name] = mode;
  }

  return { entries, modes };
}

/**
 * Версия, обещанная тегом (`v0.1.0` → `0.1.0`).
 * @param {string} tag тег
 * @returns {string} версия
 */
export function versionFromTag(tag) {
  return tag.trim().replace(/^v/u, '');
}

/**
 * Находки в архиве.
 * @param {object} params параметры
 * @param {string[]} params.entries имена файлов архива
 * @param {Record<string, string>} [params.modes] режимы доступа по имени
 * @param {Record<string, any>} params.manifest `package.json` архива
 * @param {string | null} [params.tag] тег релиза (`v0.1.0`)
 * @param {string | null} [params.repository] репозиторий сборки (`owner/repo`) для сверки `repository.url`
 * @returns {string[]} находки: пусто — архив годен
 */
export function archiveProblems({ entries, modes = {}, manifest, tag = null, repository = null }) {
  /** @type {string[]} */
  const problems = [];
  const files = new Set(entries);

  for (const required of REQUIRED_ENTRIES) {
    if (!files.has(required)) problems.push(`нет обязательного файла: ${required}`);
  }

  for (const entry of entries) {
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (entry === prefix || entry.startsWith(prefix)) {
        problems.push(`в архиве лишнее: ${entry}`);
      }
    }
  }

  for (const [name, target] of binTargets(manifest)) {
    if (!files.has(target)) problems.push(`bin ${name} указывает на отсутствующий файл: ${target}`);
    else if (!isExecutable(modes[target])) {
      problems.push(`bin ${name}: файл ${target} без бита исполнения (npx ответит 126/127)`);
    }
  }

  for (const [key, target] of exportTargets(manifest)) {
    if (!files.has(target))
      problems.push(`exports["${key}"] указывает на отсутствующий файл: ${target}`);
  }

  for (const entry of filesField(manifest)) {
    const prefix = entry.endsWith('/') ? entry : `${entry}/`;
    const covered = [...files].some((file) => file === entry || file.startsWith(prefix));
    if (!covered) problems.push(`files: путь ${entry} ничего не содержит`);
  }

  if (manifest.private === true)
    problems.push('package.json: private=true — публикация невозможна');

  const peer = manifest.peerDependencies?.['@dnikulshin/harness'];
  if (typeof peer !== 'string' || peer.trim() === '') {
    problems.push(
      'package.json: нет peerDependencies["@dnikulshin/harness"] — совместимость не объявлена',
    );
  }

  if (repository !== null && repository !== '') {
    const declared = manifest.repository?.url;
    if (typeof declared !== 'string' || declared.trim() === '') {
      problems.push(
        'package.json: нет repository.url — npm publish --provenance отвечает E422 (сверить пакет с репозиторием нечем)',
      );
    } else if (
      normalizeRepository(declared) !== normalizeRepository(`https://github.com/${repository}`)
    ) {
      problems.push(
        `package.json: repository.url ${declared} не совпадает с репозиторием сборки ${repository} — provenance-проверка npm отвергнет архив`,
      );
    }
  }

  if (tag !== null && tag !== '') {
    const expected = versionFromTag(tag);
    if (manifest.version !== expected) {
      problems.push(`версия в архиве ${manifest.version} не совпадает с тегом ${tag}`);
    }
  }

  return problems;
}

/**
 * Цели `bin`.
 * @param {Record<string, any>} manifest `package.json`
 * @returns {Array<[string, string]>} пары «имя → путь»
 */
function binTargets(manifest) {
  const bin = manifest.bin;
  if (typeof bin === 'string') return [['(единственный)', normalize(bin)]];
  if (bin === null || typeof bin !== 'object') return [];

  return Object.entries(bin)
    .filter(([, target]) => typeof target === 'string')
    .map(([name, target]) => [name, normalize(/** @type {string} */ (target))]);
}

/**
 * Цели `exports` (значения и вложенные условия `types`/`default`).
 * @param {Record<string, any>} manifest `package.json`
 * @returns {Array<[string, string]>} пары «ключ → путь»
 */
function exportTargets(manifest) {
  const exports = manifest.exports;
  if (exports === null || typeof exports !== 'object') return [];

  /** @type {Array<[string, string]>} */
  const targets = [];
  for (const [key, value] of Object.entries(exports)) {
    if (typeof value === 'string') {
      targets.push([key, normalize(value)]);
      continue;
    }
    if (value === null || typeof value !== 'object') continue;

    for (const [condition, target] of Object.entries(value)) {
      if (typeof target === 'string') {
        targets.push([`${key} (${condition})`, normalize(target)]);
      }
    }
  }

  return targets;
}

/**
 * Записи `files`.
 * @param {Record<string, any>} manifest `package.json`
 * @returns {string[]} пути
 */
function filesField(manifest) {
  return Array.isArray(manifest.files)
    ? manifest.files.filter((entry) => typeof entry === 'string')
    : [];
}

/**
 * Repository URL в каноническом виде для сравнения: без схемы `git+`, `.git`, слэша на конце и в
 * нижнем регистре — npm сравнивает именно так (`git+https://github.com/o/r.git` ≡
 * `https://github.com/o/r`).
 * @param {string} url адрес репозитория
 * @returns {string} каноническая форма
 */
export function normalizeRepository(url) {
  return url
    .trim()
    .toLowerCase()
    .replace(/^git\+/u, '')
    .replace(/^ssh:\/\/git@/u, 'https://')
    .replace(/^git@([^:]+):/u, 'https://$1/')
    .replace(/\.git$/u, '')
    .replace(/\/+$/u, '');
}

/**
 * Путь без ведущего `./` — в архиве имена без него.
 * @param {string} path путь из манифеста
 * @returns {string} нормализованный путь
 */
function normalize(path) {
  return path.replace(/^\.\//u, '');
}

/**
 * Есть ли у файла бит исполнения для владельца.
 * @param {string | undefined} mode режим (`-rwxr-xr-x`)
 * @returns {boolean} `true`, если исполняемый
 */
function isExecutable(mode) {
  if (typeof mode !== 'string' || mode.length < 4) return false;

  return mode[3] === 'x';
}
