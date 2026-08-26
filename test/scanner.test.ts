import { cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Note } from '../src/types.js';
import { VaultScanner, type DirEntry, type FsOps } from '../src/vault/scanner.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/vault/', import.meta.url));

/**
 * Every test mutates the vault it scans — touching files, deleting one, creating `.git/`. Vitest
 * runs test files in parallel, so mutating `test/fixtures/vault/` itself would corrupt the reads
 * of every other test file, intermittently and unreproducibly. Each test therefore works on its
 * own throwaway copy under `os.tmpdir()`, and NOTHING here writes inside the fixture.
 */
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-scanner-'));
  cpSync(FIXTURE, root, { recursive: true });
  // `.git/` is not in the fixture — git does not version an empty directory, and a repository
  // inside a fixture would be nested in the project's own. Without it the non-descent assertion
  // for `.git` has no state in which it could fail. The object store shape is what the real vault
  // has, and what a `{ recursive: true }` walk would traverse in full on every refresh.
  mkdirSync(join(root, '.git', 'objects'), { recursive: true });
  writeFileSync(join(root, '.git', 'objects', 'deadbeef'), 'binary-ish\n');
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Vault-relative, POSIX-separated. The vault root itself is reported as `.`. */
function toRelative(absolute: string): string {
  const rel = relative(root, absolute);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

interface Tracker {
  fs: FsOps;
  readdirCalls: string[];
  readFileCalls: string[];
  statCalls: string[];
  reset(): void;
  /** Paths whose `readFile` throws, to exercise the unreadable-file branch. */
  failReads: Set<string>;
}

/**
 * The single injection point the plan requires: the incremental test counts reads through it and
 * the ignore test counts which directories were opened. Note the signature — `readdir` takes a
 * directory and nothing else, so `{ recursive: true }` is not expressible: a scanner that walked
 * recursively in one call would have to bypass `FsOps` entirely.
 */
function tracker(): Tracker {
  const readdirCalls: string[] = [];
  const readFileCalls: string[] = [];
  const statCalls: string[] = [];
  const failReads = new Set<string>();
  return {
    readdirCalls,
    readFileCalls,
    statCalls,
    failReads,
    reset() {
      readdirCalls.length = 0;
      readFileCalls.length = 0;
      statCalls.length = 0;
    },
    fs: {
      readdir(dir: string): DirEntry[] {
        readdirCalls.push(toRelative(dir));
        return readdirSync(dir, { withFileTypes: true });
      },
      stat(path: string) {
        statCalls.push(toRelative(path));
        return statSync(path);
      },
      readFile(path: string): string {
        const rel = toRelative(path);
        readFileCalls.push(rel);
        if (failReads.has(rel)) throw new Error('EACCES: permission denied');
        return readFileSync(path, 'utf8');
      },
    },
  };
}

function scannerWith(t: Tracker): VaultScanner {
  return new VaultScanner({ vaultRoot: root, fs: t.fs });
}

const ALL_PATHS = [
  '00-index/index-knowledge.md',
  '01-raw/inbox/rascunho.md',
  '02-wiki/docker/docker-moc.md',
  '02-wiki/docker/multi-stage.md',
  '02-wiki/nestjs/auth-guard.md',
  '02-wiki/nestjs/bullmq-worker.md',
  '02-wiki/nestjs/nestjs-moc.md',
  '02-wiki/patterns/cache-wrapper.md',
  '03-projects/potentia/README.md',
  '04-daily/2026-08-20.md',
  '99-archive/antigo.md',
  'CLAUDE.md',
  'quebrada.md',
];

/** Every directory the walker must open. `_templates`, `.obsidian` and `.git` are absent. */
const WALKED_DIRS = [
  '.',
  '00-index',
  '01-raw',
  '01-raw/inbox',
  '02-wiki',
  '02-wiki/docker',
  '02-wiki/nestjs',
  '02-wiki/patterns',
  '03-projects',
  '03-projects/potentia',
  '04-daily',
  '99-archive',
];

function paths(scanner: VaultScanner): string[] {
  return scanner.allNotes().map((note) => note.path).sort();
}

/** Sets mtime to a fixed later instant, so the change is visible whatever the clock resolution. */
function touch(relativePath: string, secondsAhead: number): void {
  const absolute = join(root, relativePath);
  const when = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(absolute, when, when);
}

describe('VaultScanner.refresh', () => {
  it('encontra todo `.md` do vault, inclusive na raiz e em 99-archive/', () => {
    const scanner = new VaultScanner({ vaultRoot: root });
    const { changed, removed } = scanner.refresh();

    expect(paths(scanner)).toEqual(ALL_PATHS);
    expect([...changed].sort()).toEqual(ALL_PATHS);
    expect(removed).toEqual([]);
    expect(paths(scanner)).toContain('CLAUDE.md');
    expect(paths(scanner)).toContain('99-archive/antigo.md');
  });

  it('devolve caminhos vault-relativos com separador `/`', () => {
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    for (const path of paths(scanner)) {
      expect(path).not.toContain('\\');
      expect(path.startsWith('/')).toBe(false);
      expect(path.startsWith('.')).toBe(false);
      expect(path).not.toContain(root);
    }
    expect(scanner.root).toBe(root);
  });

  it('ignora `_templates/`, verificado pela saída', () => {
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    // Os dois arquivos existem na cópia — a asserção só vale porque há alvo.
    expect(readdirSync(join(root, '_templates')).sort()).toEqual(['projeto.md', 'wiki.md']);
    expect(paths(scanner)).not.toContain('_templates/projeto.md');
    expect(paths(scanner)).not.toContain('_templates/wiki.md');
    // `projeto.md` declara `tipo: projeto`; sem a exclusão ele apareceria em `vault_list`.
    for (const note of scanner.allNotes()) expect(note.path.startsWith('_templates/')).toBe(false);
  });

  it('nunca abre `.obsidian/` nem `.git/`, e abre todo diretório não ignorado', () => {
    const t = tracker();
    const scanner = scannerWith(t);
    scanner.refresh();

    // Metade 1 — não-descida. Asserir a saída seria vácuo: o scanner só coleta `.md`, e os 13
    // caminhos saem idênticos com e sem a guarda. O que a guarda muda é qual diretório é aberto.
    for (const call of t.readdirCalls) {
      expect(call === '.obsidian' || call.startsWith('.obsidian/')).toBe(false);
      expect(call === '.git' || call.startsWith('.git/')).toBe(false);
      expect(call === '_templates' || call.startsWith('_templates/')).toBe(false);
    }

    // Metade 2 — o contador não pode ficar trivialmente vazio: todo diretório legítimo foi aberto.
    for (const dir of WALKED_DIRS) expect(t.readdirCalls).toContain(dir);
    expect([...t.readdirCalls].sort()).toEqual([...WALKED_DIRS].sort());

    // Um diretório por chamada: nada de `{ recursive: true }`, nada de reabrir o mesmo diretório.
    expect(t.readdirCalls.length).toBe(new Set(t.readdirCalls).size);
    expect(t.readdirCalls.length).toBe(WALKED_DIRS.length);
  });

  it('lê apenas os `.md` não ignorados', () => {
    const t = tracker();
    scannerWith(t).refresh();

    expect([...t.readFileCalls].sort()).toEqual(ALL_PATHS);
  });
});

describe('VaultScanner: notas', () => {
  it('quebrada.md entra com frontmatter vazio e gera diagnostic, sem lançar', () => {
    const scanner = new VaultScanner({ vaultRoot: root });
    expect(() => scanner.refresh()).not.toThrow();

    const note = scanner.getNote('quebrada.md');
    expect(note).toBeDefined();
    expect(note?.frontmatter.tipo).toBeUndefined();
    expect(Object.keys(note?.frontmatter ?? {})).toEqual([]);
    expect(note?.body).toContain('frontmatterpodre');
    expect(note?.body).not.toContain('tipo: wiki');

    const diagnostic = scanner.diagnostics.find((d) => d.path === 'quebrada.md');
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.message).toContain('frontmatter');
  });

  it('title vem do primeiro `# `, com fallback para o basename sem extensão', () => {
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    expect(scanner.getNote('02-wiki/nestjs/auth-guard.md')?.title).toBe('Auth Guard');
    expect(scanner.getNote('00-index/index-knowledge.md')?.title).toBe('Índice de Conhecimento');
    expect(scanner.getNote('quebrada.md')?.title).toBe('Nota Quebrada');
    // `01-raw/inbox/rascunho.md` é a única nota da fixture sem heading `# `.
    expect(scanner.getNote('01-raw/inbox/rascunho.md')?.title).toBe('rascunho');
  });

  it('um `# ` dentro de cerca de código não vira título', () => {
    writeFileSync(
      join(root, 'cercada.md'),
      ['```md', '# Titulo Falso', '```', '', '# Titulo Real', '', 'corpo', ''].join('\n'),
    );
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    expect(scanner.getNote('cercada.md')?.title).toBe('Titulo Real');
  });

  it('resolve wiki-links numa segunda passada, com o conjunto completo de caminhos', () => {
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    const authGuard = scanner.getNote('02-wiki/nestjs/auth-guard.md');
    expect(authGuard?.links).toContain('02-wiki/nestjs/bullmq-worker.md');
    expect(authGuard?.brokenLinks).toEqual(['nota-que-nao-existe']);

    // `00-index/` é percorrido ANTES de `02-wiki/`: resolver link a link durante a leitura
    // deixaria estes dois alvos quebrados, porque os caminhos ainda não existiriam no mapa.
    const index = scanner.getNote('00-index/index-knowledge.md');
    expect(index?.links).toEqual([
      '02-wiki/nestjs/nestjs-moc.md',
      '02-wiki/docker/docker-moc.md',
    ]);
    expect(index?.brokenLinks).toEqual([]);

    // Resolução por basename também depende do conjunto completo.
    expect(scanner.getNote('02-wiki/patterns/cache-wrapper.md')?.links).toContain(
      '02-wiki/nestjs/auth-guard.md',
    );
  });

  it('expõe mtimeMs, getNote e allNotes coerentes', () => {
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    const note = scanner.getNote('99-archive/antigo.md');
    expect(note?.mtimeMs).toBe(statSync(join(root, '99-archive/antigo.md')).mtimeMs);
    expect(scanner.getNote('nao/existe.md')).toBeUndefined();
    expect(scanner.allNotes()).toHaveLength(ALL_PATHS.length);
  });
});

describe('VaultScanner: revalidação por mtime', () => {
  it('um segundo refresh sem alteração no disco não relê nada', () => {
    const t = tracker();
    const scanner = scannerWith(t);
    scanner.refresh();
    expect(t.readFileCalls).toHaveLength(ALL_PATHS.length);

    t.reset();
    const second = scanner.refresh();

    expect(t.readFileCalls).toEqual([]);
    expect(second.changed).toEqual([]);
    expect(second.removed).toEqual([]);
    expect(paths(scanner)).toEqual(ALL_PATHS);
    // O walk continua acontecendo — é o que detecta arquivo novo ou removido.
    expect([...t.readdirCalls].sort()).toEqual([...WALKED_DIRS].sort());
  });

  it('tocar um arquivo faz apenas ele ser relido', () => {
    const t = tracker();
    const scanner = scannerWith(t);
    scanner.refresh();

    writeFileSync(
      join(root, '02-wiki/docker/multi-stage.md'),
      readFileSync(join(root, '02-wiki/docker/multi-stage.md'), 'utf8') + '\nLinha nova.\n',
    );
    touch('02-wiki/docker/multi-stage.md', 5);
    t.reset();
    const second = scanner.refresh();

    expect(t.readFileCalls).toEqual(['02-wiki/docker/multi-stage.md']);
    expect(second.changed).toEqual(['02-wiki/docker/multi-stage.md']);
    expect(second.removed).toEqual([]);
    expect(scanner.getNote('02-wiki/docker/multi-stage.md')?.body).toContain('Linha nova.');
    // As notas não relidas continuam íntegras, links resolvidos inclusive.
    expect(scanner.getNote('00-index/index-knowledge.md')?.links).toContain(
      '02-wiki/docker/docker-moc.md',
    );
  });

  it('mtime alterado sem mudança de conteúdo ainda relê, e mtime intacto não', () => {
    const t = tracker();
    const scanner = scannerWith(t);
    scanner.refresh();

    touch('CLAUDE.md', 7);
    t.reset();
    expect(scanner.refresh().changed).toEqual(['CLAUDE.md']);
    expect(t.readFileCalls).toEqual(['CLAUDE.md']);

    t.reset();
    expect(scanner.refresh().changed).toEqual([]);
    expect(t.readFileCalls).toEqual([]);
  });

  it('remover um arquivo o retira do mapa e reabre os links que dependiam dele', () => {
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();
    expect(scanner.getNote('02-wiki/nestjs/bullmq-worker.md')).toBeDefined();

    rmSync(join(root, '02-wiki/nestjs/bullmq-worker.md'));
    const second = scanner.refresh();

    expect(second.removed).toEqual(['02-wiki/nestjs/bullmq-worker.md']);
    expect(second.changed).toEqual([]);
    expect(scanner.getNote('02-wiki/nestjs/bullmq-worker.md')).toBeUndefined();
    expect(paths(scanner)).not.toContain('02-wiki/nestjs/bullmq-worker.md');
    // O alvo sumiu: quem linkava para ele passa a ter link quebrado, o que só a segunda
    // passada sobre o conjunto completo consegue reavaliar.
    const authGuard = scanner.getNote('02-wiki/nestjs/auth-guard.md');
    expect(authGuard?.links).not.toContain('02-wiki/nestjs/bullmq-worker.md');
    expect(authGuard?.brokenLinks).toContain('bullmq-worker');
  });

  it('um arquivo novo entra em `changed` e passa a resolver links', () => {
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    writeFileSync(
      join(root, '02-wiki/patterns/nova.md'),
      ['---', 'tipo: wiki', '---', '', '# Nova', '', 'Aponta para [[auth-guard]].', ''].join('\n'),
    );
    const second = scanner.refresh();

    expect(second.changed).toEqual(['02-wiki/patterns/nova.md']);
    expect(second.removed).toEqual([]);
    expect(scanner.getNote('02-wiki/patterns/nova.md')?.links).toEqual([
      '02-wiki/nestjs/auth-guard.md',
    ]);
  });
});

describe('VaultScanner: diagnostics', () => {
  it('são reconstruídos a cada refresh, sem duplicar o de arquivo não relido', () => {
    const t = tracker();
    const scanner = scannerWith(t);
    scanner.refresh();
    expect(scanner.diagnostics.filter((d) => d.path === 'quebrada.md')).toHaveLength(1);

    t.reset();
    scanner.refresh();

    // Nada foi relido, mas o diagnostic do arquivo ainda quebrado continua sendo reportado —
    // uma vez só. Acumular sem limpar duplicaria; limpar sem re-emitir o perderia.
    expect(t.readFileCalls).toEqual([]);
    expect(scanner.diagnostics.filter((d) => d.path === 'quebrada.md')).toHaveLength(1);
  });

  it('um arquivo corrigido deixa de ser reportado', () => {
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();
    expect(scanner.diagnostics.map((d) => d.path)).toContain('quebrada.md');

    writeFileSync(
      join(root, 'quebrada.md'),
      ['---', 'tipo: wiki', '---', '', '# Nota Consertada', '', 'frontmatterpodre', ''].join('\n'),
    );
    touch('quebrada.md', 9);
    scanner.refresh();

    expect(scanner.diagnostics.map((d) => d.path)).not.toContain('quebrada.md');
    expect(scanner.getNote('quebrada.md')?.frontmatter.tipo).toBe('wiki');
  });

  it('um arquivo ilegível vira diagnostic e sai do mapa, sem derrubar o refresh', () => {
    const t = tracker();
    t.failReads.add('99-archive/antigo.md');
    const scanner = scannerWith(t);

    expect(() => scanner.refresh()).not.toThrow();

    expect(scanner.getNote('99-archive/antigo.md')).toBeUndefined();
    expect(paths(scanner)).toHaveLength(ALL_PATHS.length - 1);
    expect(scanner.diagnostics.map((d) => d.path)).toContain('99-archive/antigo.md');
    // As outras notas seguem normais.
    expect(scanner.getNote('02-wiki/nestjs/auth-guard.md')?.title).toBe('Auth Guard');
  });
});

/**
 * Reslicing proof, the same one `test/chunker.test.ts` uses on `lineStart`: the body a note
 * carries has to be exactly what the raw file holds from `bodyStartLine` onwards. Recomputing
 * the expected number with a second frontmatter parser here would only prove two parsers agree.
 */
function bodyMatchesRawFromLine(relative: string, note: Note): boolean {
  const raw = readFileSync(join(root, relative), 'utf8');
  return raw.split('\n').slice(note.bodyStartLine - 1).join('\n') === note.body;
}

/** The 1-based line of the closing `---`, read straight off the raw file. */
function closingDelimiterLine(relative: string): number {
  const lines = readFileSync(join(root, relative), 'utf8').split('\n');
  expect(lines[0]).toBe('---');
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') return i + 1;
  throw new Error(`sem fechamento de frontmatter: ${relative}`);
}

describe('VaultScanner: bodyStartLine', () => {
  it('nota sem bloco de frontmatter começa na linha 1', () => {
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    for (const relative of ['01-raw/inbox/rascunho.md', 'CLAUDE.md']) {
      const note = scanner.getNote(relative)!;
      expect(readFileSync(join(root, relative), 'utf8').startsWith('---')).toBe(false);
      expect(note.bodyStartLine).toBe(1);
      expect(bodyMatchesRawFromLine(relative, note)).toBe(true);
    }
  });

  it('nota com frontmatter começa na linha seguinte ao fechamento `---`', () => {
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    const relative = '02-wiki/nestjs/auth-guard.md';
    const note = scanner.getNote(relative)!;
    // Valor absoluto, não uma relação: o frontmatter de `auth-guard.md` fecha na linha 5, então o
    // corpo abre na 6 — cinco linhas abaixo do `1` que o retriever passava para o chunker.
    expect(closingDelimiterLine(relative)).toBe(5);
    expect(note.bodyStartLine).toBe(6);
    expect(bodyMatchesRawFromLine(relative, note)).toBe(true);
  });

  it('corpo que abre com linha em branco conta essa linha em branco', () => {
    // O `---` fecha na 3 e a 4 está vazia: o corpo COMEÇA nela, porque o parser come um único
    // newline depois do delimitador, não todos. Apontar para o `# Título` da linha 5 citaria o
    // chunk uma linha adiante de onde ele realmente começa.
    writeFileSync(
      join(root, 'branco.md'),
      ['---', 'tipo: wiki', '---', '', '# Título', '', 'corpo', ''].join('\n'),
    );
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    const note = scanner.getNote('branco.md')!;
    expect(note.bodyStartLine).toBe(4);
    expect(note.body.startsWith('\n# Título')).toBe(true);
    expect(bodyMatchesRawFromLine('branco.md', note)).toBe(true);
  });

  it('CRLF conta igual a LF', () => {
    const lines = ['---', 'tipo: wiki', 'tags: [docker]', '---', '', '# Título', '', 'corpo', ''];
    writeFileSync(join(root, 'crlf.md'), lines.join('\r\n'));
    writeFileSync(join(root, 'lf.md'), lines.join('\n'));
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    const crlf = scanner.getNote('crlf.md')!;
    const lf = scanner.getNote('lf.md')!;
    expect(readFileSync(join(root, 'crlf.md'), 'utf8')).toContain('\r\n');
    expect(crlf.bodyStartLine).toBe(5);
    expect(crlf.bodyStartLine).toBe(lf.bodyStartLine);
    expect(bodyMatchesRawFromLine('crlf.md', crlf)).toBe(true);
  });

  it('vale para toda nota da fixture, inclusive a de frontmatter inválido', () => {
    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    let comFrontmatter = 0;
    for (const relative of ALL_PATHS) {
      const note = scanner.getNote(relative)!;
      expect(bodyMatchesRawFromLine(relative, note)).toBe(true);
      if (note.bodyStartLine > 1) comFrontmatter++;
    }
    // Sem esta contagem o teste passaria com um vault inteiro de notas sem frontmatter — que é
    // exatamente o caso em que a constante `1` acerta por acaso.
    expect(comFrontmatter).toBe(11);
    // `quebrada.md` não passa pelo gray-matter e sim pelo caminho de recuperação de `parseFile`;
    // o deslocamento tem de sair certo nos dois.
    expect(scanner.getNote('quebrada.md')!.bodyStartLine).toBeGreaterThan(1);
  });
});

/**
 * O guard de escrita (`classifyStat` em `src/write/paths.ts`) já reprova `nlink > 1`. A leitura
 * precisa da MESMA regra: um hard link é um arquivo regular para `Dirent.isFile()`, então sem
 * isso `fs.link(<segredo fora do vault>, <vault>/x.md)` faz o segredo virar nota indexada e
 * `vault_get_note` devolve bytes que vivem fora da raiz.
 */
describe('VaultScanner: hard link', () => {
  let outside: string;

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'vault-scanner-fora-'));
  });

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  it('não indexa hard link para arquivo de fora do vault, e reporta o motivo', () => {
    const secret = join(outside, 'segredo.pem');
    writeFileSync(secret, '-----BEGIN PRIVATE KEY-----\nnão pertence ao vault\n');
    linkSync(secret, join(root, '02-wiki', 'vazamento.md'));

    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    expect(scanner.getNote('02-wiki/vazamento.md')).toBeUndefined();
    expect(paths(scanner)).toEqual(ALL_PATHS);
    expect(scanner.diagnostics.find((d) => d.path === '02-wiki/vazamento.md')?.message).toMatch(
      /hard link/i,
    );
  });

  /**
   * Decisão deliberada: a regra é sobre `nlink`, não sobre onde o outro nome está — não existe
   * como perguntar a um hard link onde vive sua contraparte sem varrer o filesystem inteiro. Um
   * vault restaurado com `cp -al` fica portanto fora do índice, mas de forma RUIDOSA: um
   * diagnostic por nota, nomeando a causa. Silenciar seria pior que recusar.
   */
  it('recusa também um hard link cujos dois nomes estão dentro do vault', () => {
    linkSync(join(root, '02-wiki', 'nestjs', 'auth-guard.md'), join(root, '02-wiki', 'copia.md'));

    const scanner = new VaultScanner({ vaultRoot: root });
    scanner.refresh();

    expect(scanner.getNote('02-wiki/copia.md')).toBeUndefined();
    // O original compartilha o mesmo inode, então cai pela mesma regra.
    expect(scanner.getNote('02-wiki/nestjs/auth-guard.md')).toBeUndefined();
    expect(scanner.diagnostics.map((d) => d.path)).toContain('02-wiki/copia.md');
  });
});
