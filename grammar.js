/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

/**
 * @param {RuleOrLiteral} sep
 * @param {RuleOrLiteral} rule
 * @returns {SeqRule}
 */
const sep1 = (sep, rule) => seq(rule, repeat(seq(sep, rule)));

/**
 * @param {RuleOrLiteral} rule
 * @returns {ChoiceRule}
 */
const commaSep = (rule) => optional(sep1(",", rule));

/**
 * @param {RuleOrLiteral} rule
 * @returns {SeqRule}
 */
const commaSep1 = (rule) => sep1(",", rule);

export default grammar({
  name: "nexus",

  extras: ($) => [/\s+/, $.line_comment, $.block_comment],

  // identifier is the word token: used for keyword extraction.
  // Restricted to lowercase/underscore-start so uppercase names (uident)
  // are lexically disjoint — no tokenizer conflict.
  word: ($) => $.identifier,

  conflicts: ($) => [
    // `foo` vs `foo.bar` — variable or start of dotted_identifier
    [$.variable, $.dotted_identifier],
    // `&x` — borrow_expr starting with `&` or sigil `&` in variable/let_stmt
    [$.sigil, $.borrow_expr],
    // `@x` — force_expr starting with `@` or sigil `@` in variable/let_stmt
    [$.sigil, $.force_expr],
    // (`else if ...` chain disambiguation handled below via _atom_expr/_stmt conflicts.)
    // `x` vs start of `x.y` (dotted_identifier in call_expr) vs start of
    // `x.Y` (_ctor_path module prefix). Identifier-as-variable wins by default.
    [$._ctor_path, $.variable, $.dotted_identifier],
    [$._ctor_path, $.dotted_identifier],
    [$._ctor_path, $.variable],
    [$._ctor_path],
    // Block-style if/match/while/for/try at the head of a stmt block:
    // direct `_stmt` route vs `expr_stmt → _expr → _atom_expr → x_stmt`.
    // The direct route is preferred (shorter parse).
    [$._stmt, $._atom_expr],
    [$._stmt, $._atom_expr, $.if_stmt],
    [$._stmt, $._atom_expr, $.if_let_stmt],
    // dangling-else: `else if_stmt` (chain — inner if consumes the `end`) vs
    // `else_branch: stmt*` (block, current `if` consumes the `end`). When the
    // else branch is a single `if`, both shapes are valid; the chain form is
    // semantically preferred to keep nesting flat. Same for if_let_stmt.
    [$._atom_expr, $.if_stmt],
    [$._atom_expr, $.if_let_stmt],
    // bitwise `|` (binary_expr) shares its token with match/catch arm separators
    // and can trail any expr-position form. binary_expr sits at prec.left(0) so
    // these stay genuine GLR forks; the branch where no `-> ` follows dies,
    // mirroring parser/core.nx:157 pipe_starts_arm lookahead. Mixing `|` with
    // other binops (rare) associates loosely — ponytail: real code only uses flat
    // `a | b` (bytebuffer/protobuf/sysio flags).
    [$.binary_expr, $.throw_expr],
    [$.binary_expr, $.return_stmt],
    [$.binary_expr, $.assign_stmt],
    [$.binary_expr, $.let_pattern_stmt],
  ],

  rules: {
    source_file: ($) => repeat($._top_level),

    // ─── Comments ────────────────────────────────────────────────────────────

    line_comment: (_) => token(seq("//", /.*/)),

    // Block comment: lexer.nx:163-183 supports arbitrary-depth nesting via a
    // depth counter. tree-sitter regex can't recurse, so we accept one level
    // of nesting here. Deeper nesting (`/* /* /* */ */ */`) requires an
    // external scanner — TODO if real source ever uses it.
    block_comment: (_) =>
      token(seq(
        "/*",
        repeat(choice(
          /[^*/]/,
          seq("/", /[^*]/),
          seq("*", /[^/]/),
          seq("/", "*", repeat(choice(/[^*]/, seq("*", /[^/]/))), "*/")
        )),
        "*/"
      )),

    // ─── Identifiers ─────────────────────────────────────────────────────────

    // Lowercase/underscore-start: variables, function names, labels, keywords
    identifier: (_) => /[a-z_][a-zA-Z0-9_]*/,

    // Uppercase-start: constructor names, type names, exception names, type vars
    uident: (_) => /[A-Z][a-zA-Z0-9_]*/,

    // ─── Top-level definitions ───────────────────────────────────────────────

    // Comments are in `extras` so they're already legal anywhere between
    // tokens — listing them here too made them eagerly close any partial
    // top-level form (e.g. a multi-variant `type` def with interior
    // comments).
    _top_level: ($) =>
      choice(
        $.type_def,
        $.exception_def,
        $.import_def,
        $.cap_def,
        $.external_def,
        $.exception_group_def,
        $.let_def
      ),

    // [pub] [opaque] type Name[<T>] = { field: type, ... }
    // [pub] [opaque] type Name[<T>] = A(label: T) | B
    type_def: ($) =>
      seq(
        optional("export"),
        optional("opaque"),
        "type",
        field("name", $.uident),
        optional(field("type_params", $.type_params)),
        "=",
        field("body", choice($.record_type, $.type_sum_def))
      ),

    // A(label: T) | B(U)
    type_sum_def: ($) => sep1("|", $.variant_def),

    variant_def: ($) =>
      seq(
        field("name", $.uident),
        optional(seq("(", commaSep1($.variant_field), ")"))
      ),

    // type | label: type   — labeled form is greedy so `name: T` does not
    // misparse as bare-type `name` (lowercase identifier now matches a generic
    // TyVar in _type) followed by stray `: T`.
    variant_field: ($) =>
      choice(
        prec(1, seq(field("label", $.identifier), ":", field("type", $._type))),
        field("type", $._type)
      ),

    // [pub] exception NotFound(msg: string)
    exception_def: ($) =>
      seq(
        optional("export"),
        "exception",
        field("name", $.uident),
        optional(seq("(", commaSep1($.variant_field), ")"))
      ),

    // [export] exception group Name = A | B | C
    exception_group_def: ($) =>
      seq(
        optional("export"),
        "exception",
        "group",
        field("name", $.uident),
        "=",
        sep1("|", field("member", $.uident))
      ),

    // import external "path/to/lib.wasm"
    // import { a, b } from "path/to/mod.nx"
    // import { a, b }, * as alias from "path/to/mod.nx"
    // import * as alias from "path/to/mod.nx"
    // import as alias from "path/to/mod.nx"   — bare alias (parse_topdef.nx:183)
    // import from "path/to/mod.nx"            — no items / no alias (parse_topdef.nx:196)
    import_def: ($) =>
      seq(
        "import",
        choice(
          seq("external", field("path", $.import_path)),
          seq(
            "{",
            field("items", commaSep1($.import_item)),
            "}",
            ",",
            "*",
            "as",
            field("alias", $.identifier),
            "from",
            field("path", $.import_path)
          ),
          seq(
            "{",
            field("items", commaSep1($.import_item)),
            "}",
            "from",
            field("path", $.import_path)
          ),
          seq(
            "*",
            "as",
            field("alias", $.identifier),
            "from",
            field("path", $.import_path)
          ),
          seq(
            "as",
            field("alias", $.identifier),
            "from",
            field("path", $.import_path)
          ),
          seq("from", field("path", $.import_path))
        )
      ),

    // Import item: name or Name, optionally renamed with `as`
    import_item: ($) =>
      seq(
        field("name", choice($.identifier, $.uident)),
        optional(seq("as", field("alias", $.identifier)))
      ),

    // Import path: quoted string. Three forms are accepted:
    //   "std:stdio"         — package-qualified (resolves via PackageResolver)
    //   "pkg:path/module"   — third-party package
    //   "examples/foo.nx"   — bare relative path
    import_path: ($) => $.string_literal,

    // [export] cap Name do fn sig ... end
    cap_def: ($) =>
      seq(
        optional("export"),
        "cap",
        field("name", $.uident),
        "do",
        repeat($.fn_signature),
        "end"
      ),

    fn_signature: ($) =>
      seq(
        "fn",
        field("name", $.identifier),
        field("params", $.param_list),
        "->",
        field("ret_type", $._type),
        optional(seq("require", field("requires", $._effect_type))),
        optional(seq("throws", field("throws", $._effect_type)))
      ),

    // fn name[<T>](params) -> ret [require req] [throws eff] [with @ kont] do body end
    // The `with @ kont` clause names the continuation captured by this handler
    // arm; without it the arm has no first-class continuation. See
    // parse_optional_with_kont in src/frontend/parser.nx.
    handler_fn: ($) =>
      seq(
        "fn",
        field("name", $.identifier),
        optional(field("type_params", $.type_params)),
        field("params", $.param_list),
        "->",
        field("ret_type", $._type),
        optional(seq("require", field("requires", $._effect_type))),
        optional(seq("throws", field("throws", $._effect_type))),
        optional(seq("with", "@", field("kont", $.identifier))),
        "do",
        field("body", repeat($._stmt)),
        "end"
      ),

    // [pub] let name [: type] = expr
    // Top-level let bindings are sigil-free — parse_global_let in
    // src/frontend/parser.nx expects an identifier immediately after
    // `let`. Sigil-prefixed forms (`%x`, `~x`, `@x`) and pattern
    // destructure (`let Foo(v) = e`) appear only at statement scope
    // (let_stmt / let_pattern_stmt).
    let_def: ($) =>
      seq(
        optional("export"),
        "let",
        field("name", $.identifier),
        optional(seq(":", field("type", $._type))),
        "=",
        field("value", $._expr)
      ),

    // ─── Parameters ──────────────────────────────────────────────────────────

    // Type params accept BOTH uppercase and lowercase names
    // (parse_params.nx:107 admits TkUident | TkIdent — `fn <a>(x: a) -> a`
    // is a canonical generic shape).
    type_params: ($) =>
      seq("<", commaSep1(choice($.uident, $.identifier)), ">"),

    param_list: ($) => seq("(", commaSep($.param), ")"),

    param: ($) =>
      seq(
        optional(field("sigil", $.sigil)),
        field("name", $.identifier),
        ":",
        field("type", $._type)
      ),

    // ~ = mutable, % = linear, & = borrow, (none) = immutable
    sigil: (_) => choice("~", "%", "&", "@"),

    // ─── Types ───────────────────────────────────────────────────────────────

    _type: ($) =>
      choice(
        $.arrow_type,
        $.generic_type,
        $.primitive_type,
        $.ref_type,
        $.borrow_type,
        $.linear_type,
        $.record_type,
        $.list_type,
        $.array_type,
        $.row_type,
        $.lazy_type,
        $.handler_type,
        $.paren_type,
        $._type_path, // bare or qualified user-defined monotype / TyVar
        // Lowercase generic — parse_type.nx:212 resolves primitives first, then
        // accepts the identifier as a type variable (`fn <a>(x: a) -> a`).
        alias($.identifier, $.type_identifier)
      ),

    // (T)  — parenthesised type. Disambiguated from arrow_type by lookahead:
    // arrow_type starts with `(` then has labeled params (`label:`) or `)`
    // followed by `->`; paren_type holds a bare `_type`. parse_type.nx:245.
    // Lower prec than lazy_type's `@(T require/throws)` long form so
    // `@(T)` is read as lazy(T) not lazy(paren(T)).
    paren_type: ($) => prec(-1, seq("(", $._type, ")")),

    primitive_type: (_) =>
      choice("i32", "i64", "f32", "f64", "float", "bool", "string", "char", "unit"),

    // ref(T)
    ref_type: ($) => seq("ref", "(", field("inner", $._type), ")"),

    // &T
    borrow_type: ($) => seq("&", field("inner", $._type)),

    // %T
    linear_type: ($) => seq("%", field("inner", $._type)),

    // @T  — sugar for `@(T ; {} ; {})`
    // @(T [require ROW] [throws ROW]) — paren long form with deferred effect rows
    // (parse_type.nx:281-307).
    lazy_type: ($) =>
      seq(
        "@",
        choice(
          field("inner", $._type),
          seq(
            "(",
            field("inner", $._type),
            optional(seq("require", field("require", $._effect_type))),
            optional(seq("throws", field("throws", $._effect_type))),
            ")"
          )
        )
      ),

    // handler HandlerName — a nominal handler type (parse_type.nx:308-310)
    handler_type: ($) => seq("handler", field("name", $.uident)),

    // { x: T, y: U }
    record_type: ($) => seq("{", commaSep1($.record_type_field), "}"),

    record_type_field: ($) =>
      seq(field("name", $.identifier), ":", field("type", $._type)),

    // { E1, E2 | r }  or  { E1, E2 }
    row_type: ($) =>
      seq(
        "{",
        commaSep1($._type),
        optional(seq("|", field("tail", $._type))),
        "}"
      ),

    // [T]
    list_type: ($) => seq("[", field("element", $._type), "]"),

    // [| T |]
    array_type: ($) =>
      seq(
        alias(token("[|"), "[|"),
        field("element", $._type),
        alias(token("|]"), "|]")
      ),

    // Name<T, U>  or  Result<T, E>  or  map.Map<K, V>  or  mod.sub.Name<T>
    // The base may be module-qualified — parse_type.nx:28 consumes a dotted
    // tail of mixed-case segments before looking for `<`.
    generic_type: ($) =>
      seq(
        field("base", $._type_path),
        "<",
        field("args", commaSep1($._type)),
        ">"
      ),

    // Qualified type-atom name: `Name`, `Mod.Name`, `mod.Name`, `a.b.C`.
    _type_path: ($) =>
      choice(
        alias($.uident, $.type_identifier),
        seq(
          sep1(".", choice($.identifier, $.uident)),
          ".",
          alias($.uident, $.type_identifier)
        )
      ),

    // (label: T, ...) -> ret [require req] [throws eff]
    // prec.right makes the optional require/throws clauses greedy
    arrow_type: ($) =>
      prec.right(
        seq(
          "(",
          commaSep(
            choice(
              seq(
                field("param_label", $.identifier),
                ":",
                field("param_type", $._type)
              ),
              field("param_type", $._type)
            )
          ),
          ")",
          "->",
          field("ret", $._type),
          optional(seq("require", field("require", $._effect_type))),
          optional(seq("throws", field("throws", $._effect_type)))
        )
      ),

    _effect_type: ($) =>
      choice(
        $.row_type,
        $.generic_type,
        alias($.uident, $.type_identifier)
      ),

    // ─── Statements ──────────────────────────────────────────────────────────

    _stmt: ($) =>
      choice(
        $.let_stmt,
        $.return_stmt,
        $.assign_stmt,
        $.let_pattern_stmt,
        $.if_stmt,
        $.if_let_stmt,
        $.match_stmt,
        $.while_stmt,
        $.for_stmt,
        $.try_stmt,
        $.inject_stmt,
        $.line_comment,
        $.block_comment,
        $.expr_stmt
      ),

    // let [sigil] name [: type] = expr
    let_stmt: ($) =>
      prec(1, seq(
        "let",
        optional(field("sigil", $.sigil)),
        field("name", $.identifier),
        optional(seq(":", field("type", $._type))),
        "=",
        field("value", $._expr)
      )),

    return_stmt: ($) => seq("return", field("value", $._expr)),

    // target <- value
    assign_stmt: ($) =>
      seq(field("target", $._expr), "<-", field("value", $._expr)),

    // if cond then stmts [else stmts | else if... | else if let...] end
    // `else if` is a chain: the inner `if` consumes the trailing `end`, so the
    // outer form has a single terminal `end` (no nested `end end`).
    if_stmt: ($) =>
      seq(
        "if",
        field("cond", $._expr),
        "then",
        field("then_branch", repeat($._stmt)),
        choice(
          seq("else", field("else_branch", $.if_stmt)),
          seq("else", field("else_branch", $.if_let_stmt)),
          seq("else", field("else_branch", repeat($._stmt)), "end"),
          "end"
        )
      ),

    // if let pattern = expr then stmts [else stmts | else if... | else if let...] end
    if_let_stmt: ($) =>
      seq(
        "if",
        "let",
        field("pattern", $._pattern),
        "=",
        field("target", $._expr),
        "then",
        field("then_branch", repeat($._stmt)),
        choice(
          seq("else", field("else_branch", $.if_stmt)),
          seq("else", field("else_branch", $.if_let_stmt)),
          seq("else", field("else_branch", repeat($._stmt)), "end"),
          "end"
        )
      ),

    // match expr do | pat -> stmts ... end
    // Higher prec than match_expr — when arm body is `return ...` / `let ...`
    // / etc the stmt form is the only valid parse, but tree-sitter LR cannot
    // always look that far ahead. Force stmt-form by default.
    match_stmt: ($) =>
      prec(1, seq(
        "match",
        field("target", $._expr),
        "do",
        repeat($.match_case),
        "end"
      )),

    match_case: ($) =>
      prec.dynamic(2, seq(
        "|",
        field("pattern", $._pattern_or),
        "->",
        field("body", repeat($._stmt))
      )),

    // while cond do stmts end
    while_stmt: ($) =>
      seq(
        "while",
        field("cond", $._expr),
        "do",
        field("body", repeat($._stmt)),
        "end"
      ),

    // for var = start to end do stmts end
    for_stmt: ($) =>
      seq(
        "for",
        field("var", $.identifier),
        "=",
        field("start", $._expr),
        "to",
        field("end", $._expr),
        "do",
        field("body", repeat($._stmt)),
        "end"
      ),

    // try stmts catch param -> stmts end
    // try stmts catch | pat -> stmts ... end
    try_stmt: ($) =>
      seq(
        "try",
        field("body", repeat($._stmt)),
        "catch",
        choice(
          // Bare: catch param -> body
          seq(
            field("catch_param", $.identifier),
            "->",
            field("catch_body", repeat($._stmt))
          ),
          // Multi-arm: catch | pat -> body ... end
          field("catch_arms", repeat1($.catch_arm))
        ),
        "end"
      ),

    catch_arm: ($) =>
      prec.dynamic(2, seq(
        "|",
        field("pattern", $._pattern_or),
        "->",
        field("body", repeat($._stmt))
      )),

    // inject handler1, mod.handler2 do stmts end
    inject_stmt: ($) =>
      seq(
        "inject",
        sep1(",", field("handler", $.inject_handler)),
        "do",
        field("body", repeat($._stmt)),
        "end"
      ),

    // handler name in inject: plain `name` or dotted `mod.name`
    inject_handler: ($) =>
      seq(
        $.identifier,
        optional(seq(".", $.identifier))
      ),

    // let pattern = expr  (destructuring)
    let_pattern_stmt: ($) =>
      seq(
        "let",
        field("pattern", $._pattern),
        "=",
        field("value", $._expr)
      ),

    // expr_stmt is the last-resort stmt form. Lower prec than the explicit
    // block stmt forms (match_stmt/if_stmt/while_stmt/for_stmt/try_stmt) so
    // `match/if/while/for/try` blocks consistently take the stmt-form
    // interpretation when their bodies contain stmt-only constructs
    // (return, let, assignment, ...).
    expr_stmt: ($) => prec(-1, $._expr),

    // ─── Expressions ─────────────────────────────────────────────────────────

    _expr: ($) => choice($.binary_expr, $.unary_expr, $._postfix_expr),

    // Prefix unary: -, -., !  — right-associative, binds tighter than every
    // infix binary operator (prec 1-6) and looser than postfix `.field` /
    // `[idx]` (prec 10). See parse_unary_expr in src/frontend/parser.nx
    // (nexus-4f42). Negative integer / float literals are also recognised
    // at token level by integer_literal / float_literal — both shapes
    // ultimately denote the same value.
    unary_expr: ($) =>
      prec.right(
        7,
        seq(
          field("operator", choice("-", "-.", "!")),
          field("operand", choice($.unary_expr, $._postfix_expr))
        )
      ),

    // Binary operators with precedence levels (low → high)
    // 1: ||  2: &&  3: comparison  4: additive  5: multiplicative
    binary_expr: ($) =>
      choice(
        // Logical OR (lowest precedence)
        prec.left(
          1,
          seq(
            field("left", $._expr),
            field("operator", "||"),
            field("right", $._expr)
          )
        ),
        // Logical AND
        prec.left(
          2,
          seq(
            field("left", $._expr),
            field("operator", "&&"),
            field("right", $._expr)
          )
        ),
        // Float comparisons (must come before int comparisons to avoid partial matches)
        prec.left(
          3,
          seq(
            field("left", $._expr),
            field("operator", choice("==.", "!=.", "<=.", ">=.", "<.", ">.")),
            field("right", $._expr)
          )
        ),
        // Int/generic comparisons
        prec.left(
          3,
          seq(
            field("left", $._expr),
            field("operator", choice("==", "!=", "<=", ">=", "<", ">")),
            field("right", $._expr)
          )
        ),
        // :: cons (right-associative, same precedence as additive)
        prec.right(
          4,
          seq(
            field("left", $._expr),
            field("operator", "::"),
            field("right", $._expr)
          )
        ),
        // Float additive
        prec.left(
          4,
          seq(
            field("left", $._expr),
            field("operator", choice("+.", "-.")),
            field("right", $._expr)
          )
        ),
        // Int/string additive (++ = string concat)
        prec.left(
          4,
          seq(
            field("left", $._expr),
            field("operator", choice("++", "+", "-")),
            field("right", $._expr)
          )
        ),
        // Float multiplicative
        prec.left(
          5,
          seq(
            field("left", $._expr),
            field("operator", choice("*.", "/.")),
            field("right", $._expr)
          )
        ),
        // Int multiplicative + modulo
        prec.left(
          5,
          seq(
            field("left", $._expr),
            field("operator", choice("*", "/", "%")),
            field("right", $._expr)
          )
        ),
        // Bitwise XOR (same precedence as additive)
        prec.left(
          4,
          seq(
            field("left", $._expr),
            field("operator", "^"),
            field("right", $._expr)
          )
        ),
        // Bitwise OR (same precedence as additive; parser util.nx:406).
        // dynamic(1) < match_case/catch_arm dynamic(2): at an arm-body boundary
        // GLR keeps both and the arm separator wins; a real `a | b` with no
        // following `-> ` only has the binary parse, so it still works.
        prec.left(0, seq(
              field("left", $._expr),
              field("operator", "|"),
              field("right", $._expr)
            )),
        // Bitwise AND (same precedence as multiplicative)
        prec.left(
          5,
          seq(
            field("left", $._expr),
            field("operator", "&"),
            field("right", $._expr)
          )
        ),
        // Bit shift (highest precedence)
        prec.left(
          6,
          seq(
            field("left", $._expr),
            field("operator", choice("<<", ">>")),
            field("right", $._expr)
          )
        )
      ),

    _postfix_expr: ($) =>
      choice($.field_access, $.index_expr, $._atom_expr),

    // expr.field  (highest precedence postfix)
    field_access: ($) =>
      prec.left(
        10,
        seq(
          field("object", $._postfix_expr),
          ".",
          field("field", $.identifier)
        )
      ),

    // expr[index]
    index_expr: ($) =>
      prec.left(
        10,
        seq(
          field("object", $._postfix_expr),
          "[",
          field("index", $._expr),
          "]"
        )
      ),

    // Block-style forms (if/match/while/for/try) are represented by their
    // stmt-form rules and used in both stmt and expression positions — the
    // parser at runtime (parser/core.nx:251-254) treats them as expression
    // atoms unconditionally. Including the stmt forms here keeps the grammar
    // single-rule per construct and avoids LR conflict between stmt-form and
    // expr-form variants with identical syntax.
    _atom_expr: ($) =>
      choice(
        $.paren_expr,
        $.if_stmt,
        $.if_let_stmt,
        $.match_stmt,
        $.while_stmt,
        $.for_stmt,
        $.try_stmt,
        $.throw_expr,
        $.borrow_expr,
        $.lambda_expr,
        $.handler_expr,
        $.call_expr,
        $.constructor_expr,
        $.record_expr,
        $.array_expr,
        $.linear_list_expr,
        $.list_expr,
        $.force_expr,
        $.literal,
        $.variable
      ),

    paren_expr: ($) => seq("(", $._expr, ")"),

    // @expr or @(expr)
    force_expr: ($) => seq("@", field("value", $._atom_expr)),

    // throw expr
    throw_expr: ($) => seq("throw", field("value", $._expr)),

    // & [sigil] name
    borrow_expr: ($) =>
      seq(
        "&",
        optional(field("sigil", $.sigil)),
        field("name", $.identifier)
      ),

    // fn [<T>](params) -> ret [require req] [throws eff] do body end
    lambda_expr: ($) =>
      prec.right(
        seq(
          "fn",
          optional(field("type_params", $.type_params)),
          field("params", $.param_list),
          "->",
          field("ret_type", $._type),
          optional(seq("require", field("requires", $._effect_type))),
          optional(seq("throws", field("throws", $._effect_type))),
          "do",
          field("body", repeat($._stmt)),
          "end"
        )
      ),

    // [pub] external name = [=[wasm_symbol]=] : [<T>] arrow_type
    external_def: ($) =>
      seq(
        optional("export"),
        "external",
        field("name", $.identifier),
        "=",
        field("wasm_name", $.string_literal),
        ":",
        optional(field("type_params", $.type_params)),
        field("type", $.arrow_type)
      ),

    // handler PortName [require { ... }] do handler_fn* end
    handler_expr: ($) =>
      seq(
        "handler",
        field("cap_name", $.uident),
        optional(seq("require", field("requires", $._effect_type))),
        "do",
        repeat($.handler_fn),
        "end"
      ),

    // path(label: value, ...)
    call_expr: ($) =>
      seq(
        field("func", $.dotted_identifier),
        "(",
        field("args", commaSep($.labeled_arg)),
        ")"
      ),

    // label: value
    //
    // Note: the language supports punning at call sites (`f(v)` desugars
    // to `f(v: v)`, `f(%v)` to `f(v: %v)`, etc. — see
    // ../docs/spec/syntax.md). The tree-sitter grammar does NOT yet
    // recognize the unlabeled forms because of an unresolved LR
    // ambiguity between `var (paren_expr)` and `call_expr(args)`.
    // Tools that use this grammar will currently parse `f(v)` as
    // `variable(f) + paren_expr(v)`. Constructor pattern punning works
    // (Foo(v)) because uident is a distinct token.
    // TODO: proper grammar-level call-arg punning support.
    labeled_arg: ($) =>
      seq(
        field("label", $.identifier),
        ":",
        field("value", $._expr)
      ),

    // [sigil] Constructor [(label: value, ...)]  — optional labels, UIDENT name.
    // Parens are optional. The `%` sigil makes a linear constructor (eg
    // `%MkPair(fst: 3, snd: 4)`); other sigils carry the same modality story
    // documented on constructor_pattern.
    constructor_expr: ($) =>
      prec.right(
        seq(
          optional(field("sigil", $.sigil)),
          field("name", $._ctor_path),
          optional(seq(
            "(",
            field("args", commaSep($.ctor_arg)),
            ")"
          ))
        )
      ),

    // Mixed-case dotted path that ends in a UIDENT, e.g. `Some`, `Mod.Ctor`,
    // `Mod.Sub.Ctor`, `a.b.Ctor`. See parse_pattern.nx:262 (try_qualified_ctor_pat).
    _ctor_path: ($) =>
      choice(
        $.uident,
        seq(
          sep1(".", choice($.identifier, $.uident)),
          ".",
          $.uident
        )
      ),

    // [ label ":" ] expr — both labeled and unlabeled (positional or pun) forms.
    ctor_arg: ($) =>
      choice(
        seq(field("label", $.identifier), ":", field("value", $._expr)),
        field("value", $._expr)
      ),

    // { field: value, ... }   or   { field, ~field, %field }  (punning)
    // Punning: `{ x }` desugars to `{ x: x }`, `{ ~y }` to `{ y: ~y }`, etc.
    // See parse_args.nx:35 for the sigil-aware punning paths.
    record_expr: ($) => seq("{", commaSep($.record_expr_field), "}"),

    record_expr_field: ($) =>
      choice(
        seq(field("name", $.identifier), ":", field("value", $._expr)),
        seq(
          optional(field("sigil", $.sigil)),
          field("name", $.identifier)
        )
      ),

    // [e1, e2, ...]  — trailing comma allowed per spec
    list_expr: ($) =>
      seq("[", field("elements", commaSep($._expr)), optional(","), "]"),

    // %[e1, e2, ...]  — linear list literal
    linear_list_expr: ($) =>
      seq("%", "[", field("elements", commaSep($._expr)), optional(","), "]"),

    // [| e1, e2, ... |]  — trailing comma allowed per spec
    array_expr: ($) =>
      seq(
        alias(token("[|"), "[|"),
        field("elements", commaSep($._expr)),
        optional(","),
        alias(token("|]"), "|]")
      ),

    // [sigil]name   e.g.  x  ~x  %x
    variable: ($) =>
      seq(
        optional(field("sigil", $.sigil)),
        field("name", $.identifier)
      ),

    // a.b.c or Logger.log — used as function path in calls
    // UIDENT-start requires at least one dot segment to avoid conflict with constructor_expr
    dotted_identifier: ($) =>
      choice(
        sep1(".", $.identifier),
        seq($.uident, ".", sep1(".", $.identifier))
      ),

    // ─── Literals ────────────────────────────────────────────────────────────

    literal: ($) =>
      choice(
        $.float_literal,
        $.integer_literal,
        $.boolean_literal,
        $.unit_literal,
        $.string_literal,
        $.char_literal
      ),

    // 'a', '\n', '\xNN', '\u{HHHH}', etc.
    char_literal: (_) =>
      token(seq("'", choice(/\\[0abtnvfre\\'"]/, /\\[0-7]{1,3}/, /\\x[0-9a-fA-F]{2}/, /\\u\{[0-9a-fA-F]+\}/, /[^'\\]/), "'")),

    // Must come before integer_literal to consume the decimal part.
    // Accepts: 3.14, 3.14e10, 3.14e-10, 1e10 (bare-int exponent → float).
    float_literal: (_) =>
      token(prec(2, /-?[0-9]+(\.[0-9]+([eE][+-]?[0-9]+)?|[eE][+-]?[0-9]+)/)),

    integer_literal: (_) => token(prec(1, /-?[0-9]+/)),

    boolean_literal: (_) => choice("true", "false"),

    // ()
    unit_literal: (_) => token("()"),

    // "..." or [=[ ... ]=]
    string_literal: (_) =>
      token(
        choice(
          // double-quoted string with escape sequences
          // Escapes mirror lexer.nx:389-537: \a \b \e \f \n \r \t \v \\ \" \'
          // plus \xNN (hex), \u{HHHH+} (unicode), \NNN (1-3 digit octal).
          seq(
            '"',
            repeat(choice(
              /\\[abefnrtv\\'"]/,
              /\\x[0-9a-fA-F]{2}/,
              /\\u\{[0-9a-fA-F]+\}/,
              /\\[0-7]{1,3}/,
              /[^"\\\n]/
            )),
            '"'
          ),
          // bracket string [=[ ... ]=]
          seq(
            "[=[",
            repeat(
              choice(
                seq("\\", "]=]"), // escape sequence: \]=] → ]=]
                seq("\\", /[^\]]/), // backslash + non-] character
                seq("\\", "]", /[^=]/), // \] not starting \]=]
                seq("\\", "]=", /[^\]]/), // \]= not completing \]=]
                seq("]", /[^=]/), // ] not starting ]=]
                seq("]=", /[^\]]/), // ]= not completing ]=]
                /[^\]\\]/ // any char except ] and \
              )
            ),
            "]=]"
          )
        )
      ),

    // ─── Patterns ────────────────────────────────────────────────────────────

    _pattern: ($) =>
      choice(
        $.cons_pattern,
        $.literal_pattern,
        $.constructor_pattern,
        $.list_pattern,
        $.record_pattern,
        $.wildcard_pattern,
        $.variable_pattern
      ),

    // p1 | p2 | ... | pn  — used at top of match/catch arms; cons binds tighter
    _pattern_or: ($) =>
      choice(
        $._pattern,
        $.or_pattern
      ),

    or_pattern: ($) =>
      prec.left(
        2,
        seq(
          field("alt", $._pattern),
          repeat1(seq("|", field("alt", $._pattern)))
        )
      ),

    // p1 :: p2  — right-associative cons pattern, desugars to Cons(v: p1, rest: p2)
    cons_pattern: ($) =>
      prec.right(
        4,
        seq(
          field("head", $._pattern),
          "::",
          field("tail", $._pattern)
        )
      ),

    // [p1, p2, ...]  — list pattern, desugars to nested Cons/Nil
    list_pattern: ($) =>
      seq("[", commaSep($._pattern), optional(","), "]"),

    literal_pattern: ($) => $.literal,

    // [sigil]name
    variable_pattern: ($) =>
      seq(
        optional(field("sigil", $.sigil)),
        field("name", $.identifier)
      ),

    // [sigil] [Module.]+Constructor [( [ label ":" ] pat, ... )] — optional
    // labels and optional parens; UIDENT name; module path may mix lowercase
    // and uppercase segments and end in any number of qualifiers, see
    // parse_pattern.nx:262 (try_qualified_ctor_pat).
    //
    // Sigil routes the constructor pattern onto the matching cell shape:
    //   ~Ctor(...) — ref-cell ctor pattern (mutable)
    //   %Ctor(...) — linear ctor pattern
    //   @Ctor(...) — lazy/thunk ctor pattern
    //   &Ctor(...) — borrow ctor pattern
    constructor_pattern: ($) =>
      prec.right(
        seq(
          optional(field("sigil", $.sigil)),
          field("name", $._ctor_path),
          optional(seq(
            "(",
            commaSep($.ctor_pat_arg),
            ")"
          ))
        )
      ),

    // [ label ":" ] pattern
    ctor_pat_arg: ($) =>
      choice(
        seq(field("label", $.identifier), ":", field("pattern", $._pattern)),
        field("pattern", $._pattern)
      ),

    // { field: pat, ..., _ }   or   { x, y, ~z }  (punning)
    // Punning: `{ x }` desugars to `{ x: x }` (variable-pattern binder), with
    // optional sigil per parse_pattern.nx:540 (try_pun_pat_field_with_closer).
    record_pattern: ($) =>
      seq(
        "{",
        commaSep(
          choice(
            field("wildcard", alias("_", $.wildcard_pattern)),
            seq(
              field("field_name", $.identifier),
              ":",
              field("field_pattern", $._pattern)
            ),
            seq(
              optional(field("sigil", $.sigil)),
              field("field_name", $.identifier)
            )
          )
        ),
        optional(","),
        "}"
      ),

    wildcard_pattern: (_) => "_",
  },
});
