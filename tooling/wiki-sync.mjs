#!/usr/bin/env node
/**
 * Публикация вики из репозитория: `.github/wiki/*.md` → wiki-репозиторий GitHub.
 *
 * Своя реализация, а не импорт ядра (ADR 0004/0008): у адаптера нет доступа к `scripts/lib/**`, а
 * правило «страницы живут в репозитории» — свойство этого репозитория, а не контракта ядра.
 *
 * Зачем синхронизация, а не «править прямо на вики»: у проекта уже есть норматив в `docs/`, и второй
 * источник правды разъехался бы на первой правке. Страницы вики живут в репозитории, проходят ревью
 * в PR и публикуются одним и тем же коммитом, что и код.
 *
 * Что делает: читает страницы, клонирует wiki-репозиторий (`<owner>/<repo>.wiki.git`), сравнивает,
 * пишет только изменения, удаляет страницы, которых в репозитории больше нет, и делает один коммит.
 * Ничего не публикует, если сравнивать нечего.
 *
 * Использование:
 *   node tooling/wiki-sync.mjs [--dry-run] [--slug owner/repo] [--message "текст"]
 *
 * `--dry-run` печатает план и не трогает вики: полезно перед первым запуском и в локальной проверке.
 * Токен берётся из `WIKI_TOKEN` или `GITHUB_TOKEN` (в CI — `secrets.GITHUB_TOKEN`); без токена
 * используется обычная авторизация git владельца.
 *
 * Коды выхода: `0` — опубликовано или публиковать нечего; `2` — отказ (нет git, нет страниц, вики
 * выключена, ошибка push).
 *
 * Shebang нужен: скрипт запускается напрямую из workflow и как `pnpm wiki:sync`.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';

/** Каталог страниц вики внутри репозитория. */
export const WIKI_DIR = join('.github', 'wiki');

/** Расширение страниц: GitHub wiki — это markdown-файлы в корне своего репозитория. */
const PAGE_SUFFIX = '.md';

/** Сообщение коммита по умолчанию. */
const DEFAULT_MESSAGE = 'wiki: синхронизация из репозитория';

/**
 * Страницы из каталога: имя файла → содержимое. Читаются только `.md` — остальное в wiki-репозиторий
 * не попадает случайно.
 * @param {string} dir каталог со страницами
 * @returns {Record<string, string>} страницы
 */
export function readPages(dir) {
  if (!existsSync(dir)) return {};

  /** @type {Record<string, string>} */
  const pages = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith(PAGE_SUFFIX)) continue;
    pages[entry.name] = readFileSync(join(dir, entry.name), 'utf8');
  }

  return pages;
}

/**
 * План публикации: что записать, что удалить и что уже совпадает.
 *
 * Отдельная чистая функция, потому что именно здесь решается «делать коммит или нет»: пустая разница
 * не должна порождать коммит в вики на каждый push.
 * @param {{pages?: Record<string, string>, existing?: Record<string, string>}} [params] страницы
 *   репозитория и текущее состояние вики
 * @returns {{write: string[], remove: string[], unchanged: string[]}} план
 */
export function planSync({ pages = {}, existing = {} } = {}) {
  /** @type {string[]} */
  const write = [];
  /** @type {string[]} */
  const unchanged = [];

  for (const [name, content] of Object.entries(pages).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (existing[name] === content) unchanged.push(name);
    else write.push(name);
  }

  const remove = Object.keys(existing)
    .filter((name) => !(name in pages))
    .sort((left, right) => left.localeCompare(right));

  return { write, remove, unchanged };
}

/**
 * `owner/repo` из адреса удалённого репозитория: `https://…`, `git@…:owner/repo.git`, `owner/repo`.
 * @param {unknown} remote адрес `origin`
 * @returns {string | null} слаг или `null`, если разобрать не удалось
 */
export function repoSlugFromRemote(remote) {
  if (typeof remote !== 'string') return null;

  // Хвостовой слэш до `.git`: `…/repo.git/` встречается в скопированных адресах.
  const cleaned = remote
    .trim()
    .replace(/\/+$/u, '')
    .replace(/\.git$/u, '');
  if (cleaned === '') return null;

  const bySsh = /^[^@]+@[^:]+:(?<path>.+)$/u.exec(cleaned);
  if (bySsh?.groups?.['path'] !== undefined) return normalizeSlug(bySsh.groups['path']);

  const byUrl = /^[a-z]+:\/\/[^/]+\/(?<path>.+)$/iu.exec(cleaned);
  if (byUrl?.groups?.['path'] !== undefined) return normalizeSlug(byUrl.groups['path']);

  return normalizeSlug(cleaned);
}

/**
 * `owner/repo` без лишних сегментов пути.
 * @param {string} path путь из адреса
 * @returns {string | null} слаг
 */
function normalizeSlug(path) {
  const parts = path
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length < 2) return null;

  const [owner, repo] = parts;
  if (owner === undefined || repo === undefined) return null;

  return `${owner}/${repo}`;
}

/**
 * Запуск git в каталоге: вывод строкой, ошибка — исключением с понятным текстом.
 * @param {string[]} args аргументы
 * @param {{cwd?: string}} [options] рабочий каталог
 * @returns {string} stdout
 */
function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  }).trim();
}

/**
 * Слаг репозитория: `--slug`, иначе `origin` текущего репозитория.
 * @param {string | null} explicit явный `--slug`
 * @param {string} root корень репозитория
 * @returns {string} слаг
 * @throws {Error} если слаг не определён
 */
function resolveSlug(explicit, root) {
  if (explicit !== null && explicit !== '') return explicit;

  const remote = git(['remote', 'get-url', 'origin'], { cwd: root });
  const slug = repoSlugFromRemote(remote);
  if (slug === null) {
    throw new Error(`не удалось определить owner/repo из адреса origin: ${remote}`);
  }

  return slug;
}

/**
 * Клон wiki-репозитория; пустая вики (репозитория ещё нет) — `git init` с тем же адресом.
 * @param {string} url адрес вики
 * @param {string} dir куда клонировать
 * @returns {boolean} `true`, если клон удался (иначе репозиторий инициализирован заново)
 */
function cloneWiki(url, dir) {
  try {
    git(['clone', '--depth', '1', '--quiet', url, dir]);
    return true;
  } catch {
    mkdirSync(dir, { recursive: true });
    git(['init', '--quiet'], { cwd: dir });
    git(['remote', 'add', 'origin', url], { cwd: dir });
    return false;
  }
}

/**
 * Точка входа CLI.
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   log?: (line: string) => void,
 *   stderr?: (line: string) => void,
 *   root?: string,
 * }} [deps] зависимости, подставленные тестами
 * @returns {number} код выхода
 */
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  log = console.log,
  stderr = console.error,
  root = process.cwd(),
} = {}) {
  const dryRun = argv.includes('--dry-run');
  const slugFlag = valueOf(argv, '--slug');
  const message = valueOf(argv, '--message') ?? DEFAULT_MESSAGE;

  let work = '';
  try {
    const repoRoot = git(['rev-parse', '--show-toplevel'], { cwd: root });
    const pages = readPages(join(repoRoot, WIKI_DIR));
    const names = Object.keys(pages);
    if (names.length === 0) {
      stderr(`wiki-sync: в ${WIKI_DIR} нет ни одной страницы — публиковать нечего`);
      return 2;
    }

    const slug = resolveSlug(slugFlag, repoRoot);
    const token = env.WIKI_TOKEN ?? env.GITHUB_TOKEN ?? '';
    const url =
      token === ''
        ? `https://github.com/${slug}.wiki.git`
        : `https://x-access-token:${token}@github.com/${slug}.wiki.git`;

    work = mkdtempSync(join(tmpdir(), 'wiki-sync-'));
    const wiki = join(work, 'wiki');
    const cloned = cloneWiki(url, wiki);
    const plan = planSync({ pages, existing: readPages(wiki) });

    if (plan.write.length === 0 && plan.remove.length === 0) {
      log(`wiki-sync: ${slug} — публиковать нечего (страниц ${names.length})`);
      return 0;
    }

    log(
      `wiki-sync: ${slug} — записать ${plan.write.length}, удалить ${plan.remove.length}, ` +
        `без изменений ${plan.unchanged.length}`,
    );
    for (const name of plan.write) log(`  + ${name}`);
    for (const name of plan.remove) log(`  - ${name}`);

    if (dryRun) {
      log('wiki-sync: --dry-run, вики не менялась');
      return 0;
    }

    for (const name of plan.write) writeFileSync(join(wiki, name), pages[name] ?? '');
    for (const name of plan.remove) rmSync(join(wiki, name), { force: true });

    git(['add', '--all'], { cwd: wiki });
    git([...identityArgs(env), 'commit', '--quiet', '--message', message], { cwd: wiki });

    const branch = cloned ? currentBranch(wiki) : 'master';
    git(['push', '--quiet', 'origin', `HEAD:${branch}`], { cwd: wiki });
    log(`wiki-sync: опубликовано (${cloned ? `клон, ветка ${branch}` : 'первая публикация'})`);
    return 0;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const first = text.split('\n')[0] ?? text;
    stderr(`wiki-sync: ${first}`);

    // Отдельный текст для самого частого первого запуска: wiki-репозитория ещё нет.
    if (/repository not found|does not appear to be a git repository/iu.test(text)) {
      stderr(
        'wiki-sync: wiki-репозитория нет. GitHub создаёт его при первой странице: откройте ' +
          'Settings → Features → Wikis (включено) и создайте любую страницу через «New page» в ' +
          'интерфейсе вики, дальше синхронизация идёт сама.',
      );
      return 2;
    }

    stderr(
      'wiki-sync: проверьте, что вики включена (Settings → Features → Wikis) и что у токена есть ' +
        'право писать в репозиторий.',
    );
    return 2;
  } finally {
    if (work !== '') rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Личность для коммита. У runner нет глобального `user.name`/`user.email`, поэтому в CI подставляем
 * бота; при локальном запуске коммит идёт от владельца — врать про авторство в истории вики незачем.
 * @param {NodeJS.ProcessEnv} env окружение
 * @returns {string[]} аргументы `git -c …` или пустой список для локального запуска
 */
function identityArgs(env) {
  const inCi = env.CI === 'true' || env.CI === '1';

  return inCi
    ? [
        '-c',
        'user.name=github-actions[bot]',
        '-c',
        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      ]
    : [];
}

/**
 * Текущая ветка клона: у свежего wiki-репозитория это `master`.
 * @param {string} dir каталог клона
 * @returns {string} имя ветки
 */
function currentBranch(dir) {
  try {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }) || 'master';
  } catch {
    return 'master';
  }
}

/**
 * Значение флага: `--flag value` или `--flag=value`.
 * @param {string[]} argv аргументы
 * @param {string} flag имя флага
 * @returns {string | null} значение
 */
function valueOf(argv, flag) {
  const index = argv.indexOf(flag);
  if (index !== -1) {
    const value = argv[index + 1];
    return value === undefined || value.startsWith('--') ? null : value;
  }

  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline === undefined ? null : inline.slice(flag.length + 1);
}

/**
 * Запущен ли файл напрямую (а не импортирован тестом).
 * @param {string} moduleUrl `import.meta.url`
 * @returns {boolean} `true`, если это точка входа процесса
 */
function isDirectRun(moduleUrl) {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return false;

  return fileURLToPath(moduleUrl) === entry;
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
