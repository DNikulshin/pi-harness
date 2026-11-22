#!/usr/bin/env node
/**
 * Проверка «в теле PR есть ссылка на issue»: `Closes #<номер>`.
 *
 * Зачем механизм, а не правило в документации: GitHub связывает issue **в момент мержа** по
 * ключевому слову в теле PR. Если тело собрано из шаблона (`Closes #` без номера) или пересказано
 * словами, ссылки нет — PR влит, issue открыт, доска в прежней колонке. Ровно это и случилось с #4:
 * тело содержало `` `Closes #4` ``, проверка была зелёной, issue закрывали руками.
 *
 * Что считается ссылкой: `closes`/`fixes`/`resolves` + `#<цифры>` в любом регистре, двоеточие
 * допустимо (`Closes: #5`). Несколько ссылок — все засчитываются.
 *
 * Что не считается: HTML-комментарии, блоки кода и строки в обратных кавычках. Inline-code важен
 * отдельно: GitHub внутри `` `Closes #4` `` ключевое слово не распознаёт, поэтому проверка, которая
 * его засчитывает, зеленеет именно там, где issue останется открытым.
 *
 * Своя реализация, а не импорт ядра: `scripts/**` и `scripts/lib/**` ядра закрыты (ADR 0004/0008),
 * и правило про тело PR — свойство этого репозитория, а не контракта ядра.
 *
 * Запуск: `node tooling/pr-reference.mjs` (в CI тело приходит в `PR_BODY`),
 * вручную: `PR_BODY="$(gh pr view 17 --json body --jq .body)" node tooling/pr-reference.mjs`.
 *
 * Второе свойство — **сообщения коммитов** (#22). GitHub закрывает issue и по closing-слову в
 * сообщении коммита, причём разметка там не защищает: бэктики и блок кода ничего не экранируют.
 * Пример с чужим номером в тексте коммита закрывает чужой issue при мерже — так и вышло здесь,
 * где номер из примера совпал с открытым issue. Проверка ищет closing-слова в сообщениях без
 * вырезания разметки и падает, если номер не закрывается телом PR.
 *
 * Коды выхода: `0` — ссылки на месте; `2` — ссылки нет, тело пустое или коммит тянет чужой issue
 * (в CI печатается аннотация `::error::`, чтобы причина была видна в интерфейсе PR).
 *
 * Shebang нужен: скрипт запускается напрямую из workflow.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Ключевые слова GitHub, закрывающие issue, и номер после `#`. */
const REFERENCE = /\b(?:closes|fixes|resolves)\s*:?\s*#(\d+)\b/giu;

/** Блок кода ``` … ``` или ~~~ … ~~~: примеры в теле PR — не ссылки. */
const FENCED_CODE = /^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$/gmu;

/** HTML-комментарий `<!-- … -->`: в шаблоне PR так подсказан формат ссылки. */
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;

/**
 * Строка в обратных кавычках: `` `Closes #4` ``. GitHub внутри inline-code ключевое слово
 * не распознаёт, поэтому и проверка не должна его засчитывать.
 *
 * Содержимое — без перевода строки: иначе это уже не inline-code. Серии кавычек любой длины
 * (`` ``…`` ``) разбираются как одна строка; содержимое с «чужими» кавычками внутри
 * (`` ``a`b`` ``) распознаётся неточно, но на решение это не влияет — ссылка ищется в тексте
 * вне кавычек.
 */
const INLINE_CODE = /`+[^`\n]*?`+/gu;

/**
 * Тело PR без блоков кода, HTML-комментариев и inline-code: только по нему ищем ссылку.
 * @param {unknown} body тело PR
 * @returns {string} текст, в котором ссылка считается настоящей
 */
export function strippedBody(body) {
  if (typeof body !== 'string') return '';
  // Порядок важен: сначала блоки кода (в них бывают одиночные кавычки), затем комментарии
  // и только потом inline-code — иначе кавычки внутри блоков съедят не тот фрагмент.
  return body.replace(FENCED_CODE, '\n').replace(HTML_COMMENT, ' ').replace(INLINE_CODE, ' ');
}

/**
 * Номера issue, которые PR закроет при мерже, в порядке появления и без повторов.
 * @param {unknown} body тело PR
 * @returns {number[]} номера issue
 */
export function closingIssues(body) {
  const text = strippedBody(body);
  /** @type {number[]} */
  const numbers = [];

  for (const match of text.matchAll(REFERENCE)) {
    const number = Number(match[1]);
    if (!Number.isInteger(number) || number <= 0) continue;
    if (!numbers.includes(number)) numbers.push(number);
  }

  return numbers;
}

/**
 * Номера issue из closing-слов в тексте сообщения коммита — **без вырезания разметки**.
 *
 * Отдельная функция от `closingIssues`, потому что правила разные: в теле PR примеры в блоках кода
 * и обратных кавычках ссылкой не считаются, а в сообщении коммита GitHub разметку не разбирает —
 * бэктики бесполезны, и пример закрывает issue так же, как намеренная ссылка.
 * @param {unknown} text текст сообщения коммита
 * @returns {number[]} номера issue
 */
export function rawClosingIssues(text) {
  if (typeof text !== 'string' || text === '') return [];
  /** @type {number[]} */
  const numbers = [];

  for (const match of text.matchAll(REFERENCE)) {
    const number = Number(match[1]);
    if (!Number.isInteger(number) || number <= 0) continue;
    if (!numbers.includes(number)) numbers.push(number);
  }

  return numbers;
}

/**
 * Проблемы в сообщениях коммитов PR: closing-слово, которое GitHub применит, а тело PR — нет.
 *
 * Избыточность не ошибка: коммит вправе повторить номер из тела. Ошибка — номер, которого там нет:
 * при мерже закроется чужой issue, и доска покажет «Done» работе, которую никто не делал.
 * @param {{messages?: unknown, closing?: unknown}} [params] сообщения коммитов и номера из тела
 * @returns {string[]} проблемы; пусто — расхождений нет
 */
export function commitReferenceProblems({ messages, closing } = {}) {
  const list = Array.isArray(messages) ? messages : typeof messages === 'string' ? [messages] : [];
  const allowed = new Set(
    Array.isArray(closing) ? closing.filter((number) => Number.isInteger(number)) : [],
  );
  /** @type {string[]} */
  const problems = [];

  for (const message of list) {
    if (typeof message !== 'string') continue;
    const foreign = rawClosingIssues(message).filter((number) => !allowed.has(number));
    if (foreign.length === 0) continue;

    const subject = (message.split('\n')[0] ?? '').trim();
    const numbers = foreign.map((number) => `#${number}`).join(', ');
    problems.push(
      `коммит «${subject}»: ${numbers} — GitHub закроет при мерже, а тело PR этого не делает`,
    );
  }

  return problems;
}

/**
 * Сообщения коммитов PR из git: `base..head` по SHA из окружения.
 *
 * Диапазон, а не вся история: коммиты базы ничего не закрывают. `--format=%B%x00` — тело целиком
 * и NUL как разделитель, потому что сообщения многострочные.
 * @param {NodeJS.ProcessEnv} env окружение CI (`PR_BASE_SHA`, `PR_HEAD_SHA`)
 * @returns {string[]} сообщения; пусто, если SHA нет или git не ответил
 */
export function readCommitMessages(env) {
  const base = env.PR_BASE_SHA;
  const head = env.PR_HEAD_SHA;
  if (typeof base !== 'string' || typeof head !== 'string' || base === '' || head === '') return [];

  try {
    const out = execFileSync('git', ['log', '--format=%B%x00', `${base}..${head}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return out
      .split('\0')
      .map((message) => message.trim())
      .filter((message) => message !== '');
  } catch {
    return [];
  }
}

/**
 * Причина отказа или `null`, если ссылка на месте. Текст объясняет, что именно нужно добавить:
 * «нет ссылки» без примера заставляет угадывать формат.
 * @param {unknown} body тело PR
 * @returns {string | null} причина отказа или `null`
 */
export function missingReferenceReason(body) {
  const text = typeof body === 'string' ? body : '';
  if (text.trim() === '') {
    return [
      'Тело PR пустое — в нём нет ссылки на issue.',
      'Добавьте строку вида «Closes #12»: GitHub закроет issue при мерже, доска обновится сама.',
    ].join('\n');
  }
  if (closingIssues(text).length > 0) return null;

  return [
    'В теле PR нет ссылки на issue: нужна строка вида «Closes #<номер>».',
    'Без неё issue не закроется при мерже, а доска останется в прежней колонке.',
    'Подсказка из шаблона «Closes #» без номера, примеры в блоках кода и «Closes #N»',
    'в обратных кавычках ссылкой не считаются: GitHub внутри кода ключевое слово не распознаёт.',
  ].join('\n');
}

/**
 * Первая строка сообщения: в аннотацию CI не нужно многострочное полотно.
 * @param {unknown} error ошибка
 * @returns {string} одна строка
 */
function firstLine(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? '';
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

/**
 * Точка входа CLI.
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   readStdIn?: () => string,
 *   readCommits?: (env: NodeJS.ProcessEnv) => string[],
 *   log?: (line: string) => void,
 *   stderr?: (line: string) => void,
 * }} [deps] зависимости, подставленные тестами
 * @returns {number} код выхода
 */
export function main({
  env = process.env,
  readStdIn,
  readCommits = readCommitMessages,
  log = console.log,
  stderr = console.error,
} = {}) {
  try {
    // `PR_BODY` — основной путь (workflow); stdin — для ручных прогонов через пайп.
    const body = env.PR_BODY ?? (readStdIn === undefined ? '' : readStdIn());
    const reason = missingReferenceReason(body);
    if (reason !== null) {
      for (const line of reason.split('\n')) stderr(line);
      // Аннотация Actions: причина видна в интерфейсе PR, а не только в логе прогона.
      stderr(`::error::${reason.split('\n')[0] ?? ''}`);
      return 2;
    }

    const issues = closingIssues(body);
    const problems = commitReferenceProblems({ messages: readCommits(env), closing: issues });
    if (problems.length > 0) {
      for (const problem of problems) stderr(problem);
      stderr(
        '::error::В сообщении коммита есть закрывающее слово с номером, которого тело PR не закрывает: ' +
          'при мерже GitHub закроет чужой issue. Уберите пример из текста коммита.',
      );
      return 2;
    }

    log(
      `pr-reference: PR закрывает issue ${issues.map((number) => `#${number}`).join(', ')}; ` +
        'в сообщениях коммитов чужих номеров нет',
    );
    return 0;
  } catch (error) {
    stderr(`pr-reference: ${firstLine(error)}`);
    return 2;
  }
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
if (isDirectRun(import.meta.url)) {
  process.exitCode = main({
    readStdIn: () => {
      try {
        return readFileSync(0, 'utf8');
      } catch {
        return '';
      }
    },
  });
}
