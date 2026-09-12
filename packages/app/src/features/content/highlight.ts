/** Bounded syntax coloring for fenced code. A fixed set of languages is
 * tokenized with anchored, linear patterns into comment, string, number,
 * keyword, builtin and punctuation runs; every other run stays plain text.
 * The tokens concatenate back to the exact input, so nothing is rewritten,
 * and unknown languages or over-budget blocks are shown uncoloured. */
export type TokenKind =
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "builtin"
  | "punctuation"
  | "text";
export interface Token {
  kind: TokenKind;
  text: string;
}
export const HIGHLIGHT_LIMITS = Object.freeze({ chars: 16_384, tokens: 8_192 });

type Rule = [TokenKind, RegExp];
const words = (list: string, flags = "") =>
  new RegExp(`\\b(?:${list.trim().split(/\s+/).join("|")})\\b`, `y${flags}`);
const lineComment = (marker: string): Rule => ["comment", new RegExp(`${marker}[^\\n]*`, "y")];
const blockComment: Rule = ["comment", /\/\*[\s\S]*?(?:\*\/|$)/y];
const doubleString: Rule = ["string", /"(?:[^"\\\n]|\\.)*(?:"|(?=\n)|$)/y];
const singleString: Rule = ["string", /'(?:[^'\\\n]|\\.)*(?:'|(?=\n)|$)/y];
const templateString: Rule = ["string", /`(?:[^`\\]|\\.)*(?:`|$)/y];
const number: Rule = ["number", /\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[nNfFlLuU]?)\b/y];
const punctuation: Rule = ["punctuation", /[{}()[\];,.]/y];
const whitespace: Rule = ["text", /\s+/y];
const word: Rule = ["text", /[A-Za-z_$][\w$]*/y];
const anything: Rule = ["text", /[\s\S]/y];

const cLike = (keywords: string, builtins: string): Rule[] => [
  lineComment("//"),
  blockComment,
  doubleString,
  singleString,
  templateString,
  number,
  ["keyword", words(keywords)],
  ["builtin", words(builtins)],
  word,
  punctuation,
  whitespace,
  anything,
];
const LANGUAGES: Record<string, Rule[]> = {
  javascript: cLike(
    "async await break case catch class const continue debugger default delete do else enum export extends finally for from function if implements import in instanceof interface let new of package private protected public return static super switch this throw try type typeof var void while with yield as declare namespace readonly keyof satisfies abstract",
    "true false null undefined NaN Infinity console window document globalThis Promise Array Object String Number Boolean Map Set Symbol JSON Math Date Error",
  ),
  python: [
    lineComment("#"),
    ["string", /(?:[rRbBuUfF]{0,2})(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/y],
    ["string", /(?:[rRbBuUfF]{0,2})(?:"(?:[^"\\\n]|\\.)*(?:"|(?=\n)|$)|'(?:[^'\\\n]|\\.)*(?:'|(?=\n)|$))/y],
    number,
    ["keyword", words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case")],
    ["builtin", words("True False None self cls print len range str int float list dict set tuple bool bytes open enumerate zip map filter sorted min max sum any all isinstance type super Exception ValueError TypeError KeyError")],
    word,
    punctuation,
    whitespace,
    anything,
  ],
  json: [doubleString, number, ["builtin", words("true false null")], punctuation, whitespace, anything],
  shell: [
    lineComment("#"),
    doubleString,
    singleString,
    ["builtin", /\$(?:\{[^}\n]*\}|[\w@#?*!$-]+)/y],
    number,
    ["keyword", words("if then else elif fi for while until do done case esac in function select export local readonly return exit set unset shift source alias cd echo printf test")],
    word,
    punctuation,
    whitespace,
    anything,
  ],
  sql: [
    lineComment("--"),
    blockComment,
    singleString,
    doubleString,
    number,
    ["keyword", words("select from where insert into values update set delete create table drop alter join left right inner outer full on group by order having limit offset as and or not null primary key default index if exists union all distinct with returning between like in is case when then else end begin commit rollback transaction view trigger references foreign check unique constraint", "i")],
    ["builtin", words("count sum avg min max coalesce cast integer text real blob boolean varchar date timestamp", "i")],
    word,
    punctuation,
    whitespace,
    anything,
  ],
  css: [
    blockComment,
    doubleString,
    singleString,
    ["keyword", /[a-zA-Z-]+(?=\s*:)/y],
    ["number", /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch)?\b/y],
    ["builtin", /@[a-zA-Z-]+/y],
    word,
    punctuation,
    whitespace,
    anything,
  ],
  markup: [
    ["comment", /<!--[\s\S]*?(?:-->|$)/y],
    ["keyword", /<\/?[A-Za-z][\w:.-]*|\/?>/y],
    ["builtin", /[A-Za-z_:][\w:.-]*(?=\s*=)/y],
    doubleString,
    singleString,
    ["text", /[^<>"'\s]+/y],
    whitespace,
    anything,
  ],
  yaml: [
    lineComment("#"),
    doubleString,
    singleString,
    ["keyword", /[\w.$-]+(?=:(?:\s|$))/y],
    ["builtin", words("true false null yes no on off")],
    number,
    ["punctuation", /[-:[\]{},|>]/y],
    ["text", /[^\s:#"'\-\[\]{},|>][^\s:#]*/y],
    whitespace,
    anything,
  ],
  rust: cLike(
    "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
    "true false Some None Ok Err Vec String Box Option Result u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f32 f64 bool char str",
  ),
  go: cLike(
    "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    "true false nil string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 bool byte rune error make new len cap append panic recover",
  ),
  java: cLike(
    "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield",
    "true false null String System Integer Long Double Boolean List Map Set Object",
  ),
  c: cLike(
    "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename using new delete public private protected virtual override this nullptr constexpr try catch throw",
    "true false NULL size_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t bool std printf malloc free",
  ),
  csharp: cLike(
    "abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await record init get set value yield",
    "true false null Console String List Dictionary Task",
  ),
};
const ALIASES: Record<string, string> = {
  javascript: "javascript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  typescript: "javascript", ts: "javascript", tsx: "javascript",
  python: "python", py: "python",
  json: "json", jsonc: "json",
  bash: "shell", sh: "shell", shell: "shell", zsh: "shell", console: "shell", fish: "shell",
  sql: "sql", sqlite: "sql", postgresql: "sql", mysql: "sql",
  css: "css", scss: "css",
  html: "markup", xml: "markup", svg: "markup", vue: "markup",
  yaml: "yaml", yml: "yaml",
  rust: "rust", rs: "rust",
  go: "go", golang: "go",
  java: "java", kotlin: "java", kt: "java",
  c: "c", cpp: "c", "c++": "c", h: "c", hpp: "c", cc: "c",
  csharp: "csharp", cs: "csharp",
};

/** The language family for a Markdown code class such as `language-ts`, or null. */
export function highlightLanguage(className: string | undefined): string | null {
  const match = /^language-([a-zA-Z0-9_+-]{1,48})$/.exec(className ?? "");
  if (!match) return null;
  return ALIASES[match[1]!.toLowerCase()] ?? null;
}

/** Tokenize code for a supported language family. Returns null when the
 * language is unsupported or the block exceeds the display budget; the
 * returned tokens concatenate to exactly the input. */
export function tokenize(code: string, language: string): Token[] | null {
  const rules = LANGUAGES[language];
  if (!rules || code.length > HIGHLIGHT_LIMITS.chars) return null;
  const tokens: Token[] = [];
  let index = 0;
  while (index < code.length) {
    let matched: Token | null = null;
    for (const [kind, pattern] of rules) {
      pattern.lastIndex = index;
      const found = pattern.exec(code);
      if (found && found.index === index && found[0].length > 0) {
        matched = { kind, text: found[0] };
        break;
      }
    }
    if (!matched) matched = { kind: "text", text: code[index]! };
    const previous = tokens[tokens.length - 1];
    if (previous && previous.kind === matched.kind && matched.kind === "text")
      previous.text += matched.text;
    else tokens.push(matched);
    if (tokens.length > HIGHLIGHT_LIMITS.tokens) return null;
    index += matched.text.length;
  }
  return tokens;
}
