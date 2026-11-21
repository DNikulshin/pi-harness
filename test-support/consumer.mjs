/**
 * Фикстура «чистый проект потребителя»: ядро **из реестра**, шаблоны через `harness-init`,
 * настоящий каталог цикла.
 *
 * Зачем так, а не на поддельном `bin`: поддельный `bin` проверяет наш разбор ответа, но не
 * проверяет путь потребителя — установку шаблонов, `.pi/harness.version` и настоящий JSON
 * драйвера. Здесь всё настоящее, поэтому фикстура ходит в реестр (~1–2 с: у ядра нет зависимостей).
 *
 * Требования окружения, которые выяснились на пробе и которые легко не заметить:
 *
 * - `cycle-state init` вычисляет `base_sha` от ветки `main` (`git rev-parse --verify main`),
 *   поэтому в фикстуре должны существовать и `main`, и рабочая ветка задачи;
 * - `harness-init` пишет только в каталог проекта — `HOME` трогать не нужно;
 * - `git` нужен живой: инициализация цикла от него неотделима.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Версия ядра по умолчанию — пин из нашего `devDependencies`: один источник правды. */
export function pinnedCoreSpec() {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return `@dnikulshin/harness@${manifest.devDependencies['@dnikulshin/harness']}`;
}

/**
 * Запуск команды в каталоге фикстуры.
 * @param {string} command исполняемый файл
 * @param {string[]} args аргументы
 * @param {string} cwd каталог
 * @returns {Promise<{stdout: string, stderr: string}>} вывод
 */
async function run(command, args, cwd) {
  return exec(command, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
}

/**
 * `git` в фикстуре.
 * @param {string} cwd каталог
 * @param {string[]} args аргументы
 * @returns {Promise<void>} ничего
 */
async function git(cwd, args) {
  await run('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...args], cwd);
}

/**
 * Установка ядра с одного повтора: транзиентный 5xx реестра не должен выглядеть как дефект
 * адаптера, а второй отказ — уже настоящая проблема и должен быть виден.
 * @param {string} cwd каталог фикстуры
 * @param {string} spec спецификация пакета (`@dnikulshin/harness@0.2.0`)
 * @returns {Promise<string>} установленная версия
 */
async function installCore(cwd, spec) {
  const args = ['install', '--no-audit', '--no-fund', '--silent', '-D', spec];
  try {
    await run('npm', args, cwd);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await run('npm', args, cwd);
  }

  const manifest = JSON.parse(
    readFileSync(join(cwd, 'node_modules', '@dnikulshin', 'harness', 'package.json'), 'utf8'),
  );
  return manifest.version;
}

/**
 * Создать проект потребителя: ядро из реестра, шаблоны, инициализированный цикл.
 * @param {{spec?: string, issue?: number, slug?: string, branch?: string}} [options] параметры
 * @returns {Promise<{root: string, coreVersion: string, branch: string, cycleDir: string, bin: (name: string) => string}>}
 *   пути и версия
 */
export async function createConsumer({
  spec = pinnedCoreSpec(),
  issue = 999,
  slug = 'e2e-cycle',
  branch = 'feat/999-e2e-cycle',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-harness-e2e-'));

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'consumer-e2e', private: true }),
  );
  writeFileSync(join(root, 'AGENTS.md'), '# consumer-e2e\n\nПроект фикстуры E2E.\n');

  const coreVersion = await installCore(root, spec);
  const bin = (/** @type {string} */ name) => join(root, 'node_modules', '.bin', name);

  await run(process.execPath, [bin('harness-init')], root);
  if (!existsSync(join(root, '.pi', 'harness.version'))) {
    throw new Error('harness-init не записал .pi/harness.version');
  }

  // `base_sha` считается от `main`, а цикл живёт на ветке задачи: без обоих `cycle-state` откажет.
  await git(root, ['init', '-q']);
  await git(root, ['switch', '-q', '-f', '-c', 'main']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'chore: база фикстуры']);
  await git(root, ['switch', '-q', '-c', branch]);

  await run(
    process.execPath,
    [
      bin('harness-cycle-state'),
      'init',
      '--issue',
      String(issue),
      '--slug',
      slug,
      '--branch',
      branch,
    ],
    root,
  );

  const cycleDir = join(root, '.pi', 'artifacts', readCycleDirName(root));
  writeIssueSnapshot(cycleDir);

  return { root, coreVersion, branch, cycleDir, bin };
}

/**
 * Снимок issue — то, что в реальном цикле делает супервизор командой
 * `gh issue view N --json title,body,labels > <dir>/issue.json`.
 *
 * Без него шаг `criteria` отказывает `criteria_missing`: агент читает критерии из тела issue.
 * Секция — `### Готово, когда`: ядро разбирает тело как форму GitHub, где секции именно третьего
 * уровня (`.github/ISSUE_TEMPLATE/*.yml`).
 * @param {string} cycleDir каталог цикла
 * @returns {void}
 */
export function writeIssueSnapshot(cycleDir) {
  writeFileSync(
    join(cycleDir, 'issue.json'),
    JSON.stringify({
      title: 'E2E: проверка цикла на ядре из реестра',
      body: [
        '### Готово, когда',
        '',
        '- адаптер читает `next` по контракту `cycle-driver.next/1`;',
        '- `run` исполняет детерминированные шаги и останавливается на `spawn`.',
      ].join('\n'),
      labels: [{ name: 'type:feature' }],
    }),
  );
}

/**
 * Имя каталога цикла: единственный каталог в `.pi/artifacts`.
 * @param {string} root каталог фикстуры
 * @returns {string} имя каталога
 */
function readCycleDirName(root) {
  const artifacts = join(root, '.pi', 'artifacts');
  const names = readdirSync(artifacts).filter((entry) => !entry.startsWith('.'));

  if (names.length !== 1)
    throw new Error(`ожидался один каталог цикла, найдено: ${names.join(', ')}`);

  const [name] = names;
  if (name === undefined) throw new Error('каталог цикла не найден');

  return name;
}

/**
 * Убрать фикстуру.
 * @param {string} root каталог
 * @returns {void}
 */
export function removeConsumer(root) {
  rmSync(root, { recursive: true, force: true });
}

/**
 * Подменить версию установленного ядра (негативный сценарий).
 * @param {string} root каталог фикстуры
 * @param {string} version версия, которую «установили»
 * @returns {void}
 */
export function fakeCoreVersion(root, version) {
  const file = join(root, 'node_modules', '@dnikulshin', 'harness', 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...manifest, version }));
}

/**
 * Перезаписать `.pi/harness.version` (сценарий «ядро обновили, шаблоны — нет»).
 * @param {string} root каталог фикстуры
 * @param {string} version версия в артефакте
 * @returns {void}
 */
export function writeVersionArtifact(root, version) {
  mkdirSync(join(root, '.pi'), { recursive: true });
  writeFileSync(join(root, '.pi', 'harness.version'), JSON.stringify({ version, templates: {} }));
}
