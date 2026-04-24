# tree-sitter-grammar

Tree-sitter grammar for the [Nexus](https://github.com/nexus-llm-lang/Nexus) programming language.

## Usage

### Prerequisite

Install the `tree-sitter` CLI (e.g. `cargo install tree-sitter-cli`, `nix run nixpkgs#tree-sitter`, or via your package manager).

### Build

```sh
tree-sitter generate
tree-sitter test
```

### Highlight a file

Register this directory as a parser directory:

```sh
mkdir -p ~/.config/tree-sitter
cat > ~/.config/tree-sitter/config.json <<EOF
{ "parser-directories": ["$PWD/.."] }
EOF

tree-sitter highlight --html path/to/file.nx
```

The grammar exposes `highlights` and `locals` query sets under `queries/nexus/`.

## Editor integrations

Editors that follow the `tree-sitter-<lang>` convention (e.g. `nvim-treesitter`, Helix, Zed) can pick this grammar up by pointing their parser source at this repository.

## License

MIT — see [LICENSE](LICENSE).
