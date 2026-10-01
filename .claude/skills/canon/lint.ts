#!/usr/bin/env node
/**
 * `canon lint` — language checks on the prose of the canon documents and the
 * protocol. Reports passive voice, wordy phrasing, repeated
 * words, wrong indefinite articles, and sentences and paragraphs longer than
 * the limits below.
 *
 * Kept apart from `cli.ts`, which depends on nothing outside Node: this file
 * needs the unified and retext packages, installed as dev dependencies.
 *
 * Usage: pnpm canon lint [file …], or node .claude/skills/canon/lint.ts [file …].
 * With no files, it reads the canon documents declared in package.json and
 * the protocol beside this file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Root as MdastRoot } from 'mdast'
import type { Paragraph, Root as NlcstRoot, Sentence } from 'nlcst'
import remarkParse from 'remark-parse'
import remarkRetext from 'remark-retext'
import retextEnglish from 'retext-english'
import retextIndefiniteArticle from 'retext-indefinite-article'
import retextPassive from 'retext-passive'
import retextRepeatedWords from 'retext-repeated-words'
import retextSimplify from 'retext-simplify'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { VFile } from 'vfile'
import { reporter } from 'vfile-reporter'

/**
 * The longest sentence allowed, in words. ASD-STE100, Simplified Technical
 * English, allows 25 words in a descriptive sentence.
 */
const MAX_WORDS = 25

/** The most sentences allowed in one paragraph. */
const MAX_SENTENCES = 5

/**
 * Words `retext-simplify` would replace that name parts of the system or of
 * JavaScript, so a plainer word would change the meaning.
 */
const VOCABULARY = ['component', 'effect', 'function', 'interface', 'option', 'render', 'type']

/**
 * Blank out what is not prose written by hand, keeping every offset so the
 * positions reported still point into the file: HTML comments and the
 * regions `canon generate` writes.
 */
function blankGenerated(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ')
  return src
    .replace(/<!--[ \t]*(\w+):begin\b[\s\S]*?<!-- \1:end -->/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
}

/** Drop headings: a unit heading is an identifier, not a sentence. */
function remarkDropHeadings() {
  return (tree: MdastRoot) => {
    tree.children = tree.children.filter((node) => node.type !== 'heading')
  }
}

/** Report sentences and paragraphs longer than the limits. */
function retextLength() {
  return (tree: NlcstRoot, file: VFile) => {
    visit(tree, 'SentenceNode', (sentence: Sentence) => {
      const words = sentence.children.filter((node) => node.type === 'WordNode').length
      if (words > MAX_WORDS) {
        const message = file.message(
          `Sentence has ${words} words, more than ${MAX_WORDS}`,
          { place: sentence.position, ruleId: 'sentence-length', source: 'canon-lint' },
        )
        message.fatal = false
      }
    })
    visit(tree, 'ParagraphNode', (paragraph: Paragraph) => {
      const sentences = paragraph.children.filter((node) => node.type === 'SentenceNode').length
      if (sentences > MAX_SENTENCES) {
        file.message(`Paragraph has ${sentences} sentences, more than ${MAX_SENTENCES}`, {
          place: paragraph.position,
          ruleId: 'paragraph-length',
          source: 'canon-lint',
        })
      }
    })
  }
}

const processor = unified()
  .use(remarkParse)
  .use(remarkDropHeadings)
  .use(
    remarkRetext,
    unified()
      .use(retextEnglish)
      .use(retextPassive)
      .use(retextSimplify, { ignore: [...VOCABULARY, 'it is'] })
      .use(retextRepeatedWords)
      .use(retextIndefiniteArticle)
      .use(retextLength),
  )

/** The root of the project: the nearest directory with a `canon` field. */
function projectRoot(): string {
  for (let dir = resolve(process.cwd()); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).canon !== undefined) {
      return dir
    }
    if (dirname(dir) === dir) throw new Error('no package.json with a "canon" field')
  }
}

/**
 * Lint `paths`, or with none the canon documents declared in package.json and
 * the protocol beside this file. Prints the findings and returns how many
 * there were.
 */
export async function lint(paths: string[]): Promise<number> {
  const root = projectRoot()
  const protocol = join(dirname(fileURLToPath(import.meta.url)), 'SKILL.md')
  const documents: string[] =
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).canon.documents ?? ['CANON.md']
  const targets =
    paths.length > 0 ? paths.map((f) => resolve(f)) : [...documents.map((d) => join(root, d)), protocol]

  const files: VFile[] = []
  for (const path of targets) {
    const file = new VFile({ path: relative(root, path), value: blankGenerated(readFileSync(path, 'utf8')) })
    await processor.run(processor.parse(file), file)
    files.push(file)
  }

  console.log(reporter(files, { quiet: true }))
  return files.reduce((n, f) => n + f.messages.length, 0)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit((await lint(process.argv.slice(2))) === 0 ? 0 : 1)
}
