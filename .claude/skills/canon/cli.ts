#!/usr/bin/env node
/**
 * `canon` — the derivation-link tooling for a project's canon: the gate over
 * the citations, and the writer that regenerates what the documents generate.
 * The protocol is `./SKILL.md`; this file's own `--help` is the manual.
 *
 * Runs directly under Node 22.18 or later, which strips the types itself, and
 * depends on nothing outside Node.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { beginMarker, replaceRegion } from './regions.ts';

// ---------------------------------------------------------------------------
// SCOPE — declared, never inferred.
//
// A project declares its scope in the `canon` field of its `package.json`. The
// protocol applies only to the documents and suites named there. An untagged
// file outside that scope is not ambiguous: it is simply not participating.
// ---------------------------------------------------------------------------

/** The `canon` field of `package.json`. Every key is optional. */
interface Config {
  /** The canon documents, relative to the project root. */
  documents?: string[];
  /** The declared suite directory. */
  suites?: string;
  /** The trees swept for voluntary citations and for the code a case names. */
  sources?: string[];
  /** Prose documents whose citations must resolve but discharge nothing. */
  references?: string[];
  /** How a reader runs this tool, for the advice in findings. */
  command?: string;
}

/**
 * The project root: the nearest directory, from where the tool was run, whose
 * `package.json` carries a `canon` field.
 */
const ROOT = ((): string => {
  for (let dir = resolve(process.cwd()); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
        canon?: unknown;
      };
      if (parsed.canon !== undefined) return dir;
    }
    if (dirname(dir) === dir) {
      console.error(
        'canon: no package.json with a "canon" field between here and the filesystem root'
      );
      process.exit(2);
    }
  }
})();

const CONFIG = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    canon: Config;
  }
).canon;

const DOCS = CONFIG.documents ?? ['CANON.md'];

/**
 * The declared suites: every file in this directory, no exceptions.
 *
 * Scope is a claim a suite makes, and here the claim is where it lives. Moving
 * a suite in is the declaration; moving it out withdraws it.
 *
 * Flat, and scoped by CLAIM rather than by module: one rule can bind several
 * modules at once, and filing its suites by the module they happen to drive
 * would silently re-partition the rule.
 */
const TESTS = CONFIG.suites ?? 'test/canon';

const SOURCES = CONFIG.sources ?? ['src', 'test'];

const REFERENCES = CONFIG.references ?? [];

const COMMAND = CONFIG.command ?? 'pnpm canon';

/**
 * The protocol document, which carries the generated table of kinds. It sits
 * beside this file, so the table follows the tool rather than the project.
 */
const PROTOCOL = join(dirname(fileURLToPath(import.meta.url)), 'SKILL.md');

// ---------------------------------------------------------------------------
// The ruleset is driven entirely by the id prefix.
// ---------------------------------------------------------------------------

/**
 * A unit's kind, which is exactly its id prefix. Writing it as a union rather
 * than as `string` is most of the point of this file being typed: a prefix added
 * to `OWES` without a matching entry here, or cited by a name that is not one of
 * these, stops compiling instead of silently matching nothing.
 */
type Kind = 'axiom-' | 'rule-' | 'exception-' | 'case-';

/**
 * kind → what a reader reaches for it for. Generated into `SKILL.md` beside
 * `OWES`, so the table there is this table and cannot drift from it.
 */
const MEANS: Record<Kind, string> = {
  'axiom-': 'a principle nothing here derives from',
  'rule-': 'a consequence of an axiom, stated so it can be contradicted',
  'exception-':
    'a carve-out that cannot be stated without naming the rule it narrows',
  'case-': 'one place the code answers a rule, and the verdict for it'
};

/** kind → the kinds it must cite at least one of; `null` means it owes nothing. */
const OWES: Record<Kind, Kind[] | null> = {
  'axiom-': null, // primitive by kind — owes nothing
  'rule-': ['axiom-'],
  'exception-': ['rule-'],
  'case-': ['rule-', 'exception-']
};

const PREFIXES = Object.keys(OWES) as Kind[];
const kindOf = (id: string): Kind | undefined =>
  PREFIXES.find(p => id.startsWith(p));

/** `'rule-'` → `'rule'`, for prose. */
const noun = (kind: Kind): string => kind.slice(0, -1);

// ---------------------------------------------------------------------------
// A minimal element scanner: enough to know which element each anchor sits in.
// ---------------------------------------------------------------------------
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr'
]);

interface Element {
  tag: string;
  id: string | undefined;
  start: number;
  end: number;
  /** Heading depth, the enclosing unit and the prose after the em dash. */
  level?: number;
  parent?: string;
  label?: string;
  statement?: string;
}

interface Anchor {
  href: string;
  /** Byte offset of the opening tag, used to find the element that owns it. */
  at: number;
}

/** Blank out comments and script/style bodies, keeping every byte offset. */
const mask = (src: string): string =>
  src
    .replace(/<!--[\s\S]*?-->/g, m => ' '.repeat(m.length))
    .replace(
      /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g,
      (_, a: string, b: string, c: string) => a + ' '.repeat(b.length) + c
    )
    .replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g,
      (_, a: string, b: string, c: string) => a + ' '.repeat(b.length) + c
    );

function scan(src: string): { withId: Element[]; anchors: Anchor[] } {
  const html = mask(src);
  const tag = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const stack: Element[] = [];
  const withId: Element[] = [];
  const anchors: Anchor[] = [];
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html)) !== null) {
    const [full, closing, name, attrs] = m;
    const lower = name.toLowerCase();
    const id = /\bid="([^"]*)"/.exec(attrs)?.[1];
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== lower) continue;
        // Everything above `i` is a descendant that never closed. Dropping it
        // here is what a browser does, and leaving it on the stack would let a
        // later close of the same name pop it — attributing an anchor to a
        // container that had already ended. The in-scope documents are all
        // balanced, so this is a guard on the checker's silence, not a live fix.
        const closed = stack.splice(i);
        for (const el of closed) {
          el.end = m.index + full.length;
          if (el.id) withId.push(el);
        }
        break;
      }
      continue;
    }
    if (VOID.has(lower) || attrs.trimEnd().endsWith('/')) {
      if (id)
        withId.push({
          tag: lower,
          id,
          start: m.index,
          end: m.index + full.length
        });
      continue;
    }
    stack.push({ tag: lower, id, start: m.index, end: html.length });
    if (lower === 'a') {
      const href = /\bhref="([^"]*)"/.exec(attrs)?.[1];
      if (href) anchors.push({ href, at: m.index });
    }
  }
  // Anything still open at EOF keeps its end-of-file extent.
  for (const el of stack) if (el.id) withId.push(el);
  return { withId, anchors };
}

// ---------------------------------------------------------------------------
// The markdown scanner, which answers the same two questions as `scan`.
// ---------------------------------------------------------------------------

/**
 * Blank out fenced-code bodies and the generated index, keeping every byte
 * offset and every newline.
 *
 * The index has to go: it links every unit in the document, so leaving it
 * readable makes `dead` vacuous — every unit is cited by the table of contents
 * that was generated FROM it. A generated link is not evidence that anything
 * derives from a unit, which is the only thing `dead` is asking.
 */
const maskFences = (src: string): string =>
  src
    .replace(/^(```+|~~~+)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, m =>
      m.replace(/[^\n]/g, ' ')
    )
    .replace(/<!--[ \t]*toc:begin\b[^>]*-->[\s\S]*?<!-- toc:end -->/g, m =>
      m.replace(/[^\n]/g, ' ')
    );

/**
 * A unit heading: `### @rule <stem> — <prose>`, whose id is `rule-<stem>`. The
 * stem is declared rather than slugged from the prose, so the sentence after the
 * em dash can be reworded without breaking a citation.
 */
const UNIT_HEADING = /^(#{1,6})[ \t]+@([a-z]+)[ \t]+(\S+)[ \t]*$/gm;
/**
 * A unit heading carrying anything past its stem. The heading is the identifier
 * and nothing else, because a renderer slugs the WHOLE heading: prose after the
 * stem lands in the anchor, so `#rule-x` resolves to nothing and every citation
 * to that unit is a dead link in GitLab and in any local preview. Stripped, the
 * slug and the declared id are the same string by construction. The unit's
 * statement opens the body instead.
 */
const OVERFULL_HEADING = /^#{1,6}[ \t]+@[a-z]+[ \t]+\S+[ \t]+\S.*$/gm;
/**
 * A unit's statement — the blockquote opening its body, and its label in the
 * index. Declared by the line prefix rather than inferred from emphasis, so
 * marking a term inside it changes nothing about what is read out.
 */
const STATEMENT = /^> (.+)$/m;
/** Any heading, including a plain section one — it ends the unit above it. */
const ANY_HEADING = /^(#{1,6})[ \t]+/gm;
/** A `<tr>`/`<td>` unit in an HTML table the document kept. */
const TABLE_UNIT = /<t([rd])\b[^>]*\bid="([^"]*)"[^>]*>/g;

function scanMarkdown(src: string): { withId: Element[]; anchors: Anchor[] } {
  const md = maskFences(src);
  const withId: Element[] = [];
  const anchors: Anchor[] = [];

  const levels = [...md.matchAll(ANY_HEADING)].map(m => ({
    level: m[1].length,
    at: m.index ?? 0
  }));

  const units: Element[] = [];
  for (const m of md.matchAll(UNIT_HEADING)) {
    const start = m.index ?? 0;
    const level = m[1].length;
    // A plain section heading closes the unit above it: it is not a unit, but
    // it is not part of one either.
    const next = levels.find(h => h.at > start && h.level <= level);
    units.push({
      tag: 'heading',
      id: `${m[2]}-${m[3]}`,
      start,
      end: next ? next.at : md.length,
      level,
      label: `@${m[2]} ${m[3]}`
    });
  }
  // Nesting IS the derivation link, so each unit records the unit it sits
  // inside. A plain section heading between the two breaks the relation, which
  // is why the enclosing unit is found by extent rather than by heading depth.
  for (const unit of units) {
    unit.parent = units
      .filter(u => u !== unit && unit.start > u.start && unit.start < u.end)
      .sort((a, b) => b.start - a.start)[0]?.id;
  }
  for (const unit of units) {
    const body = md.slice(unit.start, unit.end).split('\n').slice(1).join('\n');
    unit.statement = STATEMENT.exec(body)?.[1]?.trim();
  }
  withId.push(...units);

  for (const m of md.matchAll(TABLE_UNIT)) {
    const start = m.index ?? 0;
    const close = md.indexOf(`</t${m[1]}>`, start);
    withId.push({
      tag: `t${m[1]}`,
      id: m[2],
      start,
      end: close === -1 ? md.length : close
    });
  }

  // `[text](#rule-some-stem)`, and the raw anchors inside a kept HTML table.
  for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
    anchors.push({ href: m[1], at: m.index ?? 0 });
  }
  for (const m of md.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)) {
    anchors.push({ href: m[1], at: m.index ?? 0 });
  }

  return { withId, anchors };
}

const KINDS_BEGIN = beginMarker('kinds');
const KINDS_END = '<!-- kinds:end -->';

/**
 * The unit kinds, as a table, from `MEANS` and `OWES`.
 *
 * Generated rather than written because it is the checker's own ruleset stated
 * for a reader: a kind added to `OWES` without a row here would be a second
 * place for the hierarchy to be wrong, which is the failure this whole protocol
 * is about.
 */
function kindsTable(): string {
  const rows = PREFIXES.map(k => {
    const owes = OWES[k];
    const owed =
      owes === null
        ? 'nothing — primitive by kind'
        : owes.map(o => `\`@${noun(o)}\``).join(' · ');
    return `| \`@${noun(k)}\` | ${MEANS[k]} | ${owed} |`;
  });
  return ['| tag | what it is | cites |', '| --- | --- | --- |', ...rows].join(
    '\n'
  );
}

const TOC_BEGIN = beginMarker('toc');
const TOC_END = '<!-- toc:end -->';
/**
 * A document's table of contents, which nesting has made its derivation tree:
 * every unit indented under the one it derives from. Generated rather than
 * written, because a hand-kept index is a second place for the hierarchy to be
 * stated and so a second place for it to be wrong.
 */
function tocOf(src: string): string {
  const units = scanMarkdown(src).withId.filter(u => u.tag === 'heading');
  const byId = new Map(units.map(u => [u.id, u]));
  const depth = (u: Element): number => {
    let n = 0;
    for (let p = u.parent; p; p = byId.get(p)?.parent) n++;
    return n;
  };
  const rows = units.map(
    u =>
      `${'  '.repeat(depth(u))}- [\`${u.label}\`](#${u.id})${u.statement ? ` — ${u.statement}` : ''}`
  );
  return rows.join('\n');
}

/**
 * Rules carrying `least` tests or more and holding no cases.
 *
 * A rule that says several things and has no way to say so collects the tests
 * for all of them, so the count is the signal — and a test pinning one clause
 * then reads as covering the rest. It is a smell rather than a finding: a rule
 * can honestly carry several tests of ONE claim, enumerated per input or
 * attacked from several angles, and cases there would restate their own rule.
 * So this reports and never gates.
 */
function suspectsOf(
  file: string,
  testsPer: Map<string, number>,
  least: number
): string {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, 'utf8');
  const { withId } = scanMarkdown(src);
  const headings = withId.filter(u => u.tag === 'heading');

  // Cases a table holds are counted but do not excuse a rule: they are the
  // scenarios of a grid, not the clauses of the rule, so a rule can hold a
  // dozen of them and still say several things it has never separated.
  const linkedTo = new Map<string, number>();
  for (const m of src.matchAll(/href="#(rule-[\w-]+)"/g)) {
    linkedTo.set(m[1], (linkedTo.get(m[1]) ?? 0) + 1);
  }

  const rows = headings
    .filter(u => kindOf(u.id ?? '') === 'rule-')
    .filter(
      u =>
        !headings.some(h => h.parent === u.id && kindOf(h.id ?? '') === 'case-')
    )
    .map(u => ({
      id: u.id ?? '',
      n: testsPer.get(`${rel}#${u.id}`) ?? 0,
      linked: linkedTo.get(u.id ?? '') ?? 0
    }))
    .filter(r => r.n >= least)
    .sort((a, b) => b.n - a.n);

  const head = `${rel} — rules with no cases carrying ${least}+ tests`;
  if (rows.length === 0) return `${head}\n\nnone`;
  return [
    head,
    '',
    ...rows.map(
      r =>
        `${String(r.n).padStart(4)}  ${prose(r.id).replace(/^@rule /, '')}` +
        (r.linked ? `  (+${r.linked} linked from a table)` : '')
    ),
    '',
    'A smell, not a finding — read each and decide.'
  ].join('\n');
}

const scanFile = (file: string): { withId: Element[]; anchors: Anchor[] } => {
  const src = readFileSync(file, 'utf8');
  return file.endsWith('.md') ? scanMarkdown(src) : scan(src);
};

// ---------------------------------------------------------------------------
// Colour, for the tree only. A pipe or a CI log gets none: the tree is also
// read through `| grep`, where an escape between the glyph and the stem stops
// a pattern matching what the eye can see.
// ---------------------------------------------------------------------------
const COLOUR = process.stdout.isTTY === true && !process.env.NO_COLOR;
const paint = (code: string, s: string): string =>
  COLOUR && code ? `\x1b[${code}m${s}\x1b[0m` : s;

/**
 * kind → its colour, so a reader learns the tree's shape by hue rather than by
 * prefix. The `@tag` takes the dim companion of its kind: it says the same
 * thing the hue already does, so it sits behind the stem rather than competing
 * with it.
 */
const HUE: Record<Kind, string> = {
  'axiom-': '1;35', // bold magenta
  'rule-': '36', // cyan
  'exception-': '33', // yellow — a carve-out should catch the eye
  'case-': '' // plain: they outnumber everything else four to one
};

/**
 * A statement is the unit talking about itself, so italic sets it apart, and
 * dim takes it a notch below the stem it hangs under.
 *
 * No colour: dim shades whatever foreground the terminal already chose, where a
 * shade picked for a dark theme is close to invisible on a light one.
 */
const SAID = '2;3';

const DIM: Record<Kind, string> = {
  'axiom-': '2;35',
  'rule-': '2;36',
  'exception-': '2;33',
  'case-': '90'
};

/**
 * A unit id as a reader sees it: `@rule a-write-lands-at-once` reads as
 * `@rule A write lands at once`.
 *
 * Lossless, because a stem is lowercase and hyphenated by construction — lower
 * the words and join them with hyphens and the id is back. So a stem copied out
 * of the tree still leads to the unit.
 */
function prose(id: string): string {
  const kind = kindOf(id);
  if (!kind) return id;
  const stem = id.slice(kind.length).replace(/-/g, ' ');
  return `@${noun(kind)} ${stem.charAt(0).toUpperCase()}${stem.slice(1)}`;
}

/** One line of a statement, cut at a word so a tree stays a tree. */
function clip(said: string, indent: number): string {
  const room = Math.max(24, (process.stdout.columns || 100) - indent);
  const flat = said.replace(/\s+/g, ' ').trim();
  if (flat.length <= room) return flat;
  const cut = flat.slice(0, room - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')) || cut}…`;
}

/**
 * The derivation tree of one document, drawn for a terminal.
 *
 * The same relation the index in the document carries, shown with what the
 * document cannot: how many tests pin each claim. A unit with none is the
 * coverage backlog, so the tree doubles as the map of where it is.
 *
 * Two connectors, because there are two ways to cite. `├─` is nesting, which
 * is the ordinary case. `╌` is a link, drawn for the units a table holds: a
 * table cannot nest, so a matrix cell names its rule in an `href` instead, and
 * that difference is worth seeing rather than flattening away.
 */
function treeOf(
  file: string,
  testsPer: Map<string, number>,
  gapsOnly: boolean,
  verbose: boolean,
  links: Map<string, Array<{ target: string; derives: boolean }>> = new Map()
): string {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, 'utf8');
  const { withId } = scanMarkdown(src);
  const headings = withId.filter(u => u.tag === 'heading');
  const byId = new Map(headings.map(u => [u.id, u]));

  const tests = (id: string): number => testsPer.get(`${rel}#${id}`) ?? 0;

  /**
   * What a table's case says, which the heading scanner does not collect: a
   * cell has no statement, so its claim is the text of its first line, with
   * the markup stripped.
   */
  const cellStatements = new Map<string, string>();
  for (const m of src.matchAll(
    /<t[rd]\b[^>]*\bid="(case-[\w-]+)"[^>]*>([\s\S]*?)<\/t[rd]>/g
  )) {
    const said = m[2]
      .split(/<br\s*\/?>/)[0]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[:;,\s]+/, '')
      .trim();
    if (said)
      cellStatements.set(m[1], said.charAt(0).toUpperCase() + said.slice(1));
  }
  /** A claim owes a test unless it holds cases, which pin it. */
  const owesTest = (id: string): boolean => {
    const kind = kindOf(id);
    if (kind !== 'rule-' && kind !== 'case-') return false;
    return !headings.some(
      h => h.parent === id && kindOf(h.id ?? '') === 'case-'
    );
  };

  const linked = new Map<string, Element[]>();
  for (const cell of withId.filter(u => u.tag === 'td' || u.tag === 'tr')) {
    const body = src.slice(cell.start, cell.end);
    const target = /href="#((?:rule|exception|case|axiom)-[\w-]+)"/.exec(body);
    if (!target) continue;
    const list = linked.get(target[1]) ?? [];
    list.push(cell);
    linked.set(target[1], list);
  }

  const childrenOf = (id: string | undefined): Element[] =>
    headings.filter(u => u.parent === id);

  const keep = (u: Element): boolean => {
    if (!gapsOnly) return true;
    if (owesTest(u.id ?? '') && tests(u.id ?? '') === 0) return true;
    return childrenOf(u.id).some(keep);
  };

  const out: string[] = [];
  const walk = (unit: Element, prefix: string): void => {
    const kids = childrenOf(unit.id).filter(keep);
    const cells = gapsOnly ? [] : (linked.get(unit.id ?? '') ?? []);
    const rows: Array<{ label: string; id: string; el?: Element }> = [
      ...kids.map(k => ({
        label: prose(k.id ?? ''),
        id: k.id ?? '',
        el: k
      })),
      ...cells.map(c => ({
        label: prose(c.id ?? ''),
        id: c.id ?? ''
      }))
    ];
    rows.forEach((row, i) => {
      const last = i === rows.length - 1;
      const link = row.el === undefined;
      // The corner is the tree's structure and the dash is the kind of
      // citation, so they vary independently: a linked case still closes its
      // parent's branch when it is the last child.
      const stem = `${last ? '└' : '├'}${link ? '╌ ' : '─ '}`;
      const n = tests(row.id);
      // An exception is pinned by the cases it holds, so silence there is not
      // a gap — but a test that cites one directly still counts.
      const mark =
        n > 0
          ? paint('90', `  ${n}`)
          : owesTest(row.id)
            ? paint('31', '  — no test')
            : '';
      const hue = HUE[kindOf(row.id) ?? 'case-'];
      const kind = kindOf(row.id) ?? 'case-';
      const [tag, ...said] = row.label.split(' ');
      out.push(
        `${paint('90', prefix + stem)}${paint(DIM[kind], tag)} ` +
          `${paint(hue, said.join(' '))}${mark}`
      );
      const under = prefix + (last ? '   ' : '│  ');
      if (verbose) {
        const said = row.el?.statement ?? cellStatements.get(row.id);
        // Indented past the tag so the claim sits under the stem it belongs
        // to rather than under the @kind, which is the same word every time.
        const sill = under + ' '.repeat(tag.length + 1);
        if (said) {
          out.push(paint('90', sill) + paint(SAID, clip(said, sill.length)));
        }
        // The edges nesting cannot show: further parents first, as "also",
        // then references, as "see". A link into another document keeps its
        // file name.
        const own = links.get(`${rel}#${row.id}`) ?? [];
        for (const link of [...own.filter(l => l.derives), ...own.filter(l => !l.derives)]) {
          const [doc, id] = link.target.split('#');
          const label = doc === rel ? prose(id) : `${doc}#${id}`;
          const verb = link.derives ? 'also' : 'see';
          out.push(paint('90', `${sill}╌ ${verb} `) + paint(HUE[kindOf(id) ?? 'case-'], label));
        }
      }
      if (row.el) walk(row.el, under);
    });
  };

  for (const root of headings.filter(u => !u.parent || !byId.has(u.parent))) {
    if (!keep(root)) continue;
    const rootKind = kindOf(root.id ?? '') ?? 'axiom-';
    const [rootTag, ...rootLabel] = prose(root.id ?? '').split(' ');
    out.push('');
    out.push(
      // A root is an axiom when the document is sound, but a freelancing unit
      // is a root too, and it is drawn as what it is rather than as an axiom.
      paint(DIM[rootKind], rootTag) +
        ' ' +
        paint(HUE[rootKind], rootLabel.join(' '))
    );
    if (verbose && root.statement) {
      const sill = ' '.repeat(rootTag.length + 1);
      out.push(sill + paint(SAID, clip(root.statement, sill.length)));
    }
    walk(root, '');
  }

  const tally = new Map<Kind, number>();
  for (const u of headings) {
    const k = kindOf(u.id ?? '');
    if (k) tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  const counts = [...tally]
    .map(([k, n]) => `${n} ${noun(k)}${n === 1 ? '' : 's'}`)
    .join(' · ');
  const cells = [...linked.values()].reduce((n, l) => n + l.length, 0);

  const head = paint(
    '1',
    `${rel} — ${counts}${cells ? ` · ${cells} linked from tables` : ''}`
  );
  if (gapsOnly && out.length === 0) {
    return `${head}\n\nevery rule and case is pinned by a test`;
  }
  return [head, ...out].join('\n');
}

/**
 * A heading's rendered anchor, by the rule GitHub and GitLab both slug with:
 * lowercase, drop punctuation, each space becomes a hyphen. Each space, not
 * each run of them: `P1 — Speculation` slugs to `p1--speculation`, because the
 * dropped dash leaves two spaces behind. A unit heading slugs to exactly its
 * declared id, which is what `OVERFULL_HEADING` protects.
 */
const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');

/**
 * Every fragment a citation could resolve to in one file — which is what the
 * RENDERER offers, not what the checker would like to see: a markdown heading
 * carries the anchor its text slugs to, and an explicit `id` carries its own.
 * A section cross-referenced by another document writes the explicit form, so
 * rewording its heading cannot silently break the link.
 */
const idsOf = (() => {
  const cache = new Map<string, Set<string>>();
  return (file: string): Set<string> => {
    let ids = cache.get(file);
    if (!ids) {
      const src = readFileSync(file, 'utf8');
      ids = new Set([...src.matchAll(/\bid="([^"]*)"/g)].map(m => m[1]));
      if (file.endsWith('.md')) {
        for (const m of maskFences(src).matchAll(/^#{1,6}[ \t]+(.+)$/gm)) {
          ids.add(slug(m[1]));
        }
      }
      cache.set(file, ids);
    }
    return ids;
  };
})();

// ---------------------------------------------------------------------------
// Findings.
// ---------------------------------------------------------------------------
type FindingName =
  | 'freelancing'
  | 'misnested'
  | 'cycle'
  | 'rot'
  | 'dead'
  | 'missing-rule'
  | 'not-narrowest'
  | 'uncited'
  | 'unjudgeable'
  | 'stale-toc'
  | 'unreachable'
  | 'untested'
  | 'stale-site';

const MEANING: Record<FindingName, string> = {
  freelancing: 'claim-bearing unit with no upward citation',
  misnested: 'unit nested inside a kind it may not cite',
  cycle: 'units whose citations lead back to themselves — a derivation must not depend on itself',
  rot: 'citation whose anchor does not resolve',
  dead: 'unit nothing cites',
  'missing-rule': 'test citing an axiom rather than a rule',
  'not-narrowest': 'test citing a unit whose cases are the narrower claim',
  uncited: 'test with no citation — the hierarchy inverted',
  unjudgeable: 'test shape the scanner cannot see — its citations go unread',
  'stale-toc': 'generated table of contents out of sync with the document',
  unreachable:
    'heading whose rendered anchor is not the id cited — a dead link',
  untested: 'rule or case no test pins — cited, but only from prose',
  'stale-site': 'case naming a code site that is not there'
};

interface Unit {
  doc: string;
  id: string;
  kind: Kind;
  /** The kinds this unit cites — not which units, since only the kind is owed. */
  cites: Set<Kind>;
  /** Its statement, which for a case is where it names its site. */
  statement?: string;
}

interface Analysis {
  findings: Record<FindingName, string[]>;
  units: Map<string, Unit>;
  suites: number;
  /** The files a writing run rewrote, relative to the repo root. */
  written: string[];
  /** How many tests pin each unit, by `<doc>#<id>`; absent means none. */
  testsPer: Map<string, number>;
  /**
   * Every unit a unit links to, by `<doc>#<id>`, and whether the link is a
   * further parent (it sits in the unit's "Also derives from" sentence) or a
   * reference. Further parents and nesting together are the derivation graph.
   */
  links: Map<string, Array<{ target: string; derives: boolean }>>;
}

/**
 * Read every in-scope document, suite and module, and judge what they cite.
 *
 * With `write`, the generated regions are rewritten instead of reported as
 * `stale-toc`: it is the one difference between the two subcommands.
 */
function analyse(write: boolean): Analysis {
  // Insertion order is report order, so it reads worst-first.
  const findings: Record<FindingName, string[]> = {
    freelancing: [],
    misnested: [],
    cycle: [],
    rot: [],
    dead: [],
    'missing-rule': [],
    'not-narrowest': [],
    uncited: [],
    unjudgeable: [],
    'stale-toc': [],
    unreachable: [],
    untested: [],
    'stale-site': []
  };

  /** every unit, keyed `${doc}#${id}` */
  const units = new Map<string, Unit>();
  /** every fragment cited from anywhere in scope, keyed `${file}#${frag}` */
  const citedTargets = new Set<string>();
  /**
   * What a SUITE cites, which `citedTargets` cannot answer.
   *
   * `dead` counts nesting, prose links and tests alike, so a rule linked from
   * another rule's body leaves it whatever the suites do. That is the right
   * question for "is this reachable" and the wrong one for "does anything hold
   * this to account".
   */
  const testedTargets = new Set<string>();

  /**
   * Units that hold at least one case, and so are pinned by them rather than
   * directly. A decomposed rule states what its cases claim and nothing else,
   * so a test has nothing left to cite at that level — and without this, taking
   * a rule apart would report the rule itself as newly uncovered.
   */
  const holdsCases = new Set<string>();

  const testsPer = new Map<string, number>();

  /**
   * The derivation graph, by `<doc>#<id>`: every unit's citations, its nesting
   * parent and its explicit links alike. A cycle in it is a derivation that
   * depends on itself, which no ordering of the canon can resolve.
   */
  const edges = new Map<string, Set<string>>();
  const links = new Map<string, Array<{ target: string; derives: boolean }>>();
  const addEdge = (into: Map<string, Set<string>>, from: string, to: string): void => {
    const set = into.get(from) ?? new Set<string>();
    set.add(to);
    into.set(from, set);
  };
  /**
   * Whether the link at `at` names a further parent: it sits in a sentence
   * that opens "Also derives from", up to that sentence's end. Every other
   * link is a reference, which cites but does not derive, so a reference back
   * to a unit that derives from this one is not a cycle.
   */
  const DERIVES = /^Also derives from\b/;
  const namesParent = (src: string, at: number): boolean => {
    const lineStart = src.lastIndexOf('\n', at - 1) + 1;
    const line = src.slice(lineStart);
    if (!DERIVES.test(line)) return false;
    const sentenceEnd = line.search(/\.(\s|$)/);
    return sentenceEnd === -1 || at - lineStart < sentenceEnd;
  };

  const written: string[] = [];

  // -------------------------------------------------------------------------
  // Read the documents.
  // -------------------------------------------------------------------------
  for (const rel of DOCS) {
    const file = join(ROOT, rel);
    if (!existsSync(file)) {
      findings.rot.push(`${rel}: in-scope document does not exist`);
      continue;
    }
    const { withId, anchors } = scanFile(file);
    const docSource = readFileSync(file, 'utf8');

    if (rel.endsWith('.md')) {
      for (const m of readFileSync(file, 'utf8').matchAll(OVERFULL_HEADING)) {
        findings.unreachable.push(
          `${rel}: "${m[0].trim()}" — the stem must end the heading`
        );
      }
    }

    for (const el of withId) {
      const kind = el.id ? kindOf(el.id) : undefined;
      if (kind && el.id)
        units.set(`${rel}#${el.id}`, {
          doc: rel,
          id: el.id,
          kind,
          cites: new Set(),
          statement: el.statement
        });
    }

    // Nesting is a citation, and the strongest kind: a rule written inside its
    // axiom cannot claim one axiom and sit under another, the way a prose link
    // repeated in every rule eventually does. So a unit that sits inside another
    // has already cited it, and writes no link — an explicit citation is reserved
    // for the edges the tree cannot hold, a second parent or another document.
    for (const el of withId) {
      if (!el.id || !el.parent) continue;
      const parentKind = kindOf(el.parent);
      if (!parentKind) continue;
      if (kindOf(el.id) === 'case-') holdsCases.add(`${rel}#${el.parent}`);
      units.get(`${rel}#${el.id}`)?.cites.add(parentKind);
      addEdge(edges, `${rel}#${el.id}`, `${rel}#${el.parent}`);
      citedTargets.add(`${rel}#${el.parent}`);

      // Nesting is a citation, so sitting somewhere a unit may not cite is
      // one — `freelancing` misses it, because a prose link to the right kind
      // satisfies the owes-check while the position goes on saying the wrong
      // thing. Position cannot contradict itself, but it can contradict OWES.
      const kind = kindOf(el.id);
      if (kind && !(OWES[kind] ?? []).includes(parentKind)) {
        findings.misnested.push(
          `${rel}#${el.id} — a ${noun(kind)} sitting in ${el.parent}, which a ${noun(kind)} may not cite`
        );
      }
    }

    for (const a of anchors) {
      if (/^(https?:|mailto:)/.test(a.href) || !a.href.includes('#')) continue;
      const [path, frag] = a.href.split('#');
      const targetFile = path ? join(dirname(file), path) : file;
      const targetRel = relative(ROOT, targetFile);

      // rot — the anchor must resolve in the file it points at
      if (!existsSync(targetFile)) {
        findings.rot.push(`${rel}: href="${a.href}" — no such file`);
        continue;
      }
      if (!idsOf(targetFile).has(frag)) {
        findings.rot.push(
          `${rel}: href="${a.href}" — no id="${frag}" in ${targetRel}`
        );
        continue;
      }
      citedTargets.add(`${targetRel}#${frag}`);

      // Attribute the citation exactly the way the page's backlink script does:
      // the innermost element with an id that contains the anchor, and failing
      // that the nearest preceding one — so a rule stated by a heading is credited
      // with the citation in the paragraph beneath it. Whether the element that
      // wins is a claim-bearing unit is then a separate question; if it is not,
      // the citation belongs to no unit and lands nowhere, which is honest.
      const owner =
        withId
          .filter(e => a.at >= e.start && a.at < e.end)
          .sort((x, y) => y.start - x.start)[0] ??
        withId.filter(e => e.start < a.at).sort((x, y) => y.start - x.start)[0];
      const targetKind = kindOf(frag);
      if (owner?.id && targetKind)
        units.get(`${rel}#${owner.id}`)?.cites.add(targetKind);
      if (owner?.id && kindOf(owner.id) && targetKind) {
        const from = `${rel}#${owner.id}`;
        const to = `${targetRel}#${frag}`;
        if (from !== to) {
          const derives = namesParent(docSource, a.at);
          if (derives) addEdge(edges, from, to);
          const list = links.get(from) ?? [];
          if (!list.some(l => l.target === to)) list.push({ target: to, derives });
          links.set(from, list);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // The table of contents, regenerated by generate and checked by check.
  // ---------------------------------------------------------------------------
  for (const rel of DOCS) {
    if (!rel.endsWith('.md')) continue;
    const file = join(ROOT, rel);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    // A document with no units has no derivation tree, so it owes no index.
    if (!tocOf(src)) continue;
    const next = replaceRegion(src, 'toc', TOC_END, tocOf(src));
    if (next === undefined) {
      findings['stale-toc'].push(`${rel}: no ${TOC_BEGIN} … ${TOC_END} region`);
      continue;
    }
    if (next === src) continue;
    if (write) {
      writeFileSync(file, next);
      written.push(rel);
    } else {
      findings['stale-toc'].push(
        `${rel}: out of date — run \`${COMMAND} generate\``
      );
    }
  }

  {
    const shown = relative(ROOT, PROTOCOL);
    if (existsSync(PROTOCOL)) {
      const src = readFileSync(PROTOCOL, 'utf8');
      const next = replaceRegion(src, 'kinds', KINDS_END, kindsTable());
      if (next === undefined) {
        findings['stale-toc'].push(
          `${shown}: no ${KINDS_BEGIN} … ${KINDS_END} region`
        );
      } else if (next !== src) {
        if (write) {
          writeFileSync(PROTOCOL, next);
          written.push(shown);
        } else {
          findings['stale-toc'].push(
            `${shown}: the kinds table no longer matches OWES — run \`${COMMAND} generate\``
          );
        }
      }
    }
  }

  // cycle — a derivation that depends on itself. Each cycle is reported once,
  // by the order it is first walked into.
  {
    const state = new Map<string, 'open' | 'done'>();
    const reported = new Set<string>();
    const walk = (node: string, path: string[]): void => {
      state.set(node, 'open');
      for (const next of edges.get(node) ?? []) {
        if (state.get(next) === 'open') {
          const loop = [...path.slice(path.indexOf(next)), next];
          const key = [...loop.slice(0, -1)].sort().join(' ');
          if (!reported.has(key)) {
            reported.add(key);
            findings.cycle.push(loop.map(k => k.split('#')[1]).join(' → '));
          }
        } else if (!state.has(next)) {
          walk(next, [...path, next]);
        }
      }
      state.set(node, 'done');
    };
    for (const node of edges.keys()) if (!state.has(node)) walk(node, [node]);
  }

  // freelancing — a claim-bearing unit with no upward citation
  for (const [key, unit] of units) {
    const owes = OWES[unit.kind];
    if (owes === null) continue;
    if (!owes.some(p => unit.cites.has(p))) {
      findings.freelancing.push(
        `${key} (a ${noun(unit.kind)} owes ${owes.join(' | ')})`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Read the test suites.
  // ---------------------------------------------------------------------------
  // Leaf tests only. A `describe` groups; it does not claim. Requiring a citation
  // on one produced two bad outcomes when tried: an outer grouping had to be given
  // some child's anchor arbitrarily, and an inner grouping restated a citation its
  // every child already carried. Neither adds a link that was missing, and the
  // first invents one that is not true. So the unit that owes a rule is the test
  // that asserts something.
  const TEST_BLOCK =
    /(?:^|\n)([ \t]*)(?:\/\*\*([\s\S]*?)\*\/\s*\n[ \t]*)?(?:it|test)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\3)[\s\S])*)\3/g;

  /**
   * Every unit id, and the documents that declare it.
   *
   * A citation names a unit by its id alone — `@canon rule-x` — so an id must
   * be unique across every canon document. The file adds nothing a unique id
   * does not already say, and leaving it out means moving a unit between
   * documents breaks no test.
   */
  const docsOf = new Map<string, string[]>();
  for (const unit of units.values()) {
    docsOf.set(unit.id, [...(docsOf.get(unit.id) ?? []), unit.doc]);
  }
  for (const [id, docs] of docsOf) {
    if (docs.length > 1) {
      findings.rot.push(
        `${id} is declared in ${docs.join(' and ')} — a citation cannot tell which`
      );
    }
  }

  /**
   * Resolve one `@canon` or `@axiom` citation to its unit's key, reporting
   * `rot` and returning undefined when it names no unit or more than one.
   */
  function resolveCitation(cite: string, where: string): string | undefined {
    if (cite.includes('#')) {
      findings.rot.push(
        `${where} — citation "${cite}" names a file; cite the id alone, as "${cite.split('#').pop()}"`
      );
      return undefined;
    }
    const docs = docsOf.get(cite);
    if (docs === undefined) {
      findings.rot.push(`${where} — citation "${cite}" names no unit`);
      return undefined;
    }
    if (docs.length > 1) return undefined; // already reported above
    return `${docs[0]}#${cite}`;
  }

  /**
   * Read one suite's citations.
   *
   * `enforced` separates the two things declared scope was doing at once. A file
   * in scope has CLAIMED to derive from these documents, so an untagged test in
   * it is a finding — that is what the declaration buys, and it is why scope can
   * never be a glob. But a citation is a true statement about a link wherever it
   * is written, and refusing to read one because its neighbours are untagged
   * discards a real link to preserve a property about silence. So every suite is
   * READ, and only a declared one is JUDGED.
   *
   * The practical case is a suite most of which answers to mathematics or to
   * nothing in particular, holding two or three tests that do pin a rule. Putting
   * the whole file in scope to capture those would demand a citation from the
   * other thirty, and the only way to supply thirty is to invent them.
   */
  function readSuite(file: string, enforced: boolean): void {
    {
      const rel = relative(ROOT, file);
      const src = readFileSync(file, 'utf8');

      // TEST_BLOCK demands a quoted title right after the paren, so an
      // `it.each([...])('title', fn)` or tagged-template `` it.each`table` `` is
      // invisible to it: not judged for being uncited, and its citations —
      // however correct the JSDoc above it — never read, so a rule kept alive
      // only by one reports as dead. Rather than teach the scanner every shape,
      // refuse the shape loudly where the file has claimed to participate: a
      // declared suite uses plain `it`s, or this scanner learns the form first.
      if (enforced) {
        for (const each of src.matchAll(/\b(?:it|test)\.each\b/g)) {
          const line = src.slice(0, each.index ?? 0).split('\n').length;
          findings.unjudgeable.push(
            `${rel}:${line} — \`${each[0]}\` in a declared suite; use plain it()s here, or extend TEST_BLOCK to read this shape`
          );
        }
      }

      for (const m of src.matchAll(TEST_BLOCK)) {
        const doc = m[2] ?? '';
        const title = m[4];
        // The reported line is the `it(` itself, not the top of its JSDoc.
        const call =
          /(?:it|test)(?:\.\w+)*\s*\(\s*['"`][\s\S]*$/.exec(m[0])?.[0] ?? m[0];
        const line = src
          .slice(0, (m.index ?? 0) + m[0].length - call.length)
          .split('\n').length;
        const axioms = [...doc.matchAll(/@axiom\s+(\S+)/g)].map(x =>
          x[1].startsWith('axiom-') ? x[1] : `axiom-${x[1]}`
        );
        const specs = [...doc.matchAll(/@canon\s+(\S+)/g)].map(x => x[1]);

        // A test owes a RULE. Citing an axiom is not a different way of saying the
        // same thing — it says the canon has no addressable rule for what is being
        // asserted, which is a gap in the canon rather than in the test. Both the
        // dedicated tag and an `@canon` that happens to name an axiom mean
        // that, and only checking the tag let the second form through unnoticed.
        const axiomCitations = [
          ...axioms,
          ...specs.filter(s => kindOf(s) === 'axiom-')
        ];
        for (const a of enforced ? axiomCitations : []) {
          findings['missing-rule'].push(
            `${rel}:${line} "${title}" — cites ${a} (the canon has no addressable rule for this)`
          );
        }

        if (enforced && axioms.length === 0 && specs.length === 0) {
          findings.uncited.push(
            `${rel}:${line} "${title}" — no @canon / @axiom`
          );
        }

        for (const s of [...specs, ...axioms]) {
          const key = resolveCitation(s, `${rel}:${line}`);
          if (key === undefined) continue;
          citedTargets.add(key);
          testedTargets.add(key);
          testsPer.set(key, (testsPer.get(key) ?? 0) + 1);

          // A test owes the NARROWEST unit its assertion could contradict,
          // and where a unit has cases the claim is in one of them. Citing
          // the parent instead leaves that case reading as uncovered in
          // `dead`, which is the coverage backlog; citing it as well is a
          // second statement of what the case's own position already says.
          if (enforced && holdsCases.has(key)) {
            findings['not-narrowest'].push(
              `${rel}:${line} "${title}" — cites ${s}, which has cases`
            );
          }
        }
      }
    }
  }

  /** A test file: `.test` or `.spec`, in TypeScript with or without JSX. */
  const isSuite = (name: string): boolean => /\.(test|spec)\.tsx?$/.test(name);

  /** Every suite under a tree, so a voluntary citation is still read. */
  function allSuites(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const entry = join(dir, name);
      if (statSync(entry).isDirectory()) {
        allSuites(entry, out);
      } else if (isSuite(name)) {
        out.push(entry);
      }
    }
    return out;
  }

  /** Every other `.ts` — the implementation, which may cite the canon in its JSDoc. */
  function allModules(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const entry = join(dir, name);
      if (statSync(entry).isDirectory()) {
        allModules(entry, out);
      } else if (/\.tsx?$/.test(name) && !isSuite(name)) {
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Every declared prose reference that is not itself in scope: the documents
   * that explain the canon, whose links must resolve.
   *
   * Markdown only. A `.ts` beside them may be tooling that writes the literal
   * `@canon` in its own strings because it is what parses the tag — so reading
   * it would find citations that were never citations.
   */
  function allReferences(path: string, out: string[] = []): string[] {
    if (!existsSync(path)) return out;
    if (!statSync(path).isDirectory()) {
      if (path.endsWith('.md') && !DOCS.includes(relative(ROOT, path)))
        out.push(path);
      return out;
    }
    for (const name of readdirSync(path)) allReferences(join(path, name), out);
    return out;
  }

  /**
   * Check a module's `@canon` tags resolve, and nothing else.
   *
   * A citation is a true statement about a link wherever it is written, which is
   * the same argument `readSuite` makes for reading an undeclared suite. It does
   * NOT add to `citedTargets`: a unit mentioned in prose still owes a test, and
   * `dead` is the list that says so.
   */
  function readModule(file: string): void {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/@canon\s+(\S+)/g)) {
      const line = src.slice(0, m.index ?? 0).split('\n').length;
      resolveCitation(m[1], `${rel}:${line}`);
    }
  }

  // A project that has not written its first declared suite yet has no
  // directory to read, which is zero suites rather than an error.
  const enforcedFiles = new Set<string>(
    existsSync(join(ROOT, TESTS)) ? allSuites(join(ROOT, TESTS)) : []
  );
  for (const file of enforcedFiles) readSuite(file, true);

  /**
   * Check a reference's citations resolve, and nothing else.
   *
   * The `@canon` tags `readModule` already reads, plus the markdown links prose
   * cites with. Without this, a renamed unit leaves a dead link in the very
   * document a reader learns the canon from, and nothing reports it.
   *
   * Resolve-only, for `readModule`'s reason: a worked example must not discharge
   * the test a unit owes.
   */
  function readReference(file: string): void {
    readModule(file);
    if (!file.endsWith('.md')) return;
    const rel = relative(ROOT, file);
    for (const a of scanFile(file).anchors) {
      if (/^(https?:|mailto:)/.test(a.href) || !a.href.includes('#')) continue;
      const [path, frag] = a.href.split('#');
      const target = path ? join(dirname(file), path) : file;
      if (!existsSync(target)) {
        findings.rot.push(`${rel}: href="${a.href}" — no such file`);
      } else if (!idsOf(target).has(frag)) {
        findings.rot.push(
          `${rel}: href="${a.href}" — no id="${frag}" in ${relative(ROOT, target)}`
        );
      }
    }
  }

  // Every tree is swept, read but not judged — the distinction `readSuite`
  // draws. A citation is a true statement about a link wherever it is written,
  // so a rule pinned solely by an undeclared suite is not dead, and sweeping
  // only the declared tree would report it as one: the exact misreading the
  // `dead` list exists to prevent.
  for (const root of SOURCES) {
    const abs = join(ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of allSuites(abs)) {
      if (!enforcedFiles.has(file)) readSuite(file, false);
    }
    for (const file of allModules(abs)) readModule(file);
  }

  for (const ref of REFERENCES)
    for (const file of allReferences(join(ROOT, ref))) readReference(file);

  // dead — a unit nothing cites. Last, after every suite has been read: a rule
  // kept alive by a test it has not reached yet would otherwise report dead,
  // and the list would read as a canon full of unreachable units.
  for (const [key, unit] of units) {
    if (!citedTargets.has(key))
      findings.dead.push(`${key} (a ${noun(unit.kind)})`);
  }

  // stale-site — a case naming a code site that is not there.
  //
  // A case opens by naming the place it is about: `` `queue.ts` `drain` ``.
  // That is a claim about the code, and the only one in these documents a
  // machine can check against the code itself — whether every place has a case
  // cannot be, so this is the half that can.
  //
  // It is the rename it catches. Every citation of a renamed unit is caught by
  // `rot`, and nothing watched the leads: a case would go on naming a symbol
  // that had not existed since the rename that moved everything else.
  const NAMES_A_SITE = /^`([\w.-]+\.tsx?)`\s+`([^`]+)`/;
  const srcByName = new Map<string, string>();
  for (const root of SOURCES) {
    const abs = join(ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of allModules(abs)) {
      srcByName.set(file.split('/').pop() ?? file, file);
    }
  }
  for (const [key, unit] of units) {
    if (unit.kind !== 'case-' || !unit.statement) continue;
    const named = NAMES_A_SITE.exec(unit.statement);
    if (!named) continue;
    const [, file, symbol] = named;
    const path = srcByName.get(file);
    if (path === undefined) {
      findings['stale-site'].push(
        `${key} names ${file}, which is not in ${SOURCES.join(' or ')}`
      );
      continue;
    }
    // The leaf of a dotted name, and without a call's parentheses.
    const bare = symbol.split('.').pop()?.replace(/\(\)$/, '') ?? symbol;
    if (
      !new RegExp(`\\b${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(
        readFileSync(path, 'utf8')
      )
    ) {
      findings['stale-site'].push(
        `${key} names \`${symbol}\` in ${file}, which is not there`
      );
    }
  }

  // untested — a claim no test pins.
  //
  // Only a rule and a case: an axiom is reached through the rules beneath it and
  // a test naming one is already reported. A unit holding cases is pinned by
  // them, which is what an exception always was and what a rule becomes the
  // moment it is decomposed.
  for (const [key, unit] of units) {
    if (unit.kind !== 'rule-' && unit.kind !== 'case-') continue;
    if (holdsCases.has(key)) continue;
    if (!testedTargets.has(key)) {
      findings.untested.push(`${key} (a ${noun(unit.kind)})`);
    }
  }

  return { findings, units, suites: enforcedFiles.size, written, testsPer, links };
}

// ---------------------------------------------------------------------------
// The command line.
// ---------------------------------------------------------------------------

const HELP = `canon — derivation links for a project's canon

Every unit that makes a derived claim carries a machine-checkable link to what
it derives from — its position under the unit it derives from, a prose link in
a document, a @canon JSDoc tag in a test — and the documents' index and the
table of kinds are generated from those links rather than hand-kept. check is
the gate, generate is the writer, tree is the map.

Usage:
  ${COMMAND} check                 report every finding; exit 1 if there is one
  ${COMMAND} generate              rewrite the generated regions
  ${COMMAND} tree [options]        print the derivation tree with test counts

Options for tree:
  --gaps          only the branches leading to a claim no test pins
  -v, --verbose   what each unit claims, and the units it links to, under its stem
  --suspect [n]   rules with no cases carrying n or more tests (default 4)

The protocol is SKILL.md, beside this file. The scope is the "canon" field of
package.json: documents, suites, sources, references, command.

What check reports:
${(Object.keys(MEANING) as FindingName[])
  .map(name => `  ${name.padEnd(14)}${MEANING[name]}`)
  .join('\n')}

Tree connectors:
  ├─ └─   nesting — the ordinary citation
  ├╌ └╌   a link — a case in a table, which cannot nest

Stems are shown as prose: @rule A write lands at once is the unit
rule-a-write-lands-at-once. Lower the words and hyphenate to get the id back.

--suspect is a heuristic and deliberately not part of check. A rule carrying
many tests and no cases is usually saying several things with no way to say
so. But not always: a rule can carry several tests of one claim, enumerated
per input, and cases there would only restate their own rule.

Exit codes:
  0  success
  1  check found something
  2  bad usage`;

function check(): void {
  const { findings, units, suites } = analyse(false);

  console.log(`canon check — ${ROOT}\n`);
  console.log(`scope: ${DOCS.length} document(s), ${suites} declared suite(s)`);
  console.log(`units: ${units.size}\n`);

  let total = 0;
  for (const name of Object.keys(findings) as FindingName[]) {
    const list = findings[name];
    total += list.length;
    console.log(`${name} — ${MEANING[name]}: ${list.length}`);
    for (const entry of list) console.log(`  · ${entry}`);
    console.log('');
  }

  console.log(total === 0 ? 'clean' : `${total} finding(s)`);
  process.exit(total === 0 ? 0 : 1);
}

function generate(): void {
  const { written } = analyse(true);
  if (written.length === 0) {
    console.log('every generated region is already what the units say');
    return;
  }
  for (const rel of written) console.log(`wrote ${rel}`);
}

function tree(options: {
  gaps: boolean;
  verbose: boolean;
  suspect: number | undefined;
}): void {
  const { testsPer, links } = analyse(false);
  for (const doc of DOCS) {
    const file = join(ROOT, doc);
    if (!existsSync(file)) continue;
    console.log(
      options.suspect !== undefined
        ? suspectsOf(file, testsPer, options.suspect)
        : treeOf(file, testsPer, options.gaps, options.verbose, links)
    );
  }
}

function main(argv: string[]): void {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        gaps: { type: 'boolean' },
        verbose: { type: 'boolean', short: 'v' },
        suspect: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      }
    });
  } catch (error) {
    // `--suspect` with no number is the default threshold, which parseArgs
    // cannot express for a string option, so it is retried as `--suspect 4`.
    const at = argv.indexOf('--suspect');
    if (at !== -1 && !/^\d+$/.test(argv[at + 1] ?? '')) {
      main([...argv.slice(0, at + 1), '4', ...argv.slice(at + 1)]);
      return;
    }
    console.error(`canon: ${(error as Error).message}\n\n${HELP}`);
    process.exit(2);
  }

  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === 'help') {
    console.log(HELP);
    return;
  }
  if (rest.length > 0) {
    console.error(`canon: unexpected argument "${rest[0]}"\n\n${HELP}`);
    process.exit(2);
  }

  switch (command) {
    case 'check':
      check();
      return;
    case 'generate':
      generate();
      return;
    case 'tree': {
      const suspect =
        typeof values.suspect === 'string' ? Number(values.suspect) : undefined;
      if (suspect !== undefined && !Number.isInteger(suspect)) {
        console.error('canon: --suspect takes a whole number');
        process.exit(2);
      }
      tree({
        gaps: values.gaps === true,
        verbose: values.verbose === true,
        suspect
      });
      return;
    }
    default:
      console.error(`canon: unknown command "${command}"\n\n${HELP}`);
      process.exit(2);
  }
}

main(process.argv.slice(2));
