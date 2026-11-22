/**
 * Тесты артефактов цикла (`src/artifacts.mjs`) и подкоманд показа (issue #4).
 *
 * Ядро не требуется и не импортируется: фикстуры — каталоги `.pi/artifacts/**` во временном
 * проекте, драйвер — поддельный `bin` из `test-support/fake-project.mjs`. Сценарии покрывают
 * обе стороны: валидные артефакты (что видит человек) и битые/отсутствующие (текст ошибки вместо
 * исключения).
 *
 * Отдельная проверка — «только чтение»: адаптер не пишет в `.pi/artifacts/**`, и это проверяется
 * и по исходникам (нет вызывающих запись), и по факту (снимок каталога до и после команд).
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EVIDENCE_DIR,
  MAX_EVIDENCE_LINES,
  MAX_GATE_LOG_LINES,
  STATE_FILE,
  artifactIteration,
  describeDecision,
  describeEvidence,
  describeEvidenceFile,
  describeGates,
  describeState,
  findCycleDir,
  gateLogHead,
  iterationFileName,
  listEvidence,
  parseIteration,
  readArtifact,
  readEvidenceFile,
  resolveCycleDir,
} from '../src/artifacts.mjs';
import extension, { SUBCOMMANDS, helpText, parseRest, parseSubcommand } from '../src/extension.mjs';
import { cleanup, fakeProject, nextResponse } from '../test-support/fake-project.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

after(cleanup);

/** Временные каталоги теста. @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Временный каталог с фикстурой каталога цикла.
 * @param {object} [files] содержимое каталога цикла: имя → объект (JSON) или строка
 * @returns {string} путь каталога цикла
 */
function cycleDir(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-harness-artifacts-'));
  dirs.push(root);

  const dir = join(root, '2026-11-21-12-demo-task');
  mkdirSync(dir, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }

  return dir;
}

/** Полный `state.json` по Приложению A. */
const STATE = {
  issue: 12,
  slug: 'demo-task',
  branch: 'feat/12-demo-task',
  base_sha: 'a'.repeat(40),
  iteration: 2,
  max_iterations: 3,
  stage: 'REWORK',
  stage_status: 'running',
  criteria_source: 'issue',
  criteria_sha256: 'b'.repeat(64),
  retries: { REVIEW: 1, EVALUATE: 0, evidence: 2 },
  owner_approved: true,
  models: { plan: 'provider/one', code: 'provider/two' },
  history: [
    {
      stage: 'INIT',
      iteration: 1,
      started_at: '2026-11-21T00:00:00Z',
      finished_at: '2026-11-21T00:00:01Z',
      status: 'done',
    },
    {
      stage: 'CODE',
      iteration: 2,
      started_at: '2026-11-21T01:00:00Z',
      finished_at: null,
      status: 'running',
    },
  ],
  escalation: null,
  applied_decision: { iteration: 1, action: 'REWORK', retry_stage: 'CODE', digest: 'c'.repeat(64) },
  started_at: '2026-11-21T00:00:00Z',
  updated_at: '2026-11-21T01:00:00Z',
};

describe('parseIteration: номер итерации из аргумента', () => {
  test('пусто — текущая итерация, без ошибки', () => {
    assert.deepEqual(parseIteration(undefined), { iteration: null, error: null });
    assert.deepEqual(parseIteration('   '), { iteration: null, error: null });
  });

  test('число разбирается', () => {
    assert.deepEqual(parseIteration('3'), { iteration: 3, error: null });
  });

  test('не число и ноль — ошибка с показанным значением', () => {
    for (const bad of ['два', '2.5', '0', '-1']) {
      const parsed = parseIteration(bad);
      assert.equal(parsed.iteration, null, bad);
      assert.match(parsed.error ?? '', /целое ≥ 1/u, bad);
    }
  });
});

describe('iterationFileName: имена файлов итерации', () => {
  test('gates и decision с номером', () => {
    assert.equal(iterationFileName('gates', 2), 'gates.2.json');
    assert.equal(iterationFileName('decision', 1), 'decision.1.json');
  });

  test('неположительный номер — исключение программиста, а не артефакта', () => {
    assert.throws(() => iterationFileName('gates', 0), /целым ≥ 1/u);
  });
});

describe('resolveCycleDir: путь из ответа драйвера', () => {
  test('абсолютный берётся как есть', () => {
    assert.equal(
      resolveCycleDir({ root: '/repo', dir: '/repo/.pi/artifacts/x' }),
      '/repo/.pi/artifacts/x',
    );
  });

  test('относительный считается от корня проекта', () => {
    assert.equal(
      resolveCycleDir({ root: '/repo', dir: '.pi/artifacts/x' }),
      '/repo/.pi/artifacts/x',
    );
  });

  test('пусто или не строка — null, а не «/repo/undefined»', () => {
    assert.equal(resolveCycleDir({ root: '/repo', dir: null }), null);
    assert.equal(resolveCycleDir({ root: '/repo', dir: '' }), null);
    assert.equal(resolveCycleDir({ root: '/repo', dir: 42 }), null);
  });
});

describe('findCycleDir: резервный поиск по `.pi/artifacts/`', () => {
  test('каталога артефактов нет — текст, а не исключение', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-harness-noartifacts-'));
    dirs.push(root);

    const found = findCycleDir(root);
    assert.equal(found.dir, null);
    assert.match(found.error ?? '', /цикл в этом проекте не начинался/u);
  });

  test('единственный каталог со state.json найден, в том числе терминальный', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-harness-one-'));
    dirs.push(root);
    const dir = join(root, '.pi', 'artifacts', '2026-11-21-12-done');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ ...STATE, stage: 'DONE' }));

    assert.equal(findCycleDir(root).dir, dir);
  });

  test('несколько каталогов — отказ со списком, без угадывания', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-harness-many-'));
    dirs.push(root);
    for (const name of ['2026-11-21-12-one', '2026-11-22-13-two']) {
      const dir = join(root, '.pi', 'artifacts', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, STATE_FILE), JSON.stringify(STATE));
    }

    const found = findCycleDir(root);
    assert.equal(found.dir, null);
    assert.match(found.error ?? '', /несколько каталогов цикла/u);
    assert.match(found.error ?? '', /2026-11-21-12-one/u);
  });
});

describe('readArtifact: битый и отсутствующий файл', () => {
  test('валидный JSON разбирается', () => {
    const dir = cycleDir({ [STATE_FILE]: STATE });
    const artifact = readArtifact(dir, STATE_FILE);

    assert.equal(artifact.error, null);
    assert.equal(artifactIteration(artifact.value), 2);
  });

  test('нет файла — «нет файла», а не ENOENT', () => {
    const dir = cycleDir({});
    const artifact = readArtifact(dir, 'gates.1.json');

    assert.equal(artifact.value, null);
    assert.match(artifact.error ?? '', /нет файла gates\.1\.json/u);
  });

  test('оборванный JSON — текст ошибки без содержимого файла', () => {
    const dir = cycleDir({ 'gates.1.json': '{"iteration": 1, "gates": [' });
    const artifact = readArtifact(dir, 'gates.1.json');

    assert.equal(artifact.value, null);
    assert.match(artifact.error ?? '', /не разобран как JSON/u);
    assert.ok(!(artifact.error ?? '').includes('"iteration"'), 'содержимое файла в ошибку не идёт');
  });
});

describe('describeState: состояние цикла по-человечески', () => {
  test('стадия, шаг, итерация, ожидание, критерии, повторы, решение', () => {
    const text = describeState(STATE);

    assert.match(text, /Стадия REWORK \(running\) · итерация 2 из 3/u);
    assert.match(text, /issue #12 · demo-task · ветка feat\/12-demo-task/u);
    assert.match(text, /Критерии: заморожены \(bbbbbbbb…\)/u);
    assert.match(text, /Идёт|Ждём: завершения CODE/u);
    assert.match(text, /Закрыт последним: INIT done/u);
    assert.match(text, /Повторы: REVIEW 1 · EVALUATE 0 · evidence 2/u);
    assert.match(text, /Подтверждение владельца: да/u);
    assert.match(text, /Применено решение: REWORK \(итерация 1\)/u);
  });

  test('эскалация видна как ожидание владельца', () => {
    const text = describeState({
      ...STATE,
      escalation: { reason: 'iteration_limit', detail: 'лимит итераций', draft_pr_allowed: true },
    });

    assert.match(text, /Ждём: решения владельца — эскалация iteration_limit: лимит итераций/u);
  });

  test('минимальный state.json не падает на отсутствующих полях', () => {
    const text = describeState({ stage: 'CODE', stage_status: 'running', iteration: 1 });

    assert.match(text, /Стадия CODE \(running\)/u);
    assert.match(text, /Критерии: не заморожены/u);
    assert.match(text, /открытых этапов нет/u);
  });

  test('не объект — текст ошибки', () => {
    assert.match(describeState(null), /ожидался объект состояния/u);
    assert.match(describeState([1, 2]), /ожидался объект состояния/u);
  });

  test('терминальный цикл: «завершён», а не «ждём завершения DONE»', () => {
    const text = describeState({ ...STATE, stage: 'DONE', stage_status: 'running' });

    assert.match(text, /Ждём: ничего — цикл завершён \(DONE\)/u);
    assert.ok(!text.includes('Ждём: завершения DONE'), 'завершённый цикл никого не ждёт');
  });
});

describe('describeGates: что прошло, что нет и первые строки', () => {
  const gates = {
    iteration: 1,
    base_sha: 'a'.repeat(40),
    head: 'deadbeef'.repeat(5),
    started_at: '2026-11-21T00:00:00Z',
    gates: [
      {
        id: 'typecheck',
        cmd: 'pnpm typecheck',
        required: true,
        status: 'pass',
        exit: 0,
        duration_s: 11,
        log: 'gates/typecheck.1.log',
        reason: null,
      },
      {
        id: 'test',
        cmd: 'pnpm test',
        required: true,
        status: 'fail',
        exit: 1,
        duration_s: 12.5,
        log: 'gates/test.1.log',
        reason: null,
      },
      {
        id: 'lint_workflows',
        cmd: null,
        required: false,
        status: 'skipped',
        exit: null,
        duration_s: 0,
        log: null,
        reason: 'not_applicable',
      },
      {
        id: 'test_int',
        cmd: 'pnpm test:int',
        required: true,
        status: 'not_run',
        exit: null,
        duration_s: 0,
        log: null,
        reason: 'no_database',
      },
    ],
  };

  const longLog = Array.from({ length: 40 }, (_, index) => `строка ${index + 1}`).join('\n');

  test('сводка, код возврата, причина и лог у упавшего гейта', () => {
    const dir = cycleDir({ 'gates.1.json': gates, 'gates/test.1.log': longLog });
    const text = describeGates(dir, gates);

    assert.match(text, /Гейты итерации 1: pass 1 · fail 1 · skipped 1 · not_run 1 · head deadbee/u);
    assert.match(text, /pass typecheck · required · код 0 · 11s/u);
    assert.match(text, /fail test · required · код 1 · 12\.5s · лог gates\/test\.1\.log/u);
    assert.match(text, /skipped lint_workflows · причина not_applicable/u);
    assert.match(text, /not_run test_int · required · причина no_database/u);
  });

  test('печатаются только первые строки лога: полный вывод — простыня', () => {
    const dir = cycleDir({ 'gates/test.1.log': longLog });
    const text = describeGates(dir, gates);

    assert.match(text, /первые строки вывода:/u);
    assert.match(text, /│ строка 1\b/u);
    assert.match(text, new RegExp(`│ строка ${MAX_GATE_LOG_LINES}\\b`, 'u'));
    assert.ok(!text.includes(`строка ${MAX_GATE_LOG_LINES + 1}`), 'дальше первых строк не идём');
  });

  test('нет лога — сказано, а не пустое место', () => {
    const dir = cycleDir({});
    const text = describeGates(dir, gates);

    assert.match(text, /лог gates\/test\.1\.log не найден/u);
  });

  test('лог снаружи каталога цикла не читается', () => {
    const dir = cycleDir({});
    const escaped = {
      ...gates,
      gates: [{ ...gates.gates[1], log: '../../etc/passwd' }],
    };

    assert.match(describeGates(dir, escaped), /путь вне каталога цикла/u);
    assert.deepEqual(gateLogHead(dir, '/etc/passwd').lines, []);
  });

  test('длинная строка обрезается', () => {
    const dir = cycleDir({ 'gates/test.1.log': 'x'.repeat(5000) });
    const head = gateLogHead(dir, 'gates/test.1.log');

    assert.equal(head.lines.length, 1);
    assert.ok((head.lines[0] ?? '').length <= 201, 'строка лога обрезана до разумной длины');
  });

  test('пустой список гейтов — факт, а не падение', () => {
    assert.match(
      describeGates('/', { iteration: 1, gates: [] }),
      /гейты этой итерации не запускались/u,
    );
    assert.match(describeGates('/', null), /ожидался объект с полем gates/u);
  });
});

describe('describeDecision: решение и его причина', () => {
  test('действие, причина, возврат, добор, понижения', () => {
    const text = describeDecision({
      iteration: 2,
      action: 'REWORK',
      retry_stage: 'CODE',
      acquire: [],
      reasons: ['gate:test', 'review:BLOCKER-1'],
      rework_items: ['починить падающий тест'],
      unverified: ['qa:web'],
      downgraded: ['MAJOR-2 -> FOLLOW-UP'],
      counts: { unresolved_refs: 0 },
    });

    assert.match(text, /Решение итерации 2: REWORK → повтор CODE/u);
    assert.match(text, /Причины \(2\):\n {2}· gate:test\n {2}· review:BLOCKER-1/u);
    assert.match(text, /На доработку \(1\):\n {2}· починить падающий тест/u);
    assert.match(text, /Понижено \(1\):\n {2}· MAJOR-2 -> FOLLOW-UP/u);
    assert.match(text, /Не подтверждено \(1\):\n {2}· qa:web/u);
    assert.match(text, /Неразрешённых ссылок: 0/u);
  });

  test('длинные списки режутся: абзацы решения не уезжают целиком', () => {
    const items = Array.from({ length: 9 }, (_, index) => `пункт ${index + 1} ${'х'.repeat(400)}`);
    const text = describeDecision({ action: 'REWORK', unverified: items });

    assert.match(text, /Не подтверждено \(9\):/u);
    assert.match(text, /…и ещё 4/u);
    for (const line of text.split('\n').filter((row) => row.includes('· пункт'))) {
      assert.ok(line.length <= 320, `элемент списка обрезан, получено ${line.length}`);
    }
  });

  test('без action — понятный отказ: решение не записано', () => {
    assert.match(describeDecision({ iteration: 1 }), /нет поля action/u);
    assert.match(describeDecision('текст'), /ожидался объект решения/u);
  });

  test('не-строки в массивах не превращаются в текст', () => {
    const text = describeDecision({ action: 'PROCEED', reasons: [1, null, 'gate:test'] });

    assert.match(text, /Причины \(1\):/u);
    assert.match(text, /· gate:test/u);
    assert.ok(!text.includes('null'), 'не-строки в список не попадают');
  });
});

describe('listEvidence и показ файла', () => {
  test('файлы с размерами, включая вложенные', () => {
    const dir = cycleDir({
      [`${EVIDENCE_DIR}/criteria.md`]: '- C1: работает\n',
      [`${EVIDENCE_DIR}/logs/npm.log`]: 'x'.repeat(2048),
    });

    const listing = listEvidence(dir);
    assert.deepEqual(
      listing.files.map((file) => file.path),
      ['criteria.md', 'logs/npm.log'],
    );

    const text = describeEvidence(listing);
    assert.match(text, /Пакет evidence\/: 2 файл\(ов\)/u);
    assert.match(text, /criteria\.md · 23 Б/u);
    assert.match(text, /logs\/npm\.log · 2\.0 КБ/u);
    assert.match(text, /Показать файл: \/cycle evidence <путь>/u);
  });

  test('каталога нет — текст, а не исключение', () => {
    const dir = cycleDir({});

    assert.match(describeEvidence(listEvidence(dir)), /каталога evidence\/ нет/u);
  });

  test('пустой каталог — «пуст», а не пустой экран', () => {
    const dir = cycleDir({ [`${EVIDENCE_DIR}/.keep`]: '' });
    const text = describeEvidence(listEvidence(dir));

    assert.match(text, /1 файл\(ов\)/u);
  });

  test('содержимое по запросу и отказ на выход наружу', () => {
    const dir = cycleDir({ [`${EVIDENCE_DIR}/criteria.md`]: '- C1: работает\n' });

    const file = readEvidenceFile(dir, 'criteria.md');
    assert.equal(file.error, null);
    assert.match(describeEvidenceFile(file), /- C1: работает/u);

    const escaped = readEvidenceFile(dir, '../state.json');
    assert.match(escaped.error ?? '', /путь вне каталога evidence\//u);
    assert.match(readEvidenceFile(dir, '/etc/passwd').error ?? '', /путь вне каталога evidence\//u);
  });

  test('длинный файл показывается началом с честной пометкой', () => {
    const lines = Array.from(
      { length: MAX_EVIDENCE_LINES + 50 },
      (_, index) => `line ${index}`,
    ).join('\n');
    const dir = cycleDir({ [`${EVIDENCE_DIR}/big.md`]: lines });

    const file = readEvidenceFile(dir, 'big.md');
    assert.equal(file.truncated, true);
    assert.match(describeEvidenceFile(file), /Показано начало/u);
    assert.ok(!describeEvidenceFile(file).includes(`line ${MAX_EVIDENCE_LINES + 1}`));
  });
});

describe('только чтение: адаптер не пишет в артефакты', () => {
  /** API записи файловой системы, которых в исходниках адаптера быть не должно. */
  const WRITE_CALLS = [
    'writeFile',
    'writeFileSync',
    'appendFile',
    'appendFileSync',
    'mkdir',
    'mkdirSync',
    'rmSync',
    'unlink',
    'unlinkSync',
    'rename',
    'renameSync',
    'createWriteStream',
    'copyFile',
    'cpSync',
    'truncateSync',
  ];

  test('в src/ нет ни одного вызывающего запись', () => {
    const files = readdirSync(join(ROOT, 'src')).filter((name) => name.endsWith('.mjs'));
    assert.ok(files.length >= 5, `ожидались исходники, получено ${files.length}`);

    /** @type {string[]} */
    const offenders = [];
    for (const name of files) {
      const text = readFileSync(join(ROOT, 'src', name), 'utf8');
      for (const call of WRITE_CALLS) {
        if (new RegExp(`\\b${call}\\(`, 'u').test(text)) offenders.push(`src/${name}: ${call}`);
      }
    }

    assert.deepEqual(offenders, [], `адаптер обязан только читать: ${offenders.join(', ')}`);
  });

  /**
   * Снимок каталога: имена, размеры и содержимое — чтобы «ничего не записали» было проверяемо.
   * @param {string} dir каталог
   * @returns {Record<string, string>} снимок
   */
  function snapshot(dir) {
    /** @type {Record<string, string>} */
    const result = {};
    /**
     * @param {string} absolute каталог на диске
     * @param {string} prefix путь для ключа
     * @returns {void}
     */
    const walk = (absolute, prefix) => {
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const full = join(absolute, entry.name);
        if (entry.isDirectory()) walk(full, path);
        else result[path] = `${statSync(full).size}:${readFileSync(full, 'utf8')}`;
      }
    };
    walk(dir, '');

    return result;
  }

  test('команды показа не меняют ни одного файла каталога цикла', async () => {
    const root = fakeProject({
      responses: [
        { out: nextResponse() },
        { out: nextResponse() },
        { out: nextResponse() },
        { out: nextResponse() },
      ],
    });
    const dir = join(root, '.pi', 'artifacts', 'x');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(STATE, null, 2));
    writeFileSync(
      join(dir, 'gates.2.json'),
      JSON.stringify({
        iteration: 2,
        gates: [{ id: 'test', status: 'fail', exit: 1, log: 'gates/test.2.log' }],
      }),
    );
    writeFileSync(join(dir, 'decision.2.json'), JSON.stringify({ iteration: 2, action: 'REWORK' }));
    mkdirSync(join(dir, EVIDENCE_DIR), { recursive: true });
    writeFileSync(join(dir, EVIDENCE_DIR, 'criteria.md'), '- C1: работает\n');

    const before = snapshot(dir);

    const fired = await runCommand(root, 'state');
    for (const command of ['gates', 'decision', 'evidence', 'evidence criteria.md']) {
      const notices = await runCommand(root, command);
      assert.ok(notices.length > 0, `${command} должно что-то показать`);
    }
    assert.match(fired.join('\n'), /Стадия REWORK/u);

    assert.deepEqual(snapshot(dir), before, 'каталог артефактов обязан остаться нетронутым');
  });
});

/**
 * Прогнать `/cycle <args>` в поддельном проекте.
 * @param {string} root корень проекта
 * @param {string} args аргументы команды
 * @returns {Promise<string[]>} тексты уведомлений
 */
async function runCommand(root, args) {
  /** @type {Map<string, any>} */
  const commands = new Map();
  /** @type {any} */
  const pi = {
    /**
     * @param {string} name имя команды
     * @param {any} options её описание
     * @returns {Map<string, any>} тот же реестр
     */
    registerCommand: (name, options) => commands.set(name, options),
  };
  extension(pi);

  /** @type {string[]} */
  const notices = [];
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await commands.get('cycle').handler(args, {
      ui: {
        /** @param {string} text текст уведомления */
        notify: (text) => notices.push(text),
        confirm: () => Promise.resolve(true),
      },
    });
  } finally {
    process.chdir(cwd);
  }

  return notices;
}

describe('подкоманды /cycle: показ артефактов', () => {
  /**
   * Проект с фикстурой цикла и поддельным драйвером.
   * @param {object} files артефакты каталога цикла
   * @param {number} [responses] сколько ответов драйвера заготовить
   * @returns {string} путь проекта
   */
  function projectWithCycle(files, responses = 4) {
    const root = fakeProject({
      responses: Array.from({ length: responses }, () => ({ out: nextResponse() })),
    });
    const dir = join(root, '.pi', 'artifacts', 'x');
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    }

    return root;
  }

  test('state: состояние из каталога, который назвал драйвер', async () => {
    const root = projectWithCycle({ [STATE_FILE]: STATE });
    const notices = await runCommand(root, 'state');

    const text = notices.join('\n');
    assert.match(text, /каталог: \.pi\/artifacts\/x/u);
    assert.match(text, /Стадия REWORK/u);
  });

  test('gates: гейты текущей итерации и логи', async () => {
    const root = projectWithCycle({
      [STATE_FILE]: STATE,
      'gates.2.json': {
        iteration: 2,
        gates: [{ id: 'test', status: 'fail', exit: 1, log: 'gates/test.2.log' }],
      },
      'gates/test.2.log': 'первая строка\nвторая строка\n',
    });
    const text = (await runCommand(root, 'gates')).join('\n');

    assert.match(text, /Гейты итерации 2: pass 0 · fail 1/u);
    assert.match(text, /│ первая строка/u);
  });

  test('gates [n]: номер из аргумента, итерация из state не нужна', async () => {
    const root = projectWithCycle({
      'gates.3.json': { iteration: 3, gates: [{ id: 'lint', status: 'pass', exit: 0 }] },
    });
    const text = (await runCommand(root, 'gates 3')).join('\n');

    assert.match(text, /Гейты итерации 3: pass 1/u);
  });

  test('битый gates.<n>.json — текст ошибки, а не исключение', async () => {
    const root = projectWithCycle({ [STATE_FILE]: STATE, 'gates.2.json': '{"gates": [' });
    const text = (await runCommand(root, 'gates')).join('\n');

    assert.match(text, /gates\.2\.json: файл gates\.2\.json не разобран как JSON/u);
  });

  test('без state.json итерацию просят указать явно', async () => {
    const root = projectWithCycle({});
    const text = (await runCommand(root, 'decision')).join('\n');

    assert.match(text, /укажите номер/u);
  });

  test('decision: решение итерации', async () => {
    const root = projectWithCycle({
      'decision.1.json': {
        iteration: 1,
        action: 'PROCEED',
        reasons: ['gates:green'],
        retry_stage: null,
      },
    });
    const text = (await runCommand(root, 'decision 1')).join('\n');

    assert.match(text, /Решение итерации 1: PROCEED/u);
    assert.match(text, /Причины \(1\):\n {2}· gates:green/u);
  });

  test('evidence: список и содержимое по запросу', async () => {
    const root = projectWithCycle({ [`${EVIDENCE_DIR}/criteria.md`]: '- C1: работает\n' });

    const listing = (await runCommand(root, 'evidence')).join('\n');
    assert.match(listing, /Пакет evidence\/: 1 файл\(ов\)/u);
    assert.match(listing, /criteria\.md · 23 Б/u);

    const content = (await runCommand(root, 'evidence criteria.md')).join('\n');
    assert.match(content, /Файл evidence\/criteria\.md/u);
    assert.match(content, /- C1: работает/u);
  });

  test('неизвестная подкоманда перечисляет известные', async () => {
    const root = projectWithCycle({ [STATE_FILE]: STATE });
    const text = (await runCommand(root, 'teleport')).join('\n');

    assert.match(text, /Неизвестная подкоманда «teleport»/u);
    assert.match(text, new RegExp(SUBCOMMANDS.join(' \\| '), 'u'));
  });

  test('драйвер не ответил — артефакты показываются напрямую с предупреждением', async () => {
    const root = fakeProject({
      responses: [
        { out: 'не JSON', code: 2, err: 'state.json не читается' },
        { out: null, code: 2 },
      ],
    });
    const dir = join(root, '.pi', 'artifacts', '2026-11-21-12-demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(STATE));

    const text = (await runCommand(root, 'state')).join('\n');
    assert.match(text, /показываю артефакты напрямую/u);
    assert.match(text, /state\.json не читается|драйвер вернул не JSON/u);
    assert.match(text, /Стадия REWORK/u);
  });

  test('ни драйвера, ни каталогов — понятный отказ', async () => {
    const root = fakeProject({ responses: [{ out: 'не JSON', code: 2 }] });
    const text = (await runCommand(root, 'state')).join('\n');

    assert.match(text, /каталога `\.pi\/artifacts\/` нет/u);
  });
});

describe('подсказка и аргументы', () => {
  test('help перечисляет все подкоманды', () => {
    const text = helpText();
    for (const subcommand of SUBCOMMANDS) {
      assert.match(text, new RegExp(`/cycle ${subcommand}`, 'u'));
    }
  });

  test('parseSubcommand и parseRest: путь evidence сохраняет пробелы', () => {
    assert.equal(parseSubcommand('  gates 2'), 'gates');
    assert.equal(parseSubcommand(''), 'next');
    assert.deepEqual(parseRest('gates 2'), ['2']);
    assert.deepEqual(parseRest('state'), []);
  });
});
